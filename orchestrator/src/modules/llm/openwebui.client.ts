import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { LlmChatOptions, LlmChatResult, LlmClient } from './llm-client.interface';
import { redactMessages, redactText, type ChatMessage } from './redactor';

function buildResponseFormat(opts: LlmChatOptions | undefined, includeSchema: boolean): OpenAI.ResponseFormatJSONSchema | undefined {
  if (!includeSchema || !opts?.responseSchema) return undefined;
  return {
    type: 'json_schema',
    json_schema: { name: opts.responseSchema.name, schema: opts.responseSchema.schema },
  };
}

// Ollama version in use is not pinned anywhere in this codebase -- structured
// output (response_format: json_schema) support can't be statically
// guaranteed. Rather than hard-failing a job over a backend that doesn't
// support it, degrade once to a schema-less retry on the specific
// status codes an unsupported/malformed response_format would produce.
function isSchemaRejection(err: unknown): boolean {
  return err instanceof OpenAI.APIError && (err.status === 400 || err.status === 422);
}

export interface OpenWebUiClientConfig {
  LLM_BASE_URL: string;
  LLM_API_KEY?: string;
  LLM_CHAT_MODEL: string;
  LLM_VISION_MODEL?: string;
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

  async chat(messages: ChatMessage[], opts?: LlmChatOptions): Promise<LlmChatResult> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    const buildParams = (includeSchema: boolean) => ({
      model: opts?.model ?? this.config.LLM_CHAT_MODEL,
      messages: outboundMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(buildResponseFormat(opts, includeSchema) ? { response_format: buildResponseFormat(opts, includeSchema) } : {}),
      // Ollama maps OpenAI-compat max_tokens -> its own num_predict. Bounds
      // worst-case latency for a reasoning model's otherwise-unbounded
      // chain-of-thought + answer (see LlmChatOptions.maxTokens doc comment).
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts?.tools !== undefined ? { tools: opts.tools as OpenAI.Chat.ChatCompletionTool[] } : {}),
      ...(opts?.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
    });
    const toResult = (response: OpenAI.Chat.ChatCompletion): LlmChatResult => ({
      content: response.choices[0]?.message?.content ?? '',
      toolCalls: response.choices[0]?.message?.tool_calls as LlmChatResult['toolCalls'],
      finishReason: response.choices[0]?.finish_reason,
    });
    try {
      const response = await this.openai.chat.completions.create(buildParams(true));
      return toResult(response);
    } catch (err) {
      if (opts?.responseSchema && isSchemaRejection(err)) {
        const response = await this.openai.chat.completions.create(buildParams(false));
        return toResult(response);
      }
      throw err;
    }
  }

  async listModels(): Promise<string[]> {
    const page = await this.openai.models.list();
    return page.data.map((m) => m.id);
  }

  async *streamChat(messages: ChatMessage[], opts?: LlmChatOptions): AsyncGenerator<string> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    const buildParams = (includeSchema: boolean) => ({
      model: opts?.model ?? this.config.LLM_CHAT_MODEL,
      messages: outboundMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true as const,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(buildResponseFormat(opts, includeSchema) ? { response_format: buildResponseFormat(opts, includeSchema) } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    });
    let stream;
    try {
      stream = await this.openai.chat.completions.create(buildParams(true));
    } catch (err) {
      if (opts?.responseSchema && isSchemaRejection(err)) {
        stream = await this.openai.chat.completions.create(buildParams(false));
      } else {
        throw err;
      }
    }
    for await (const chunk of stream as AsyncIterable<{ choices: { delta?: { content?: string } }[] }>) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
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

  async vision(prompt: string, images: Buffer[], opts?: { model?: string }): Promise<string> {
    const model = opts?.model ?? this.config.LLM_VISION_MODEL;
    if (!model) {
      throw new Error('vision() called with no model available -- set LLM_VISION_MODEL or pass opts.model');
    }
    // Same OpenAI-compatible chat.completions endpoint as chat(), just with
    // a multimodal content array -- Ollama/Open WebUI's OpenAI-compat API
    // accepts image_url content parts for vision-capable models (llava,
    // bakllava, moondream, etc.) the same way OpenAI's own API does.
    const outboundPrompt = this.config.LLM_TRUSTED_LOCAL ? prompt : redactText(prompt);
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: outboundPrompt },
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: `data:image/png;base64,${image.toString('base64')}` },
      })),
    ];
    const response = await this.openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content }],
    });
    return response.choices[0]?.message?.content ?? '';
  }
}
