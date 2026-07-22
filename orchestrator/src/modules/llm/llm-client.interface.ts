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
  responseSchema?: LlmResponseSchema;
  // Caps output length (forwarded as OpenAI-compat `max_tokens`, which
  // Ollama maps to its own `num_predict`). Bounds worst-case latency for a
  // reasoning/"thinking" model that can otherwise generate an unbounded
  // chain-of-thought trace before its answer -- observed live: qwen3:4b
  // generated ~87% hidden reasoning tokens per call, with generation
  // throughput itself degrading as context grows, producing 40+ minute
  // calls with no cap in place. Does not fix verbosity, only bounds it.
  maxTokens?: number;
  tools?: LlmToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
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
export interface LlmClient {
  chat(messages: ChatMessage[], opts?: LlmChatOptions): Promise<LlmChatResult>;
  listModels(): Promise<string[]>;
  streamChat(messages: ChatMessage[], opts?: LlmChatOptions): AsyncGenerator<string>;
  embed(texts: string[], opts?: { model?: string }): Promise<number[][]>;
  vision(prompt: string, images: Buffer[], opts?: { model?: string }): Promise<string>;
}
