import OpenAI from 'openai';

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
  // Fallback: generic UnsupportedParamsError -- scan for known param names in the message
  if (err.message.includes('UnsupportedParamsError') || err.message.toLowerCase().includes('unsupported')) {
    if (err.message.includes('seed')) params.add('seed');
    if (err.message.includes('reasoning_effort')) params.add('reasoning_effort');
    if (err.message.includes('temperature')) params.add('temperature');
    if (err.message.includes('frequency_penalty')) params.add('frequency_penalty');
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
  /** 1 for the first attempt, 2 for the next, and so on. */
  attempt: number;
}

/** What is already known about a model, remembered across calls by the caller's client. */
export interface LearnedConstraints {
  temperature?: number;
  rejected: ReadonlySet<string>;
}

export interface NegotiationArgs<T> {
  /** Log prefix, e.g. `OpenWebUiClient.chat`. */
  label: string;
  model: string;
  /** Whether the request carries a response_format schema that can be dropped. */
  hasSchema: boolean;
  /** Parameters this call is able to leave out when an upstream rejects them. */
  droppable: ReadonlySet<string>;
  learned?: LearnedConstraints;
  /** Called with what a failure taught us, so later calls start from it. */
  remember: (update: { temperature?: number; rejected?: Iterable<string> }) => void;
  /** Builds and sends ONE attempt under the given adaptation. */
  send: (adaptation: Adaptation) => Promise<T>;
  /** How a failure that cannot be adapted around leaves the loop. Defaults to rethrowAsUpstream. */
  terminal?: (err: unknown) => never;
  /** Hard cap on attempts, including the first. Default 4. */
  maxAttempts?: number;
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
  const maxAttempts = args.maxAttempts ?? 4;
  const terminal = args.terminal ?? rethrowAsUpstream;
  const adaptation: Adaptation = {
    temperature: args.learned?.temperature,
    dropped: new Set(args.learned?.rejected ?? []),
    dropSchema: false,
    attempt: 1,
  };
  for (let attempt = 1; ; attempt += 1) {
    adaptation.attempt = attempt;
    try {
      return await args.send(adaptation);
    } catch (err) {
      if (attempt >= maxAttempts) return terminal(err);

      const requiredTemperature = parseTemperatureConstraint(err);
      if (requiredTemperature !== null && adaptation.temperature !== requiredTemperature) {
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] upstream requires temperature=${requiredTemperature}; retrying for model=${args.model}`);
        adaptation.temperature = requiredTemperature;
        args.remember({ temperature: requiredTemperature });
        continue;
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
      if (requiredTemperature === null && args.hasSchema && !adaptation.dropSchema && isSchemaRejection(err)) {
        // eslint-disable-next-line no-console
        console.warn(`[${args.label}] upstream rejected the response schema; retrying without it for model=${args.model}`);
        adaptation.dropSchema = true;
        continue;
      }

      return terminal(err);
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
