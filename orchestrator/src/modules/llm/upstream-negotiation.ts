import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { retryAfterMsFromHeaders } from './openwebui-api';

const logger = new Logger('UpstreamNegotiation');

// Upstream negotiation: everything about "make this call succeed on this model"
// that is NOT the call's own business logic. The OpenAI-compatible proxy in
// front of the models (Open WebUI -> LiteLLM -> Azure AI / OpenAI / Anthropic)
// rejects individual request parameters per model -- a required temperature,
// an unsupported seed or reasoning_effort, a response_format it cannot honour
// -- and each rejection used to be handled by its own hand-nested catch-chain
// inside chat(), streamChat() and vision(). Those chains drifted apart (a
// temperature retry that then hit a schema rejection rethrew instead of
// falling back, which reached prod as a terminal 400 on claude-opus-4-8).
// Here the classification and the retry policy live in one place; the three
// callers only describe how to build and send one attempt.

// Ollama version in use is not pinned anywhere in this codebase -- structured
// output (response_format: json_schema) support can't be statically
// guaranteed. Rather than hard-failing a job over a backend that doesn't
// support it, degrade once to a schema-less retry on the specific
// status codes an unsupported/malformed response_format would produce.
export function isSchemaRejection(err: unknown): boolean {
  return err instanceof OpenAI.APIError && (err.status === 400 || err.status === 422);
}

/** Carries an upstream HTTP status so the controller can propagate it instead of collapsing to a generic 500. */
export class UpstreamHttpError extends Error {
  constructor(
    public readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamHttpError';
  }
}

// LiteLLM surfaces unsupported-param rejections as a 400 with a body like:
//   "azure_ai does not support parameters: ['seed']"
//   "azure does not support parameters: ['reasoning_effort']"
//   "UnsupportedParamsError"
// Returns the set of rejected param names so callers can strip exactly the
// offending params and retry once, rather than hard-failing the whole request.
export function parseUnsupportedParams(err: unknown): Set<string> {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return new Set();
  const params = new Set<string>();
  // Primary LiteLLM format: "does not support parameters: ['seed', 'reasoning_effort']"
  const bracketMatch = err.message.match(/does not support parameters:\s*\[([^\]]+)\]/i);
  if (bracketMatch) {
    for (const raw of bracketMatch[1].split(',')) {
      params.add(raw.trim().replace(/['"]/g, ''));
    }
    return params;
  }
  // OpenAI/Azure: "Unknown parameter: 'options'." / "Unrecognized request argument supplied: options"
  const unknownMatch =
    err.message.match(/unknown parameter[^'"\w]*['"]?([A-Za-z_]\w*)/i) ??
    err.message.match(/unrecognized request argument supplied:\s*['"]?([A-Za-z_]\w*)/i);
  if (unknownMatch) {
    params.add(unknownMatch[1]);
    return params;
  }
  // Fallback: generic UnsupportedParamsError -- scan for known param names in the message
  if (err.message.includes('UnsupportedParamsError') || err.message.toLowerCase().includes('unsupported')) {
    if (err.message.includes('seed')) params.add('seed');
    if (err.message.includes('reasoning_effort')) params.add('reasoning_effort');
    if (err.message.includes('temperature')) params.add('temperature');
    if (err.message.includes('frequency_penalty')) params.add('frequency_penalty');
    if (err.message.includes('presence_penalty')) params.add('presence_penalty');
    if (err.message.includes('top_p')) params.add('top_p');
  }
  return params;
}

// Detects temperature *value* constraint errors — distinct from "unsupported
// parameter" errors that parseUnsupportedParams handles. Returns the required
// temperature, or null when the error is not a value constraint.
// Example: Anthropic via LiteLLM for claude-opus-4-8 with extended thinking →
//   "temperature: 0 should be >= 1 and <= 1"
// Extracting the required value from the error avoids a static model→temperature
// map and works for any model that surfaces the constraint the same way.
export function parseTemperatureConstraint(err: unknown): number | null {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return null;
  // "temperature: 0 should be >= 1 and <= 1" (exact range → single allowed value)
  const rangeMatch = err.message.match(/temperature.*?>=\s*(\d+(?:\.\d+)?)\s*and\s*<=\s*(\d+(?:\.\d+)?)/i);
  if (rangeMatch && rangeMatch[1] === rangeMatch[2]) return parseFloat(rangeMatch[1]);
  // "temperature must be 1" / "only allows temperature=1"
  const mustMatch = err.message.match(/temperature\s*(?:must be|only allows?)\s*=?\s*(\d+(?:\.\d+)?)/i);
  if (mustMatch) return parseFloat(mustMatch[1]);
  // Unified "only <value> is (the required one)" wording -- deliberately NOT
  // anchored to a fixed word order, since two real wordings have been
  // confirmed live with the required value in different positions relative
  // to "does not support"/"temperature":
  //   Azure/LiteLLM (OpenAI/gpt-5.5): "'temperature' does not support 0 with
  //     this model. Only the default (1) value is supported."
  //   LiteLLM UnsupportedParamsError (claude-opus-4-8): "claude-opus-4-8
  //     does not support temperature=0. Only temperature=1 is supported."
  // Guarded on the message mentioning "temperature" at all, so this can't
  // misfire on an unrelated parameter's similarly-worded value constraint.
  // Checked BEFORE parseUnsupportedParams at every call site specifically
  // because the second wording above also contains "UnsupportedParamsError"
  // + "temperature", which would otherwise let parseUnsupportedParams's own
  // loose substring fallback claim it first -- and that retry path has no
  // mechanism to adjust temperature, only to drop seed/reasoning_effort, so
  // it would silently resend the identical rejected value forever.
  if (/temperature/i.test(err.message)) {
    const requiredValueMatch = err.message.match(
      /(?:only(?: the default)?|must be)\D{0,20}\(?(\d+(?:\.\d+)?)\)?(?:\s*value)?\s*is\s*(?:supported|allowed)/i,
    );
    if (requiredValueMatch) return parseFloat(requiredValueMatch[1]);
  }
  return null;
}

// --- Token-limit, tool and reasoning negotiation -------------------------------------------------
// Newer reasoning models (the GPT-5/GPT-6 lines on Azure OpenAI) take `max_completion_tokens` instead of
// `max_tokens`, have output ceilings below what a caller asks for, and (gpt-5.6) refuse function tools on
// Chat Completions unless reasoning is off. LiteLLM decides which of these apply by matching the deployment
// NAME, so an alias (`gpt-chat-latest`) or a model newer than the proxy release (`gpt-6-*` on an old
// LiteLLM) is passed through unchanged and the provider rejects it. The wordings below are the ones the
// vendors document; each parser is deliberately tolerant about the exact phrasing and returns a plain value.

function badRequestMessage(err: unknown): string | null {
  return err instanceof OpenAI.APIError && err.status === 400 ? err.message : null;
}

/**
 * True when the upstream says `max_tokens` is not accepted by this model and `max_completion_tokens` is the
 * parameter to use. Azure: "Unsupported parameter: 'max_tokens' is not supported with this model. Use
 * 'max_completion_tokens' instead."; LiteLLM: "... does not support parameters: ['max_tokens']".
 */
export function parseMaxTokensUnsupported(err: unknown): boolean {
  const message = badRequestMessage(err);
  if (!message) return false;
  if (/max_completion_tokens/i.test(message) && /max_tokens/i.test(message) && /(not supported|unsupported|\buse\b)/i.test(message)) {
    return true;
  }
  if (/['"`]?max_tokens['"`]?\s+is\s+not\s+supported/i.test(message)) return true;
  const bracket = message.match(/does not support parameters:\s*\[([^\]]+)\]/i);
  return bracket !== null && /max_tokens/.test(bracket[1]);
}

/**
 * The output-token ceiling an upstream states when a request asked for more, or null. OpenAI/Azure: "max_tokens
 * is too large: 200000. This model supports at most 16384 completion tokens, whereas you provided 200000.";
 * Anthropic: "max_tokens: 20000 > 8192, which is the maximum allowed number of output tokens for ...".
 */
export function parseMaxOutputCap(err: unknown): number | null {
  const message = badRequestMessage(err);
  if (!message) return null;
  const patterns = [
    /supports at most (\d[\d,]*) (?:completion |output )?tokens/i,
    /max_tokens:\s*\d[\d,]*\s*>\s*(\d[\d,]*)/i,
    /(?:max_tokens|max_completion_tokens)[^.\n]{0,80}?(?:less than or equal to|at most|no more than|maximum (?:allowed )?(?:value )?(?:is|of))\s*:?\s*(\d[\d,]*)/i,
    /maximum (?:allowed )?(?:number of )?(?:output |completion )?tokens (?:is|of|for this model is)\s*(\d[\d,]*)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const value = parseInt(match[1].replace(/,/g, ''), 10);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

/** Tokens kept free when the answer limit is derived from the context window (the error states exact counts). */
const CONTEXT_MARGIN_TOKENS = 32;

/**
 * The answer limit that fits when the request was refused because input plus output exceeded the model's context
 * window, or null. OpenAI/Azure: "This model's maximum context length is 131072 tokens. However, you requested 131146
 * tokens (74 in the messages, 131072 in the completion). Please reduce the length of the messages or completion." (the
 * older wording says "your messages resulted in 74 tokens"). A model whose output ceiling equals its context window
 * (gpt-oss-120b) cannot be asked for the ceiling plus any input.
 */
export function parseContextLengthCap(err: unknown): number | null {
  const message = badRequestMessage(err);
  if (!message) return null;
  // "maximum context length is N tokens" (OpenAI/Azure) or "the model's maximum context length of N tokens" (vLLM-style,
  // gpt-oss-120b: "Requested token count exceeds the model's maximum context length of 131072 tokens. You requested a
  // total of 131146 tokens: 74 tokens from the input messages and 131072 tokens for the completion.").
  const context = message.match(/maximum context length (?:is|of) (\d[\d,]*) tokens/i);
  if (!context) return null;
  const input =
    message.match(/\((\d[\d,]*) (?:tokens )?in the (?:messages|prompt)/i) ??
    message.match(/your (?:messages|prompt) resulted in (\d[\d,]*) tokens/i) ??
    message.match(/(\d[\d,]*) tokens? from the (?:input|prompt)(?: messages)?/i);
  if (!input) return null;
  const cap = parseInt(context[1].replace(/,/g, ''), 10) - parseInt(input[1].replace(/,/g, ''), 10) - CONTEXT_MARGIN_TOKENS;
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * gpt-5.6 on Chat Completions: "Function tools with reasoning_effort are not supported for gpt-5.6-sol in
 * /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." It is
 * returned even when no reasoning_effort was sent, because the model defaults to medium.
 */
export function isToolsWithReasoningRejection(err: unknown): boolean {
  const message = badRequestMessage(err);
  if (!message) return false;
  return (
    /function tools with reasoning_effort (?:are|is) not supported/i.test(message) ||
    (/tools/i.test(message) && /reasoning_effort/i.test(message) && /not supported/i.test(message) && /['"]none['"]/i.test(message))
  );
}

/**
 * A 2xx answer with no content because the model spent the whole output budget on hidden reasoning
 * (`finish_reason: length`; gpt-5-mini/nano at 50 tokens, vision at 300). Thrown by a caller's attempt so the
 * loop retries once with a larger budget; `target` is that budget.
 */
export class EmptyLengthCompletion extends Error {
  constructor(public readonly target: number) {
    super(`Upstream returned no content at the output limit (retrying with a limit of ${target})`);
    this.name = 'EmptyLengthCompletion';
  }
}

/** Hard ceiling for a raised budget when the model's own output ceiling is unknown. */
export const RAISED_BUDGET_CEILING = 64_000;

/** The output limit to send under this adaptation: raised floor first, then the model's learned ceiling. */
export function effectiveMaxTokens(requested: number | undefined, adaptation: Adaptation): number | undefined {
  if (requested === undefined || adaptation.omitTokenLimit) return undefined;
  let value = Math.max(requested, adaptation.maxTokensFloor ?? 0);
  if (adaptation.maxTokensCap !== undefined) value = Math.min(value, adaptation.maxTokensCap);
  return value;
}

/** The budget to retry with after an empty length-truncated answer, or null when raising cannot help. */
export function raisedBudgetFor(sent: number | undefined, adaptation: Adaptation): number | null {
  // Once per model: a floor is already in force (learned earlier, or raised on this call), so a second empty
  // answer is a result, not a reason to keep spending.
  if (sent === undefined || adaptation.omitTokenLimit || adaptation.maxTokensFloor !== undefined) return null;
  const ceiling = adaptation.maxTokensCap ?? RAISED_BUDGET_CEILING;
  const target = Math.min(Math.max(sent * 4, 4_000), ceiling);
  return target > sent ? target : null;
}

/** Longest stretch of an upstream error message that is ever logged. */
const LOGGED_ERROR_CHARS = 300;

/**
 * An identifier the upstream attached to its answer, for matching a failure to the proxy's own log when the body is
 * empty (LiteLLM's call id, or a generic request id). Undefined when there is none.
 */
export function upstreamRequestId(err: unknown): string | undefined {
  if (!(err instanceof OpenAI.APIError)) return undefined;
  const headers = (err.headers ?? {}) as Record<string, string | null | undefined>;
  const id = err.request_id ?? headers['x-litellm-call-id'] ?? headers['x-request-id'];
  return id ? String(id).slice(0, 80) : undefined;
}

/**
 * What to log about a failed upstream call: its HTTP status (or the kind of failure when there is none) and the
 * vendor's error text collapsed to one line and cut to 300 characters. The text is the upstream's own error, never
 * the request, so it carries no document content.
 */
export function summarizeUpstreamError(err: unknown): { status: string; message: string } {
  let status = 'none';
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof OpenAI.APIError) {
    status = err.status != null ? String(err.status) : 'none';
  } else if (err instanceof UpstreamHttpError) {
    status = String(err.upstreamStatus);
  } else if (err instanceof Error) {
    status = err.name;
  }
  message = message.replace(/\s+/g, ' ').trim();
  if (message.length > LOGGED_ERROR_CHARS) message = `${message.slice(0, LOGGED_ERROR_CHARS)}...`;
  return { status, message };
}

// Normalises an OpenAI.APIError into UpstreamHttpError so the HTTP controller
// can forward the upstream status code without importing the OpenAI SDK itself.
// Any other thrown value is re-thrown unchanged.
export function rethrowAsUpstream(err: unknown): never {
  if (err instanceof OpenAI.APIError && err.status != null) {
    throw new UpstreamHttpError(err.status, err.message);
  }
  throw err;
}

/** What the attempt loop has decided to change about the next attempt. */
export interface Adaptation {
  /** A temperature the upstream demanded; overrides whatever the caller asked for. */
  temperature: number | undefined;
  /** Parameter names to leave out of the request. */
  dropped: Set<string>;
  /** Send the request without its response_format schema. */
  dropSchema: boolean;
  /** Which output-limit parameter the model accepts. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Send no output limit at all (the model refused both parameters, e.g. a proxy that turns one into the other). */
  omitTokenLimit: boolean;
  /** The model's stated output ceiling; a requested limit is clamped to it. */
  maxTokensCap: number | undefined;
  /** An output limit raised after an empty, length-truncated answer; used as a floor for later calls. */
  maxTokensFloor: number | undefined;
  /** Send `reasoning_effort: 'none'` (the model refused function tools while reasoning). */
  forceReasoningNone: boolean;
  /** 1 for the first attempt, 2 for the next, and so on. */
  attempt: number;
}

/** What is already known about a model, remembered across calls by the caller's client. */
export interface LearnedConstraints {
  temperature?: number;
  rejected: ReadonlySet<string>;
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  omitTokenLimit?: boolean;
  maxTokensCap?: number;
  maxTokensFloor?: number;
  forceReasoningNone?: boolean;
}

/** What one failure taught us, passed to `remember` so later calls start from it. */
export interface LearnedUpdate {
  temperature?: number;
  rejected?: Iterable<string>;
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  omitTokenLimit?: boolean;
  maxTokensCap?: number;
  maxTokensFloor?: number;
  forceReasoningNone?: boolean;
}

export interface NegotiationArgs<T> {
  /** Log prefix, e.g. `OpenWebUiClient.chat`. */
  label: string;
  model: string;
  /** Whether the request carries a response_format schema that can be dropped. */
  hasSchema: boolean;
  /** Size of the request text in characters, for the failure log (never its content). */
  requestChars?: number;
  /** Parameters this call is able to leave out when an upstream rejects them. */
  droppable: ReadonlySet<string>;
  learned?: LearnedConstraints;
  /** Called with what a failure taught us, so later calls start from it. */
  remember: (update: LearnedUpdate) => void;
  /** Whether the request carries tools (enables the "function tools need reasoning off" adaptation). */
  hasTools?: boolean;
  /** Builds and sends ONE attempt under the given adaptation. */
  send: (adaptation: Adaptation) => Promise<T>;
  /** How a failure that cannot be adapted around leaves the loop. Defaults to rethrowAsUpstream. */
  terminal?: (err: unknown) => never;
  /** Hard cap on attempts, including the first. Default 6 (adaptations accumulate across attempts). */
  maxAttempts?: number;
  /** Waits before a rate-limited call is repeated; tests replace it so they do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Longest a rate-limited call waits for the provider's Retry-After before it is repeated. */
export const RATE_LIMIT_MAX_WAIT_MS = 20_000;
/** Used when a 429 states no Retry-After. */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 2_000;
/** A rate-limited call is repeated at most this many times (the first attempt not counted). */
export const RATE_LIMIT_RETRIES = 2;

/** How long to wait before repeating a call the upstream answered with 429, or null when the error is not a 429. */
export function rateLimitWaitMs(err: unknown): number | null {
  if (!(err instanceof OpenAI.APIError) || err.status !== 429) return null;
  const headers = (err.headers ?? {}) as Record<string, string | null | undefined>;
  const stated = retryAfterMsFromHeaders(headers);
  return Math.min(stated ?? RATE_LIMIT_DEFAULT_WAIT_MS, RATE_LIMIT_MAX_WAIT_MS);
}

/**
 * Sends a request, adapting to what the upstream tells us and retrying, within a hard attempt cap.
 * Each failure is classified once and can change the next attempt in one of three ways, in this order:
 *   1. a temperature the model requires        -> send that temperature
 *   2. parameters it does not support          -> leave out those this call can drop
 *   3. a response_format schema it rejected    -> send without the schema
 * Adaptations accumulate, so a temperature fix followed by a schema rejection ends in a working
 * schema-less call (the chain that failed in prod). Temperature and dropped parameters are remembered
 * through `remember`; a schema rejection is deliberately NOT: whether a schema is accepted depends on
 * its size and shape, not only on the model. Anything that does not match, or that repeats an
 * adaptation already applied, leaves through `terminal`.
 */
export async function negotiate<T>(args: NegotiationArgs<T>): Promise<T> {
  const maxAttempts = args.maxAttempts ?? 6;
  const terminal = args.terminal ?? rethrowAsUpstream;
  const adaptation: Adaptation = {
    temperature: args.learned?.temperature,
    dropped: new Set(args.learned?.rejected ?? []),
    dropSchema: false,
    tokenParam: args.learned?.tokenParam ?? 'max_tokens',
    omitTokenLimit: args.learned?.omitTokenLimit ?? false,
    maxTokensCap: args.learned?.maxTokensCap,
    maxTokensFloor: args.learned?.maxTokensFloor,
    forceReasoningNone: args.learned?.forceReasoningNone ?? false,
    attempt: 1,
  };
  let rateLimitRetries = 0;
  for (let attempt = 1; ; attempt += 1) {
    adaptation.attempt = attempt;
    const startedAt = Date.now();
    // Every failure is logged with the upstream's own status and text: a failing call used to leave nothing in
    // this service's log (four 502s and a 400 in one prod job were invisible).
    const logFailure = (err: unknown): void => {
      const { status, message } = summarizeUpstreamError(err);
      logger.warn(
        `upstream call failed: label=${args.label} model=${args.model} attempt=${attempt} status=${status} elapsedMs=${Date.now() - startedAt} requestChars=${args.requestChars ?? "n/a"} schema=${args.hasSchema} message="${message}" requestId=${upstreamRequestId(err) ?? "none"}`,
      );
    };
    // The failure itself was already logged above; this only records that nothing more could be adapted.
    const giveUp = (err: unknown): never => {
      logger.error(`upstream call gave up: label=${args.label} model=${args.model} attempts=${attempt} status=${summarizeUpstreamError(err).status}`);
      return terminal(err);
    };
    try {
      return await args.send(adaptation);
    } catch (err) {
      if (err instanceof EmptyLengthCompletion && attempt < maxAttempts) {
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] empty answer at the output limit; retrying with limit ${err.target} for model=${args.model}`);
        adaptation.maxTokensFloor = err.target;
        args.remember({ maxTokensFloor: err.target });
        continue;
      }
      logFailure(err);
      if (attempt >= maxAttempts) return giveUp(err);

      // A rate limit says nothing about the request: wait what the provider asked (bounded) and send the same call.
      const rateLimitWait = rateLimitWaitMs(err);
      if (rateLimitWait !== null && rateLimitRetries < RATE_LIMIT_RETRIES) {
        rateLimitRetries += 1;
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] rate limited; repeating after ${rateLimitWait} ms for model=${args.model}`);
        await (args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(rateLimitWait);
        continue;
      }

      const requiredTemperature = parseTemperatureConstraint(err);
      if (requiredTemperature !== null && adaptation.temperature !== requiredTemperature) {
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] upstream requires temperature=${requiredTemperature}; retrying for model=${args.model}`);
        adaptation.temperature = requiredTemperature;
        args.remember({ temperature: requiredTemperature });
        continue;
      }

      if (requiredTemperature === null && adaptation.tokenParam === 'max_completion_tokens' && !adaptation.omitTokenLimit && parseMaxTokensUnsupported(err)) {
        // The switch did not help: a proxy in between (LiteLLM treats a model name it does not recognise as a plain
        // chat model) turns max_completion_tokens back into max_tokens. Send no output limit; the model's own default
        // applies. Remembered for the model.
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] upstream refuses both output-limit parameters; sending none for model=${args.model}`);
        adaptation.omitTokenLimit = true;
        args.remember({ omitTokenLimit: true });
        continue;
      }

      if (requiredTemperature === null && adaptation.tokenParam === 'max_tokens' && parseMaxTokensUnsupported(err)) {
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] upstream requires max_completion_tokens instead of max_tokens; retrying for model=${args.model}`);
        adaptation.tokenParam = 'max_completion_tokens';
        args.remember({ tokenParam: 'max_completion_tokens' });
        continue;
      }

      if (requiredTemperature === null && args.hasTools && !adaptation.forceReasoningNone && isToolsWithReasoningRejection(err)) {
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] upstream refuses tools while reasoning; retrying with reasoning_effort=none for model=${args.model}`);
        adaptation.forceReasoningNone = true;
        args.remember({ forceReasoningNone: true });
        continue;
      }

      if (requiredTemperature === null) {
        const cap = parseContextLengthCap(err) ?? parseMaxOutputCap(err);
        if (cap !== null && (adaptation.maxTokensCap === undefined || cap < adaptation.maxTokensCap)) {
          // eslint-disable-next-line no-console
          console.warn(`[${args.label}] upstream caps output at ${cap} tokens; clamping for model=${args.model}`);
          adaptation.maxTokensCap = cap;
          args.remember({ maxTokensCap: cap });
          continue;
        }
      }

      if (requiredTemperature === null) {
        const unsupported = parseUnsupportedParams(err);
        if (unsupported.size > 0) {
          const fresh = [...unsupported].filter((param) => args.droppable.has(param) && !adaptation.dropped.has(param));
          if (fresh.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(`[${args.label}] upstream rejected params [${[...unsupported].join(', ')}]; retrying without them for model=${args.model}`);
            for (const param of fresh) adaptation.dropped.add(param);
            args.remember({ rejected: fresh });
            continue;
          }
        }
      }

      // A temperature error that is still being returned after the temperature was fixed is not a schema
      // problem, so it does not trigger the schema fallback (dropping the schema would not help).
      if (requiredTemperature === null && args.hasSchema && !adaptation.dropSchema && isSchemaRejection(err) && !parseMaxTokensUnsupported(err)) {
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] upstream rejected the response schema; retrying without it for model=${args.model}`);
        adaptation.dropSchema = true;
        continue;
      }

      return giveUp(err);
    }
  }
}

/**
 * A completion the upstream "answered" with nothing usable (null body, no choices). Seen in prod after a
 * ~300 s hang on a long scoring call: the SDK returned null and `response.choices` threw a TypeError that
 * surfaced as an opaque 500. It is an upstream failure and is reported as one (502), which callers treat
 * as retryable and, for large batches, as a reason to split the work.
 */
export function assertCompletion(response: unknown): asserts response is OpenAI.Chat.ChatCompletion {
  const choices = (response as { choices?: unknown } | null | undefined)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new UpstreamHttpError(502, 'Upstream returned an empty completion (no choices)');
  }
}
