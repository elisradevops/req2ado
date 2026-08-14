import type { ChatMessage } from './redactor';

/**
 * A JSON Schema constraining the shape of a chat response, forwarded to the
 * underlying OpenAI-compatible `response_format: {type:'json_schema', ...}`
 * param when the backend supports structured output (Ollama's OpenAI-compat
 * endpoint does on modern versions). Tightens output at the sampling level
 * instead of relying solely on prompt wording -- e.g. constraining a `type`
 * field to an enum so a model can't hallucinate an out-of-vocabulary value.
 * Optional and best-effort: an unsupported/rejected schema degrades to a
 * schema-less retry rather than failing the call (see openwebui.client.ts).
 */
export interface LlmResponseSchema {
  name: string;
  schema: Record<string, unknown>;
}

// OpenAI-compat function-calling tool definition -- forwarded verbatim to
// the underlying `tools` param. `parameters` is a JSON Schema object
// describing the function's arguments (same schema dialect as
// LlmResponseSchema.schema above).
export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// chat()'s result, widened for tool-calling (§5a of the SURVEY
// holistic-analysis redesign) -- `content` stays present and is what every
// pre-existing caller reads, so this is backward-compatible with the 5
// existing single-shot ingestion callers (they only ever read `.content`).
// `toolCalls`/`finishReason` are populated only when `opts.tools` was set
// and the model chose to call one.
export interface LlmChatResult {
  content: string;
  toolCalls?: LlmToolCall[];
  finishReason?: string;
}

export interface LlmChatOptions {
  model?: string;
  temperature?: number;
  // Pins the sampler's RNG (forwarded as OpenAI-compat `seed`, honored by
  // Ollama and by the production proxy alike). Defensive/hygiene on top of
  // `temperature: 0` for a structured-extraction call whose OUTPUT feeds
  // downstream deterministic logic -- exactly the pairing vision() already
  // hardcodes for figure captions (see openwebui.client.ts's own temperature/
  // seed comment and the run-to-run SURVEY node-count variance it fixed).
  // Omitted leaves the backend's own default sampling untouched, so a
  // user-facing chat turn is unaffected.
  seed?: number;
  responseSchema?: LlmResponseSchema;
  // Caps output length (forwarded as OpenAI-compat `max_tokens`, which
  // Ollama maps to its own `num_predict`). Bounds worst-case latency for a
  // reasoning/"thinking" model that can otherwise generate an unbounded
  // chain-of-thought trace before its answer -- observed live: qwen3:4b
  // generated ~87% hidden reasoning tokens per call, with generation
  // throughput itself degrading as context grows, producing 40+ minute
  // calls with no cap in place. Does not fix verbosity, only bounds it.
  maxTokens?: number;
  // Ollama's actual runtime context window, forwarded as `options.num_ctx`
  // in the request body its OpenAI-compat endpoint accepts (Ollama-specific,
  // not part of the OpenAI spec itself -- ignored by a genuine OpenAI-compat
  // backend). A model's architectural max context (e.g. gemma4:e4b's 128K)
  // is NOT what Ollama actually runs at by default -- num_ctx must be set
  // explicitly or Ollama truncates to its own small default regardless of
  // prompt size. Local/dev models only; the production frontier-model proxy
  // manages context server-side and this option has no effect there.
  numCtx?: number;
  // Ollama sampler overrides mitigating a confirmed upstream Gemma4 bug
  // (ollama/ollama#15502): long free-text generation under grammar-
  // constrained JSON output can enter a token-repetition collapse (a word
  // repeats until it fills the remaining token budget), corrupting the
  // JSON structure. repeat_penalty is NOT a working mitigation for this
  // model family -- Ollama's Go-native sampler silently ignores
  // repeat_penalty/frequency_penalty/presence_penalty entirely for it
  // (ollama/ollama#15783); only temperature/top_k/top_p/min_p are actually
  // implemented. topK/minP mirror Gemma4's own release-note-recommended
  // sampler settings, confirmed in the same issue thread to noticeably
  // reduce degenerate repetition on long generations. Both Ollama-specific,
  // same "harmless passthrough, ignored by a genuine OpenAI-compat backend"
  // contract as numCtx above.
  topK?: number;
  minP?: number;
  tools?: LlmToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  // Explicit `false` disables a reasoning-capable model's hidden chain-of-
  // thought (forwarded as OpenAI-compat `reasoning_effort: 'none'` -- see
  // openwebui.client.ts's doc comment for why this field, not a
  // `think`/`options.think` passthrough, is what Ollama's OpenAI-compat
  // endpoint actually honors). Confirmed live: a holistic section-analysis
  // call that only needs a structured JSON answer gained no measurable
  // benefit from thinking and cost 3-10x the wall-clock time. `true`/
  // omitted leaves the model's own default behavior untouched -- this is
  // an opt-out, not a blanket setting, so callers that DO want reasoning
  // (e.g. a user-facing chat turn) are unaffected.
  think?: boolean;
}

/**
 * Provider-agnostic LLM client, per docs/architecture.md §2c. base_url is
 * always config-driven — never hardcoded — so the same interface works
 * against Open WebUI or Ollama's own OpenAI-compatible endpoint
 * (http://localhost:11434/v1) unmodified. Every chat() call is redacted
 * first unless LLM_TRUSTED_LOCAL is set. embed()/vision() are declared here
 * to match the full interface shape from the architecture doc, but are not
 * implemented until Phase 6 (embeddings) / vision work is scheduled.
 */
// A reasoning/"thinking" model (qwen3.6 confirmed live) streams its
// chain-of-thought as a SEPARATE delta field from the final answer, not
// interleaved into `content` -- chat (unlike leveling/SURVEY calls, which
// pass `think: false` to skip reasoning outright, see LlmChatOptions.think)
// wants that reasoning surfaced live, since a real turn was confirmed live
// to spend most of its ~2 minutes in this phase with zero visible content
// deltas otherwise. `content`/`reasoning` are each optional per chunk (a
// given delta carries one or the other, sometimes neither on a keepalive).
export interface LlmStreamChunk {
  content?: string;
  reasoning?: string;
}

export interface LlmClient {
  chat(messages: ChatMessage[], opts?: LlmChatOptions): Promise<LlmChatResult>;
  listModels(): Promise<string[]>;
  streamChat(messages: ChatMessage[], opts?: LlmChatOptions): AsyncGenerator<LlmStreamChunk>;
  embed(texts: string[], opts?: { model?: string }): Promise<number[][]>;
  vision(prompt: string, images: Buffer[], opts?: { model?: string; mimeType?: string; responseSchema?: LlmResponseSchema }): Promise<string>;
}
