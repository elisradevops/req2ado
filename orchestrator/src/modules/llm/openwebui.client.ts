import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { LlmClient } from './llm-client.interface';
import { redactMessages, redactText, type ChatMessage } from './redactor';

export interface OpenWebUiClientConfig {
  LLM_BASE_URL: string;
  LLM_API_KEY?: string;
  LLM_CHAT_MODEL: string;
  LLM_TRUSTED_LOCAL: boolean;
  EMBED_TRANSPORT: 'ollama' | 'openai';
  EMBED_BASE_URL?: string;
  EMBED_MODEL: string;
  EMBED_PATH: string;
}

@Injectable()
export class OpenWebUiClient implements LlmClient {
  private readonly openai: OpenAI;

  constructor(private readonly config: OpenWebUiClientConfig) {
    this.openai = new OpenAI({
      baseURL: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY ?? 'unused',
    });
  }

  async chat(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): Promise<string> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    const response = await this.openai.chat.completions.create({
      model: opts?.model ?? this.config.LLM_CHAT_MODEL,
      messages: outboundMessages,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });
    return response.choices[0]?.message?.content ?? '';
  }

  async embed(texts: string[], opts?: { model?: string }): Promise<number[][]> {
    if (this.config.EMBED_TRANSPORT !== 'ollama') {
      throw new Error(
        `OpenWebUiClient.embed() not implemented for EMBED_TRANSPORT=${this.config.EMBED_TRANSPORT} — only 'ollama' (the confirmed-real Open WebUI/Ollama transport) is implemented`,
      );
    }
    const outboundTexts = this.config.LLM_TRUSTED_LOCAL ? texts : texts.map(redactText);
    const baseUrl = (this.config.EMBED_BASE_URL ?? this.config.LLM_BASE_URL).replace(/\/v1\/?$/, '');
    const response = await fetch(`${baseUrl}${this.config.EMBED_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts?.model ?? this.config.EMBED_MODEL, input: outboundTexts }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed request failed: ${response.status}`);
    }
    const body = (await response.json()) as { embeddings: number[][] };
    return body.embeddings;
  }

  async vision(_prompt: string, _images: Buffer[], _opts?: { model?: string }): Promise<string> {
    throw new Error('OpenWebUiClient.vision() not implemented — out of scope for the current phased plan');
  }
}
