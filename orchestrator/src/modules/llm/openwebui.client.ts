import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { LlmClient } from './llm-client.interface';
import { redactMessages, type ChatMessage } from './redactor';

export interface OpenWebUiClientConfig {
  LLM_BASE_URL: string;
  LLM_API_KEY?: string;
  LLM_CHAT_MODEL: string;
  LLM_TRUSTED_LOCAL: boolean;
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

  async embed(_texts: string[], _opts?: { model?: string }): Promise<number[][]> {
    throw new Error('OpenWebUiClient.embed() not implemented — see Phase 6 (dedup/embeddings)');
  }

  async vision(_prompt: string, _images: Buffer[], _opts?: { model?: string }): Promise<string> {
    throw new Error('OpenWebUiClient.vision() not implemented — out of scope for the current phased plan');
  }
}
