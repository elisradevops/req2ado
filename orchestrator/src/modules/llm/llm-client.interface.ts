import type { ChatMessage } from './redactor';

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
  chat(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): Promise<string>;
  listModels(): Promise<string[]>;
  streamChat(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): AsyncGenerator<string>;
  embed(texts: string[], opts?: { model?: string }): Promise<number[][]>;
  vision(prompt: string, images: Buffer[], opts?: { model?: string }): Promise<string>;
}
