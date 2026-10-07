import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { LlmChatOptions, LlmChatResult, LlmClient, LlmResponseSchema, LlmStreamChunk } from './llm-client.interface';
import { redactMessages, redactText, type ChatMessage } from './redactor';
import { fetchWithRetry } from './retryWithBackoff';
import {
  assertCompletion,
  negotiate,
  UpstreamHttpError,
  type Adaptation,
} from './upstream-negotiation';

// UpstreamHttpError moved to upstream-negotiation.ts with the rest of the upstream-error handling;
// re-exported so existing importers (llm.controller.ts, tests) keep working unchanged.
export { UpstreamHttpError };

// Parameters each call can leave out when an upstream rejects them.
const CHAT_DROPPABLE: ReadonlySet<string> = new Set(['seed', 'reasoning_effort']);
const VISION_DROPPABLE: ReadonlySet<string> = new Set(['temperature', 'frequency_penalty']);

// Module-level singleton, not per-instance: the cl100k_base rank table load
// cost should happen once per process, not once per user-scoped
// OpenWebUiClient (OpenWebUiClientFactory caches one instance per user --
// see that factory's own doc comment). Lazily initialized so a process that
// never calls embed() never pays this cost at all. `/lite` + `/ranks/*`
// subpath imports (the more tree-shakeable option) do NOT resolve under
// this project's tsconfig (no explicit moduleResolution -- defaults to
// node10, which doesn't understand package.json subpath exports; confirmed
// directly: `tsc` reports "types... could not be resolved under your
// current 'moduleResolution' setting" for the subpath, while the plain
// main-entry `getEncoding` import resolves cleanly) -- the main entry point
// bundles every encoding table, a negligible one-time memory cost for a
// backend service, not worth a build-breaking risk to avoid.
let cl100kEncoder: Tiktoken | null = null;
function getEmbedEncoder(): Tiktoken {
  if (!cl100kEncoder) cl100kEncoder = getEncoding('cl100k_base');
  return cl100kEncoder;
}

// The temperature to send for a chat/stream attempt. See buildParams in chat(): a demanded temperature wins
// over the caller's; a caller that sent none only gets one after an attempt failed over it.
function chatTemperature(requested: number | undefined, adaptation: Adaptation): number | undefined {
  if (requested !== undefined) return adaptation.temperature ?? requested;
  return adaptation.attempt > 1 ? adaptation.temperature : undefined;
}

function buildResponseFormat(opts: LlmChatOptions | undefined, includeSchema: boolean): OpenAI.ResponseFormatJSONSchema | undefined {
  if (!includeSchema || !opts?.responseSchema) return undefined;
  return {
    type: 'json_schema',
    json_schema: { name: opts.responseSchema.name, schema: opts.responseSchema.schema },
  };
}


export interface OpenWebUiClientConfig {
  LLM_BASE_URL: string;
  /** Overrides LLM_BASE_URL as the OpenAI SDK's baseURL for chat/completions calls only.
   * Use to switch between proxy paths (e.g. /api/v1 vs /api) without breaking the
   * app-root derivation that native-API calls (files, embeddings) depend on. */
  LLM_CHAT_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_CHAT_MODEL: string;
  LLM_VISION_MODEL?: string;
  LLM_TRUSTED_LOCAL: boolean;
  /** When false (default), seed is never sent in chat/vision/file-context requests.
   * Azure-backed models via LiteLLM reject it with a 400. Set true only for
   * Ollama/compatible backends that accept it. */
  LLM_SEND_SEED: boolean;
  /** When false (default), reasoning_effort is never sent in chat/vision requests.
   * Azure-backed models via LiteLLM reject it with a 400. Set true only for
   * Ollama/compatible backends that support it. */
  LLM_SEND_REASONING_EFFORT: boolean;
  /** Temperature for vision() calls. When undefined (default), no temperature
   * is sent and the backend model applies its own default or constraint.
   * Set to 0 for deterministic extraction on permissive models; set to 1
   * when the vision model requires it (e.g. claude-opus-4-8 extended thinking)
   * to avoid the parseTemperatureConstraint retry round-trip. */
  LLM_VISION_TEMPERATURE?: number;
  EMBED_TRANSPORT: 'ollama' | 'openai';
  EMBED_BASE_URL?: string;
  EMBED_MODEL: string;
  EMBED_PATH: string;
  SHOW_PATH: string;
  FILES_UPLOAD_PATH: string;
  FILES_STATUS_PATH: string;
  LLM_REQUEST_TIMEOUT_MS: number;
}

@Injectable()
export class OpenWebUiClient implements LlmClient {
  private readonly openai: OpenAI;
  // What upstreams have told us about each model, remembered for this client's lifetime. Clients are cached
  // per user (see OpenWebUiClientFactory), so a run of calls pays each reject-then-retry round trip once per
  // model instead of once per call -- a prod job logged ~57 failed first attempts for claude-opus-4-8, which
  // requires temperature=1. Shared by chat(), streamChat() and vision(); fed by negotiate().
  private readonly modelConstraints = new Map<string, { temperature?: number; rejected: Set<string> }>();

  private rememberConstraint(model: string, update: { temperature?: number; rejected?: Iterable<string> }): void {
    const current = this.modelConstraints.get(model) ?? { rejected: new Set<string>() };
    if (update.temperature !== undefined) current.temperature = update.temperature;
    for (const param of update.rejected ?? []) current.rejected.add(param);
    this.modelConstraints.set(model, current);
  }

  constructor(private readonly config: OpenWebUiClientConfig) {
    this.openai = new OpenAI({
      baseURL: config.LLM_CHAT_BASE_URL ?? config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY ?? 'unused',
      timeout: config.LLM_REQUEST_TIMEOUT_MS,
      // Root cause of job a830aa30's ~66min failure (confirmed): the SDK's
      // own default (maxRetries: 2) silently re-ran a whole >10min inference
      // up to 3 times on timeout before ever surfacing an error -- not a
      // missing retry, an actively harmful one. chat()/streamChat()/vision()
      // calls are non-idempotent, multi-minute, and NOT safe to blindly
      // re-run; a real failure should surface immediately so the caller's
      // own timeout ladder (ingestion's 30min, this orchestrator's 1h) can
      // report it while there's still margin left, instead of the SDK
      // silently eating that margin on retries of its own.
      maxRetries: 0,
    });
  }

  async chat(messages: ChatMessage[], opts?: LlmChatOptions): Promise<LlmChatResult> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    // Ollama-specific extras, not part of the OpenAI spec -- its OpenAI-compat
    // endpoint accepts a passthrough `options` object for native Ollama
    // request options. Built as ONE merged object (not one independent
    // spread per field) since multiple `options:` spread entries in the same
    // object literal would silently OVERWRITE each other (later key wins),
    // losing whichever was set first. Gated on LLM_TRUSTED_LOCAL: confirmed
    // live that OpenAI/gpt-4.1 via LiteLLM (LLM_TRUSTED_LOCAL=false) rejects
    // `options` with 400 "Unrecognized request argument supplied: options" --
    // NOT silently ignored as previously assumed. Only Ollama-compatible
    // backends (LLM_TRUSTED_LOCAL=true) accept this field.
    // See LlmChatOptions.numCtx/topK/minP doc comments.
    const ollamaOptions: Record<string, number> = {};
    if (opts?.numCtx !== undefined) ollamaOptions.num_ctx = opts.numCtx;
    if (opts?.topK !== undefined) ollamaOptions.top_k = opts.topK;
    if (opts?.minP !== undefined) ollamaOptions.min_p = opts.minP;
    const chatModel = opts?.model ?? this.config.LLM_CHAT_MODEL;
    const buildParams = (a: Adaptation) => ({
      model: chatModel,
      messages: outboundMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      // A temperature the upstream demanded (learned earlier, or on this call's previous attempt)
      // wins over the caller's. A caller that sent none only gets one once an attempt has failed
      // over it, so a learned requirement never leaks into calls that never set a temperature.
      ...(chatTemperature(opts?.temperature, a) !== undefined ? { temperature: chatTemperature(opts?.temperature, a) } : {}),
      // seed: gated on LLM_SEND_SEED (false by default -- Azure-backed models via
      // LiteLLM reject it with a 400); also left out once an upstream has rejected it.
      ...(this.config.LLM_SEND_SEED && !a.dropped.has('seed') && opts?.seed !== undefined ? { seed: opts.seed } : {}),
      ...(buildResponseFormat(opts, !a.dropSchema) ? { response_format: buildResponseFormat(opts, !a.dropSchema) } : {}),
      // Ollama maps OpenAI-compat max_tokens -> its own num_predict. Bounds
      // worst-case latency for a reasoning model's otherwise-unbounded
      // chain-of-thought + answer (see LlmChatOptions.maxTokens doc comment).
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(this.config.LLM_TRUSTED_LOCAL && Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
      // reasoning_effort: gated on LLM_SEND_REASONING_EFFORT (false by default --
      // Azure-backed models via LiteLLM reject it with a 400). `reasoning_effort: 'none'` is NOT
      // an Ollama-native `options.*` field like numCtx/topK/minP above; it's Ollama's OpenAI-compat
      // endpoint's OWN top-level field (confirmed against Ollama's own openai/openai.go:
      // ChatCompletionRequest.ReasoningEffort, mapped internally to api.ThinkValue --
      // a bare `think`/`options.think` field is silently ignored, confirmed live).
      // The SDK's ReasoningEffort type is 'low'|'medium'|'high'|null; 'none' is an
      // Ollama-specific extension, valid server-side despite the narrower SDK union.
      // Only sent when opts.think is explicitly false; omitted otherwise.
      ...(this.config.LLM_SEND_REASONING_EFFORT && !a.dropped.has('reasoning_effort') && opts?.think === false ? { reasoning_effort: 'none' as OpenAI.ReasoningEffort } : {}),
      ...(opts?.tools !== undefined ? { tools: opts.tools as OpenAI.Chat.ChatCompletionTool[] } : {}),
      ...(opts?.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
    });
    const toResult = (response: OpenAI.Chat.ChatCompletion): LlmChatResult => {
      assertCompletion(response);
      const finishReason = response.choices[0]?.finish_reason;
      // Only the abnormal endings are logged (a normal call ends 'stop' /
      // 'tool_calls'), with token counts and never content. A prod job got
      // empty structured answers and nothing anywhere recorded why: no
      // finish reason, no usage.
      if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
        // eslint-disable-next-line no-console
        console.warn(
          `[OpenWebUiClient.chat] finishReason=${finishReason} model=${chatModel} promptTokens=${response.usage?.prompt_tokens ?? 'n/a'} completionTokens=${response.usage?.completion_tokens ?? 'n/a'} maxTokens=${opts?.maxTokens ?? 'n/a'}`,
        );
      }
      return {
        content: response.choices[0]?.message?.content ?? '',
        toolCalls: response.choices[0]?.message?.tool_calls as LlmChatResult['toolCalls'],
        finishReason,
      };
    };
    // Classification and retry policy live in negotiate() (upstream-negotiation.ts): a required temperature,
    // unsupported params and a rejected response schema each adapt the next attempt, and they accumulate.
    return negotiate({
      label: 'OpenWebUiClient.chat',
      model: chatModel,
      hasSchema: opts?.responseSchema !== undefined,
      droppable: CHAT_DROPPABLE,
      learned: this.modelConstraints.get(chatModel),
      remember: (update) => this.rememberConstraint(chatModel, update),
      send: async (adaptation) => toResult(await this.openai.chat.completions.create(buildParams(adaptation))),
    });
  }

  // Read-only accessor for this instance's own default chat model -- built
  // per-user from the caller's vaulted profile (see
  // openwebui-client.factory.ts's getClientFor), NOT the retired global
  // LLM_CHAT_MODEL env var. pipeline.worker.ts reads this to resolve the
  // SAME model name both the real chat() call (which already falls back to
  // this.config.LLM_CHAT_MODEL internally when opts.model is unset) and
  // ingestion's /level caps-sizing + Job.model telemetry use, so a job
  // with no explicit job.model override can't silently size its context
  // budget for a different model than the one actually doing the work.
  get chatModel(): string {
    return this.config.LLM_CHAT_MODEL;
  }

  async listModels(): Promise<string[]> {
    const page = await this.openai.models.list();
    return page.data.map((m) => m.id);
  }

  // Base-model-only catalog for user-facing model pickers (the per-user
  // Open WebUI connection form, and the existing per-job Job.model override
  // -- both now draw from this single filtered source). Built on the
  // native /api/models surface, NOT the OpenAI SDK's models.list() (used by
  // listModels()/checkHealth() above): confirmed live that /api/models is
  // the only source carrying preset/base_model_id and a vision-capability
  // signal (see listSelectableModels's own doc comment for the two real
  // shapes that signal takes), and that it's already permission-scoped to
  // the caller's own token (an access_grants field was present on every
  // entry in a live probe).
  //
  // Filters out Open WebUI presets/agents (a `preset: true` flag, or a
  // truthy `info.base_model_id` meaning this entry is a saved
  // configuration layered on a real model, not a base model itself) --
  // confirmed live and dangerous, not hypothetical: a preset carries its
  // own baked-in system prompt and tool stack, and at least one real
  // preset on a live instance silently ignored a caller-supplied system
  // message entirely, returning a fully-formed but completely unrelated
  // response as a clean 200 OK. req2ado's extraction pipeline parses model
  // output programmatically at temperature 0 -- a hijacking preset would
  // corrupt a job silently, with no error to point at.
  //
  // `token`, when supplied, overrides this.config.LLM_API_KEY for this
  // call only -- needed for POST /llm/connection's validate-before-store
  // flow, which must list models using a token that isn't vaulted yet.
  //
  // Vision capability has TWO real, confirmed-live shapes depending on the
  // model's connection type, not one:
  //   - Ollama-backed models (this deployment's real shape, confirmed live
  //     against a real /api/models response): capabilities is a plain
  //     string array under `ollama.capabilities`, e.g.
  //     ["vision", "completion", "tools"] -- NOT a boolean anywhere. A
  //     model missing "vision" from this array (or missing the `ollama`
  //     key entirely, e.g. the built-in "Arena Model" virtual construct)
  //     is not vision-capable.
  //   - Non-Ollama connections (cloud/OpenAI-compatible models, per
  //     earlier live research against this same instance): report it as
  //     `info.meta.capabilities.vision: boolean` instead -- no `ollama`
  //     key at all for these.
  // Checking only the boolean shape (the original, incomplete
  // implementation) silently returned vision:false for EVERY Ollama-backed
  // model on a live instance, including two genuinely vision-capable ones
  // (confirmed live via a raw /api/models dump: devstral-small-2:24b and
  // qwen3.6:35b both report "vision" in ollama.capabilities). Also
  // confirmed live, separately: gemma4:e4b/gemma4:26b do NOT self-report
  // vision via Ollama's own capabilities, despite older code elsewhere in
  // this codebase (predating this per-user migration) assuming gemma4:e4b
  // was "the" configured vision model -- that assumption came from a
  // hardcoded LLM_VISION_MODEL env var, never verified against Ollama's
  // own capability metadata. This method is the first place that actually
  // checks it.
  async listSelectableModels(token?: string): Promise<{ id: string; name: string; vision: boolean }[]> {
    const response = await fetch(`${this.openWebUiAppRoot()}/api/models`, {
      headers: { Authorization: `Bearer ${token ?? this.config.LLM_API_KEY ?? ''}` },
      signal: AbortSignal.timeout(this.config.LLM_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`OpenWebUiClient.listSelectableModels failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      data: {
        id: string;
        name?: string;
        preset?: boolean;
        info?: { base_model_id?: string | null; meta?: { capabilities?: { vision?: boolean } } };
        ollama?: { capabilities?: string[] };
      }[];
    };
    return body.data
      .filter((model) => model.preset !== true && !model.info?.base_model_id)
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        vision: (model.ollama?.capabilities?.includes('vision') || model.info?.meta?.capabilities?.vision) ?? false,
      }));
  }

  // Cheap reachability probe for the sidebar's connection-status LED --
  // deliberately a SHORT per-call timeout (unlike every other call in this
  // client, which relies on the SDK's own much longer default) so an
  // unreachable backend fails fast instead of leaving the UI's status dot
  // spinning for minutes. Reuses the lightest real call already available
  // (models.list) rather than adding a dedicated ping endpoint upstream.
  async checkHealth(): Promise<{ status: 'reachable' | 'unreachable'; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.openai.models.list({ timeout: 5000 });
      return { status: 'reachable', latencyMs: Date.now() - start };
    } catch {
      return { status: 'unreachable', latencyMs: Date.now() - start };
    }
  }

  async *streamChat(messages: ChatMessage[], opts?: LlmChatOptions): AsyncGenerator<LlmStreamChunk> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    // Same Ollama-passthrough-options construction as chat() above -- see
    // that method's own comment for why this must be ONE merged object.
    // Previously silently dropped here even though LlmChatOptions/the DTO
    // both accept them, and chat() already forwards them for the
    // non-streaming path.
    const ollamaOptions: Record<string, number> = {};
    if (opts?.numCtx !== undefined) ollamaOptions.num_ctx = opts.numCtx;
    if (opts?.topK !== undefined) ollamaOptions.top_k = opts.topK;
    if (opts?.minP !== undefined) ollamaOptions.min_p = opts.minP;
    const chatModel = opts?.model ?? this.config.LLM_CHAT_MODEL;
    const buildParams = (a: Adaptation) => ({
      model: chatModel,
      messages: outboundMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true as const,
      ...(chatTemperature(opts?.temperature, a) !== undefined ? { temperature: chatTemperature(opts?.temperature, a) } : {}),
      // seed: gated on LLM_SEND_SEED -- see chat()'s own seed comment; left out once an upstream rejected it.
      ...(this.config.LLM_SEND_SEED && !a.dropped.has('seed') && opts?.seed !== undefined ? { seed: opts.seed } : {}),
      ...(buildResponseFormat(opts, !a.dropSchema) ? { response_format: buildResponseFormat(opts, !a.dropSchema) } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(this.config.LLM_TRUSTED_LOCAL && Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
      // reasoning_effort: gated on LLM_SEND_REASONING_EFFORT -- see chat()'s own reasoning_effort
      // comment for why this is the correct field; left out once an upstream rejected it.
      ...(this.config.LLM_SEND_REASONING_EFFORT && !a.dropped.has('reasoning_effort') && opts?.think === false ? { reasoning_effort: 'none' as OpenAI.ReasoningEffort } : {}),
    });
    // Only the creation of the stream is negotiated (same policy as chat()); an error while the stream is
    // being read is not retried, as before.
    const stream = await negotiate({
      label: 'OpenWebUiClient.streamChat',
      model: chatModel,
      hasSchema: opts?.responseSchema !== undefined,
      droppable: CHAT_DROPPABLE,
      learned: this.modelConstraints.get(chatModel),
      remember: (update) => this.rememberConstraint(chatModel, update),
      send: async (adaptation) => {
        const created = await this.openai.chat.completions.create(buildParams(adaptation));
        if (!created) throw new UpstreamHttpError(502, 'Upstream returned an empty stream');
        return created;
      },
    });
    // `reasoning` is Ollama's OpenAI-compat streaming delta field for a
    // reasoning model's chain-of-thought (the streaming counterpart of the
    // non-stream response's `message.reasoning`, confirmed live above) --
    // not part of the OpenAI SDK's own delta type, hence the inline shape.
    let finishReason: string | undefined;
    for await (const chunk of stream as AsyncIterable<{ choices: { delta?: { content?: string; reasoning?: string }; finish_reason?: string | null }[] }>) {
      const reason = chunk.choices[0]?.finish_reason;
      if (reason) finishReason = reason;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content || delta.reasoning) {
        yield { ...(delta.content ? { content: delta.content } : {}), ...(delta.reasoning ? { reasoning: delta.reasoning } : {}) };
      }
    }
    if (finishReason) yield { finishReason };
  }

  async embed(texts: string[], opts?: { model?: string }): Promise<number[][]> {
    if (this.config.EMBED_TRANSPORT === 'openai') {
      return this.embedViaOpenAiProxy(texts, opts);
    }
    if (this.config.EMBED_TRANSPORT !== 'ollama') {
      throw new Error(
        `OpenWebUiClient.embed() not implemented for EMBED_TRANSPORT=${this.config.EMBED_TRANSPORT} — only 'ollama' and 'openai' are implemented`,
      );
    }
    const outboundTexts = this.config.LLM_TRUSTED_LOCAL ? texts : texts.map(redactText);
    const baseUrl = (this.config.EMBED_BASE_URL ?? this.config.LLM_BASE_URL).replace(/\/v1\/?$/, '');
    // Retried (unlike chat()/vision()) -- a pure read with no side effects,
    // safe to re-run on a transient 429/5xx/network failure. See
    // retryWithBackoff.ts's own doc comment for why this is the opposite
    // call of the OpenAI client's maxRetries:0 above. maxRetries:3 (not the
    // helper's own default of 5) -- this call sits synchronously in an
    // already-slow SURVEY pipeline path; 3 attempts with exponential
    // backoff is enough margin for a transient blip without piling on
    // multiple extra seconds of dead time on a persistent failure.
    const response = await fetchWithRetry(
      () =>
        fetch(`${baseUrl}${this.config.EMBED_PATH}`, {
          method: 'POST',
          headers: this.nativeOllamaHeaders(),
          body: JSON.stringify({ model: opts?.model ?? this.config.EMBED_MODEL, input: outboundTexts }),
        }),
      { maxRetries: 3 },
    );
    if (!response.ok) {
      let bodyText = '';
      try { bodyText = await response.text(); } catch { /* ignore read failure */ }
      // eslint-disable-next-line no-console
      console.error(`[OpenWebUiClient] Ollama embed ${response.status}: ${bodyText.slice(0, 500)}`);
      throw new UpstreamHttpError(
        response.status,
        `Ollama embed request failed: ${response.status}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`,
      );
    }
    const body = (await response.json()) as { embeddings: number[][] };
    return body.embeddings;
  }

  // Ollama (and Open WebUI's own /api/embeddings passthrough of it) is
  // permanently unavailable on this deployment's production target --
  // confirmed with the user, not just disabled today. This is the fallback
  // transport: Open WebUI's deprecated-but-working `/openai/embeddings`
  // proxy (labeled "Deprecated: proxy all requests to OpenAI API" in Open
  // WebUI's own source), which -- unlike the documented, provider-agnostic
  // `/api/embeddings` route -- does NOT check the model against the
  // chat-model registry first (a known, currently-unfixed upstream bug,
  // open-webui/open-webui#17584, that makes `/api/embeddings` 500 "Model
  // not found" for an embedding-only connection). Confirmed live: this
  // route returns real 1536-dim vectors for
  // `model: "OpenAI/text-embedding-3-small"`, and production's own
  // existing file-attach RAG already depends on this identical
  // openai-proxy connection type (RAG_EMBEDDING_ENGINE: openai).
  //
  // `body.data` is NOT guaranteed to come back in request order (the
  // OpenAI embeddings API spec only promises each entry's own `.index`
  // matches its position in the input) -- sorting before mapping is
  // required, not defensive/optional, or a request with >1 text could
  // silently pair the wrong text with the wrong vector.
  private async embedViaOpenAiProxy(texts: string[], opts?: { model?: string }): Promise<number[][]> {
    const outboundTexts = this.config.LLM_TRUSTED_LOCAL ? texts : texts.map(redactText);
    // Split any text that exceeds the model's per-input token limit before
    // submitting. chunkMap[i] = [start, end) in the flat chunks array for
    // original text i, so we can reconstruct one vector per original text by
    // averaging its chunks (a no-op for texts that fit within the limit).
    const flatChunks: string[] = [];
    const chunkMap: [number, number][] = [];
    for (const text of outboundTexts) {
      const chunks = this.splitTextForEmbed(text);
      chunkMap.push([flatChunks.length, flatChunks.length + chunks.length]);
      flatChunks.push(...chunks);
    }
    // Same retry policy as the 'ollama' branch above -- a pure read with no
    // side effects, safe to re-run on a transient 429/5xx/network failure.
    const response = await fetchWithRetry(
      () =>
        fetch(`${this.openWebUiAppRoot()}/openai/embeddings`, {
          method: 'POST',
          headers: this.nativeOllamaHeaders(),
          body: JSON.stringify({ model: opts?.model ?? this.config.EMBED_MODEL, input: flatChunks }),
        }),
      { maxRetries: 3 },
    );
    if (!response.ok) {
      let bodyText = '';
      try { bodyText = await response.text(); } catch { /* ignore read failure */ }
      let detail = bodyText;
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        const msg = typeof parsed.message === 'string' ? parsed.message : '';
        const det = typeof parsed.detail === 'string' ? parsed.detail : '';
        detail = msg || det || bodyText;
      } catch { /* non-JSON body — use raw text */ }
      // eslint-disable-next-line no-console
      console.error(`[OpenWebUiClient] /openai/embeddings ${response.status}: ${detail.slice(0, 500)}`);
      throw new UpstreamHttpError(
        response.status,
        `Open WebUI /openai/embeddings request failed: ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
    }
    const body = (await response.json()) as { data: { embedding: number[]; index: number }[] };
    // OpenAI embeddings spec only guarantees each entry's own `.index` matches
    // its position in the input -- sort before indexing into the flat array.
    const flatVectors = [...body.data].sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
    // Reconstruct one vector per original text by averaging the vectors of its
    // constituent chunks (a no-op when the text fit within the limit).
    return chunkMap.map(([start, end]) => this.averageVectors(flatVectors.slice(start, end)));
  }

  // Splits a text into chunks that each fit within EMBED_MAX_TOKENS, using
  // the REAL cl100k_base tokenizer (text-embedding-3-small's own encoding)
  // rather than a chars-based estimate. Real gap this closes: the previous
  // chars/4 estimate is a reasonable average for English but confirmed
  // unsafe for this deployment's Hebrew content (OCR_LANGUAGES: "eng,heb")
  // -- BPE tokenizers trained predominantly on Latin-script text commonly
  // tokenize Hebrew far less efficiently (often 1.5-2.5 chars/token, not 4),
  // so a chunk that measured "safe" under the char estimate could still
  // exceed the real 8192-token limit. KB ingestion's own chunker
  // (chunker.py's _chunk_by_heading) has no upstream size cap, so this is
  // the only real safety net for an oversized section.
  //
  // Chunks by slicing the ENCODED TOKEN ARRAY, not by character position --
  // guarantees exact correctness regardless of script/density, unlike any
  // chars-based heuristic. A chunk boundary landing mid-word after decode()
  // is a non-issue here: nobody reads this text, and the resulting vectors
  // are averaged back together by the caller.
  //
  // Falls back to the previous chars-based estimate on any tokenizer
  // failure (e.g. a corrupted install in a constrained container) rather
  // than crashing the embed call -- same fail-open philosophy as
  // DocumentOverviewService/JobEventPersistenceService elsewhere in this
  // module.
  private splitTextForEmbed(text: string): string[] {
    try {
      const encoder = getEmbedEncoder();
      const tokens = encoder.encode(text);
      if (tokens.length <= OpenWebUiClient.EMBED_MAX_TOKENS) return [text];
      const chunks: string[] = [];
      for (let start = 0; start < tokens.length; start += OpenWebUiClient.EMBED_MAX_TOKENS) {
        const slice = tokens.slice(start, start + OpenWebUiClient.EMBED_MAX_TOKENS);
        chunks.push(encoder.decode(slice));
      }
      return chunks;
    } catch (err) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error('[OpenWebUiClient] cl100k_base tokenizer failed, falling back to chars-based chunk estimate:', err);
      return this.splitTextForEmbedByChars(text);
    }
  }

  // Fallback-only chars/CHARS_PER_TOKEN estimate, used solely when the real
  // tokenizer (splitTextForEmbed above) fails. Breaks at whitespace when
  // possible to avoid splitting mid-word. Over-estimates token count
  // intentionally -- extra chunks cost one more embedding call, not a
  // backend 400.
  private splitTextForEmbedByChars(text: string): string[] {
    const maxChars = OpenWebUiClient.EMBED_MAX_TOKENS * OpenWebUiClient.CHARS_PER_TOKEN;
    if (text.length <= maxChars) return [text];
    const chunks: string[] = [];
    let pos = 0;
    while (pos < text.length) {
      let end = Math.min(pos + maxChars, text.length);
      if (end < text.length) {
        const lastWs = text.lastIndexOf(' ', end);
        if (lastWs > pos) end = lastWs;
      }
      const chunk = text.slice(pos, end).trim();
      if (chunk.length > 0) chunks.push(chunk);
      pos = end;
      while (pos < text.length && text[pos] === ' ') pos++;
    }
    return chunks.length > 0 ? chunks : [text];
  }

  // Averages a set of equal-dimension embedding vectors component-wise.
  // Returns the single vector directly when there is only one (no copy).
  private averageVectors(vectors: number[][]): number[] {
    if (vectors.length === 1) return vectors[0];
    const dim = vectors[0].length;
    const result = new Array<number>(dim).fill(0);
    for (const v of vectors) {
      for (let i = 0; i < dim; i++) result[i] += v[i];
    }
    const n = vectors.length;
    return result.map((x) => x / n);
  }

  // Shared by embed()/showModel() -- both bypass the OpenAI SDK client
  // (this.openai, used by chat()/vision()/listModels(), already
  // constructed with apiKey: LLM_API_KEY) since they hit Ollama's/Open
  // WebUI's NATIVE API shape, not its OpenAI-compat surface. Confirmed
  // live: a real Open WebUI instance (unlike raw Ollama, which needs no
  // auth at all) 401s on either endpoint with no Authorization header --
  // a real gap, silently invisible until this codebase's dev target
  // actually became Open WebUI instead of bare Ollama.
  private nativeOllamaHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {}),
    };
  }

  // Real gap this closes: ingestion's _resolve_caps (llm_leveling.py) is a
  // hand-maintained table of per-model context length/coverage-budget/
  // tool-support, populated by a human manually running Ollama's real
  // /api/show endpoint once per model and hardcoding the result -- any
  // model NOT in that table gets the same blanket conservative guess
  // regardless of what it actually is. /api/show is Ollama's NATIVE API
  // (not its OpenAI-compat surface), same reason embed() above needs the
  // same base-URL stripping. contextLength is read from
  // model_info[f"{architecture}.context_length"] -- the architecture-
  // prefixed key name Ollama actually uses (confirmed against real /api/show
  // output; there is no unprefixed "context_length" field). null when
  // either key is missing (an unrecognized architecture, or a backend that
  // returns a shape this doesn't expect) -- never throws on a merely-absent
  // field, only on a genuinely unreachable/non-Ollama backend (a real
  // OpenAI-compat frontier proxy has no /api/show at all).
  // Open WebUI virtual multi-model constructs (e.g. "Arena Model") have no
  // corresponding real Ollama model and no /api/show entry at all -- a bare
  // showModel() call against one would fail with an opaque, easy-to-misread
  // HTTP error (looks identical to "backend unreachable"). Named + growable
  // if Open WebUI adds more virtual model kinds later; not a general
  // capability check, just this one confirmed real gap.
  // Per-input token limit for the /openai/embeddings endpoint.
  // text-embedding-3-small (this deployment) hard-caps at 8192; 7500 provides
  // ~700 token margin. Used both as the real cl100k_base token-count ceiling
  // (splitTextForEmbed's primary path) and, multiplied by CHARS_PER_TOKEN,
  // as the fallback chars-based ceiling (splitTextForEmbedByChars).
  private static readonly EMBED_MAX_TOKENS = 7500;
  // Fallback-only: chars-per-token estimate used solely when the real
  // tokenizer fails (see splitTextForEmbed's own doc comment for why a
  // chars-based estimate is unsafe as the PRIMARY mechanism -- kept here
  // only as a defensive last resort). Intentionally low so
  // splitTextForEmbedByChars over-splits rather than under-splits when it's
  // the active path -- the cost of an extra chunk is one more embedding
  // call, not a 400 from the backend.
  private static readonly CHARS_PER_TOKEN = 4;

  private static readonly VIRTUAL_MODEL_NAMES = new Set(['Arena Model']);

  async showModel(model: string): Promise<{ contextLength: number | null; capabilities: string[] }> {
    if (OpenWebUiClient.VIRTUAL_MODEL_NAMES.has(model)) {
      throw new Error(
        `showModel() called with "${model}" -- an Open WebUI virtual multi-model construct, not a real Ollama model with its own /api/show entry. Caller should fall back to conservative capability defaults, same as any unreachable/unrecognized model.`,
      );
    }
    const baseUrl = (this.config.EMBED_BASE_URL ?? this.config.LLM_BASE_URL).replace(/\/v1\/?$/, '');
    // Retried -- same reasoning as embed() above (pure read, safe to re-run,
    // maxRetries:3 to bound worst-case dead time on a persistent failure).
    const response = await fetchWithRetry(
      () =>
        fetch(`${baseUrl}${this.config.SHOW_PATH}`, {
          method: 'POST',
          headers: this.nativeOllamaHeaders(),
          body: JSON.stringify({ model }),
        }),
      { maxRetries: 3 },
    );
    if (!response.ok) {
      throw new Error(`Ollama /api/show request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      capabilities?: string[];
      model_info?: Record<string, unknown>;
    };
    const modelInfo = body.model_info ?? {};
    const architecture = modelInfo['general.architecture'];
    const contextLengthRaw = typeof architecture === 'string' ? modelInfo[`${architecture}.context_length`] : undefined;
    const contextLength = typeof contextLengthRaw === 'number' ? contextLengthRaw : null;
    return { contextLength, capabilities: body.capabilities ?? [] };
  }

  async vision(
    prompt: string,
    images: Buffer[],
    opts?: { model?: string; mimeType?: string; responseSchema?: LlmResponseSchema; detail?: 'low' | 'high' | 'auto' },
  ): Promise<string> {
    const model = opts?.model ?? this.config.LLM_VISION_MODEL ?? this.config.LLM_CHAT_MODEL;
    // Same OpenAI-compatible chat.completions endpoint as chat(), just with
    // a multimodal content array -- Ollama/Open WebUI's OpenAI-compat API
    // accepts image_url content parts for vision-capable models (llava,
    // bakllava, moondream, etc.) the same way OpenAI's own API does.
    // mimeType defaults to image/png -- the pre-existing hardcoded value,
    // harmless for docx-embedded figures whose real type was never
    // surfaced, but now correctly overridable for directly-uploaded
    // non-PNG images (KB image ingestion).
    const mimeType = opts?.mimeType ?? 'image/png';
    const outboundPrompt = this.config.LLM_TRUSTED_LOCAL ? prompt : redactText(prompt);
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: outboundPrompt },
      ...images.map((image) => ({
        type: 'image_url' as const,
        // detail controls resolution/token cost: 'high' activates tile-based
        // high-res processing (Azure AI vision docs), useful for complex
        // engineering drawings. Defaults to 'auto' when not set.
        image_url: {
          url: `data:${mimeType};base64,${image.toString('base64')}`,
          ...(opts?.detail ? { detail: opts.detail } : {}),
        },
      })),
    ];
    const buildParams = (a: Adaptation) => ({
      model,
      messages: [{ role: 'user' as const, content }],
      // Confirmed real root cause of run-to-run SURVEY node-count variance
      // (74 vs ~120 nodes for the identical document): unlike every other
      // call in this module, this one previously set neither temperature
      // nor seed, so each figure's caption was freshly (re-)sampled on
      // every job -- and caption text feeds directly into
      // llm_leveling.py's token-budget branch splitter, so a differently
      // worded caption can shift branch boundaries and, with them, total
      // node count. A caption is structured extraction (describe what's in
      // the image), not creative writing -- temperature 0 is correct on its
      // own merits. seed 0 is defensive hygiene gated on LLM_SEND_SEED
      // (false by default for Azure backends that reject it).
      // includeTemperature:false is the retry path when the upstream
      // (e.g. an Azure o-series reasoning model) rejects this param.
      // LLM_VISION_TEMPERATURE unset → no temperature sent; the backend
      // applies its own default or constraint (parseTemperatureConstraint
      // handles value-constraint retries when they arise).
      ...(!a.dropped.has('temperature') && this.config.LLM_VISION_TEMPERATURE !== undefined ? { temperature: a.temperature ?? this.config.LLM_VISION_TEMPERATURE } : {}),
      ...(this.config.LLM_SEND_SEED && !a.dropped.has('seed') ? { seed: 0 } : {}),
      // No output cap previously existed here at all -- the prompt asks
      // for "one or two sentences" (orchestrator_vision_client.py's
      // _build_prompt), so a real caption is SUPPOSED to be short, but
      // nothing bounded the worst case (a reasoning-capable vision model
      // going off the rails on a pathological image). Bounds latency risk
      // only; the byte-hash cache (main.py's figure-caption memoization)
      // already removes the repeat cost of a slow caption on re-runs.
      //
      // Second live incident (confirmed via a real SURVEY run's figure
      // descriptions): the deployed vision model, for a genuinely complex
      // multi-view engineering drawing, ignored the prior soft "one or two
      // sentences" wording and produced a markdown breakdown per view (a
      // header + several full sentences each), long enough to get cut off
      // mid-JSON by this 200-token cap -- orchestrator_vision_client.py's
      // repair_json fallback then "repairs" the truncated JSON into
      // schema-valid (parseable, significant=True) but content-truncated
      // output, worse than the reasoning-exhaustion incident below (empty
      // content) because it looks like a normal, complete caption instead
      // of failing loudly. The real fix is enforcing brevity at the
      // source (the prompt + schema field description in
      // orchestrator_vision_client.py now spell it out explicitly and
      // structurally, not just as a soft ask) -- raising this cap to
      // chase an unbounded worst case would only make a genuinely
      // non-compliant response MORE expensive per call, not prevent it.
      // 300 is a defensive backstop a few times wider than a real
      // one-or-two-sentence caption ever needs, not the primary defense.
      max_tokens: 300,
      // Real, 100%-reproducible root cause (confirmed live: every single
      // figure in a real document came back "no useful caption returned"
      // on a genuinely fresh, uncached run): unlike chat()'s own
      // `opts?.think === false` handling above, this call never disabled
      // reasoning at all. gemma4:e4b (this deployment's configured vision
      // model) reports a real "thinking" capability -- its chain-of-thought
      // tokens consumed the entire max_tokens budget before any real answer
      // token was ever produced, leaving message.content genuinely empty
      // (the reasoning itself lands in the separate message.reasoning
      // field, never read here). A one-line image caption has no
      // legitimate use for a reasoning trace -- same "structured
      // extraction, not creative writing" reasoning the temperature=0
      // comment above already states, applied to the token-budget problem
      // reasoning caused. Gated on LLM_SEND_REASONING_EFFORT (false by
      // default for Azure backends that reject it); only meaningful when
      // targeting an Ollama-compatible backend that supports 'none'.
      ...(this.config.LLM_SEND_REASONING_EFFORT && !a.dropped.has('reasoning_effort') ? { reasoning_effort: 'none' as OpenAI.ReasoningEffort } : {}),
      // Third live incident, confirmed via a real completed job's actual
      // figure descriptions (not a synthetic test): 2 of 42 real captions
      // came back with the SAME content repeated near-verbatim within one
      // response, trailed by a stray, broken continuation fragment
      // ("```json {") -- confirmed this is genuinely inside the JSON
      // string's own content, not a parsing bug on ingestion's side (the
      // JSON envelope itself is syntactically valid; response_format's
      // schema enforcement constrains STRUCTURE, not content quality, so
      // it cannot prevent a model from writing degenerate/looping text
      // inside a valid string field). A schema-constrained, structured-
      // extraction call like this one has no legitimate use for repeating
      // itself -- frequency_penalty is the standard OpenAI-compatible
      // decoding knob for discouraging exact-phrase repetition, same
      // "structured extraction, not creative writing" reasoning
      // temperature=0 above already applies, now to the repetition-loop
      // problem specifically. A mitigation, not a guarantee -- repetition-
      // loop behavior is probabilistic, not a deterministic bug this
      // parameter can promise to eliminate.
      // includeFrequencyPenalty:false is the retry path when the upstream
      // (e.g. an Azure o-series reasoning model) rejects this param.
      ...(!a.dropped.has('frequency_penalty') ? { frequency_penalty: 0.4 } : {}),
      ...(buildResponseFormat(opts, !a.dropSchema) ? { response_format: buildResponseFormat(opts, !a.dropSchema) } : {}),
    });
    // Classification and retry policy live in negotiate() (upstream-negotiation.ts), shared with chat().
    // A failure that cannot be adapted around is rethrown as-is, as before: vision's controller route has no
    // UpstreamHttpError mapping, so wrapping it here would only change the HTTP status it ends up with.
    return negotiate({
      label: 'OpenWebUiClient.vision',
      model,
      hasSchema: opts?.responseSchema !== undefined,
      droppable: VISION_DROPPABLE,
      learned: this.modelConstraints.get(model),
      remember: (update) => this.rememberConstraint(model, update),
      terminal: (err) => {
        throw err;
      },
      send: async (adaptation) => {
        const response = await this.openai.chat.completions.create(buildParams(adaptation));
        assertCompletion(response);
        return response.choices[0]?.message?.content ?? '';
      },
    });
  }

  // Derives Open WebUI's true app root from LLM_BASE_URL for its NATIVE
  // (non-OpenAI-compat) file API -- uploadFile/pollFileProcessed/deleteFile
  // all need this, unlike chat()/embed(), which correctly go through
  // whichever OpenAI-compat surface LLM_BASE_URL points at. The native file
  // API (/api/v1/files/...) lives ONLY at the app root and is never mirrored
  // under any OpenAI-compat proxy prefix. Confirmed live: with
  // LLM_BASE_URL=http://host:3000/ollama/v1 (a real dev config, where Open
  // WebUI's Ollama integration is genuinely connected), the old bare
  // `.replace(/\/v1\/?$/, '')` left `/ollama` in place, producing
  // http://host:3000/ollama/api/v1/files/ -- a real route that exists but
  // rejects POST (405), not the files endpoint at all (the true endpoint,
  // http://host:3000/api/v1/files/, returned 401 unauthenticated -- i.e.
  // genuinely reachable). The primer's fail-open design meant this never
  // surfaced as a job failure, only as "the primer silently never works,"
  // confirmed via docker logs during a real SURVEY run.
  //
  // Strips an optional `ollama/` OR `api/` segment immediately before the
  // trailing `v1` so `.../v1`, `.../ollama/v1`, and `.../api/v1` all
  // resolve to the same true app root. The `api/` case matters because
  // `.../ollama/v1` is only a legitimate LLM_BASE_URL value when the target
  // instance's Ollama integration is actually enabled -- confirmed on a
  // real production instance where it is disabled at the platform level,
  // making `.../ollama/v1` a dead endpoint there (empty model list, chat
  // 503/disabled) while `.../api/v1` (Open WebUI's own first-class
  // OpenAI-compatible REST namespace) works reliably. Which value is
  // correct is a per-deployment fact, not a universal one -- this method
  // must derive the right app root for either.
  private openWebUiAppRoot(): string {
    return this.config.LLM_BASE_URL.replace(/\/(ollama\/|api\/)?v1\/?$/, '');
  }

  // The whole-document AI context primer (Phase 6c, pipeline.worker.ts)
  // needs Open WebUI's NATIVE full-document file-context mode -- chat()
  // cannot reach it. chat() goes through the OpenAI SDK, whose
  // chat.completions.create() always POSTs to {baseURL}/chat/completions;
  // with LLM_BASE_URL routed through Open WebUI's Ollama-compatibility
  // proxy (.../ollama/v1, this deployment's real config), that lands on
  // the Ollama-compat proxy route, a genuinely different backend code
  // path that never runs the file-context middleware at all. Confirmed
  // against Open WebUI v0.8.12 source
  // (backend/open_webui/utils/middleware.py's process_chat_payload and
  // chat_completion_files_handler, and retrieval/utils.py's
  // get_sources_from_items): only the NATIVE route (POST
  // /api/chat/completions) parses the top-level `files` array's
  // per-item `context: "full"` flag and, when set, returns the file's
  // full stored content instead of routing it into chunked RAG. This is
  // a genuine per-request field any authenticated user's API key can
  // set -- confirmed with a canary phrase embedded in a real uploaded
  // file, returned correctly ONLY via this native-endpoint +
  // `context: "full"` combination (the SDK path silently never saw the
  // file at all -- "I cannot see an attached document..." -- despite
  // accepting the old chat()-forwarded `files` field with no error,
  // which is why that field is retired rather than fixed in place: it
  // was never reachable through the right endpoint to begin with).
  //
  // Deliberately narrow (unlike chat()'s general-purpose surface) --
  // this method exists for exactly one caller with exactly one shape:
  // a single user-turn prompt against one already-uploaded, already-
  // processed file. temperature/seed are hardcoded to 0, matching the
  // primer's own existing determinism requirement (this text feeds both
  // every branch's analyze_section prompt AND the figure-caption cache
  // key -- see pipeline.worker.ts's own PRIMER_FIXED_NUM_CTX comment).
  async chatWithFullFileContext(
    content: string,
    fileId: string,
    opts: { maxTokens?: number; numCtx?: number },
  ): Promise<LlmChatResult> {
    const outboundContent = this.config.LLM_TRUSTED_LOCAL ? content : redactText(content);
    const response = await fetch(`${this.openWebUiAppRoot()}/api/chat/completions`, {
      method: 'POST',
      // `context: 'full'` is an undocumented Open WebUI extension field on
      // the files array entry that instructs the native route to return the
      // file's full stored content instead of routing it into chunked RAG.
      // Confirmed working live (canary phrase test) but not in the public
      // API reference -- a future Open WebUI upgrade could change this
      // behavior silently (failure mode: falls back to chunked RAG, not a
      // 400). Confirmed against Open WebUI v0.8.12 source.
      signal: AbortSignal.timeout(this.config.LLM_REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.LLM_CHAT_MODEL,
        messages: [{ role: 'user', content: outboundContent }],
        files: [{ type: 'file', id: fileId, context: 'full' }],
        temperature: 0,
        ...(this.config.LLM_SEND_SEED ? { seed: 0 } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.numCtx !== undefined ? { options: { num_ctx: opts.numCtx } } : {}),
      }),
    });
    if (!response.ok) {
      let bodyText = '';
      try { bodyText = await response.text(); } catch { /* ignore read failure */ }
      throw new Error(`OpenWebUiClient.chatWithFullFileContext failed: ${response.status}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`);
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return { content: data.choices?.[0]?.message?.content ?? '' };
  }

  // Uploads a source document to Open WebUI's native file API (not the
  // OpenAI-compat surface -- same reason embed()/showModel() bypass
  // this.openai) so a later call can generate the whole-document AI context
  // primer (Phase 6) from it. FormData/Blob are global in Node 18+, no
  // import needed.
  async uploadFile(buffer: Buffer, filename: string): Promise<string> {
    const baseUrl = this.openWebUiAppRoot();
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    // ?process=true -- confirmed via the real Open WebUI browser UI's own
    // Network tab (attaching a file calls exactly this URL shape). Without
    // it the file uploads but is never run through Open WebUI's
    // text-extraction/chunking pipeline, matching a known upstream report
    // (open-webui/open-webui#13600: upload succeeds, data.content stays
    // empty) -- pollFileProcessed() below would then poll a file that was
    // never queued for processing in the first place.
    const response = await fetch(`${baseUrl}${this.config.FILES_UPLOAD_PATH}?process=true`, {
      method: 'POST',
      // No Content-Type header here -- fetch sets the correct
      // multipart/form-data boundary itself when given a FormData body;
      // nativeOllamaHeaders() hardcodes application/json, which would
      // break the multipart upload.
      headers: this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {},
      body: form,
    });
    if (!response.ok) {
      throw new Error(`OpenWebUiClient.uploadFile failed: ${response.status}`);
    }
    const data = (await response.json()) as { id: string };
    return data.id;
  }

  // Polls Open WebUI's file-processing-status endpoint until the uploaded
  // file reaches a terminal state, or timeoutMs elapses. Never throws --
  // a transient poll failure is not itself a verdict, so it's swallowed and
  // polling continues until the deadline; a stuck 'pending' and a timeout
  // both resolve false the same way, matching "primer generation didn't
  // work out, proceed without it" being the only two real outcomes callers
  // need to distinguish (succeeded vs. didn't).
  async pollFileProcessed(fileId: string, timeoutMs: number): Promise<boolean> {
    const baseUrl = this.openWebUiAppRoot();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}${this.config.FILES_STATUS_PATH}/${fileId}/process/status`, {
          headers: this.nativeOllamaHeaders(),
        });
        if (response.ok) {
          const data = (await response.json()) as { status?: string };
          if (data.status === 'completed') return true;
          if (data.status === 'failed') return false;
        }
      } catch {
        // A transient poll failure is not itself a verdict -- keep polling
        // until the deadline, then time out the same as a stuck 'pending'.
      }
      // Clamped to the remaining budget -- without this, a poll interval
      // longer than what's left before the deadline (the common case for a
      // short timeoutMs, and the tail iteration of any timeoutMs) silently
      // rounds the actual wait up to a full extra 1000ms past the caller's
      // requested deadline.
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    }
    return false;
  }

  // Best-effort cleanup of an uploaded file once the primer has already
  // resolved (succeeded or not) -- a delete failure must never mask that
  // already-resolved result or throw past the caller, so this swallows its
  // own errors entirely rather than surfacing them.
  async deleteFile(fileId: string): Promise<void> {
    const baseUrl = this.openWebUiAppRoot();
    try {
      await fetch(`${baseUrl}${this.config.FILES_STATUS_PATH}/${fileId}`, {
        method: 'DELETE',
        headers: this.nativeOllamaHeaders(),
      });
    } catch {
      // Best-effort cleanup -- a delete failure must never mask the
      // primer's already-resolved result or throw past the caller.
    }
  }
}
