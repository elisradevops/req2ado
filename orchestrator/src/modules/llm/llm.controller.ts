import { BadRequestException, Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { llmChatRequestSchema } from './llm-chat.dto';
import { llmEmbedRequestSchema } from './llm-embed.dto';
import { llmVisionRequestSchema } from './llm-vision.dto';
import type { LlmToolCall } from './llm-client.interface';
import { LlmProxyBearerGuard } from './llm-proxy-bearer.guard';
import { OpenWebUiClient } from './openwebui.client';
import { Public } from '../auth/public.decorator';

// Every route here is internal service-to-service traffic already gated by
// LlmProxyBearerGuard (ingestion's shared bearer token), not public traffic
// -- the global ThrottlerGuard (app.module.ts, 200 req/60s) was never meant
// to rate-limit it. The agentic SURVEY redesign's query_kb tool-calling loop
// (see ingestion/app/survey/orchestrator_llm_client.py) can fire several
// /llm/embed calls per branch, making throttle pressure here newly likely,
// not just theoretical.
// @Public(): this is bearer-guarded service-to-service traffic (ingestion
// calling in), not a browser session -- the global session AuthGuard
// (app.module.ts) must not also demand a cookie here.
@SkipThrottle()
@Public()
@Controller('llm')
@UseGuards(LlmProxyBearerGuard)
export class LlmController {
  constructor(private readonly llmClient: OpenWebUiClient) {}

  @Post('chat')
  async chat(@Body() rawBody: unknown): Promise<{ content: string; toolCalls?: LlmToolCall[]; finishReason?: string }> {
    const parseResult = llmChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: messages must be a non-empty array');
    }
    const body = parseResult.data;
    const result = await this.llmClient.chat(body.messages, {
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.responseSchema !== undefined ? { responseSchema: body.responseSchema } : {}),
      ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
      ...(body.numCtx !== undefined ? { numCtx: body.numCtx } : {}),
      ...(body.topK !== undefined ? { topK: body.topK } : {}),
      ...(body.minP !== undefined ? { minP: body.minP } : {}),
      ...(body.tools !== undefined ? { tools: body.tools } : {}),
      ...(body.toolChoice !== undefined ? { toolChoice: body.toolChoice } : {}),
      ...(body.think !== undefined ? { think: body.think } : {}),
    });
    return result;
  }

  @Post('chat/stream')
  async chatStream(@Body() rawBody: unknown, @Res() res: Response): Promise<void> {
    const parseResult = llmChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: messages must be a non-empty array');
    }
    const body = parseResult.data;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    // "Stop generating" support: when the downstream caller (ingestion)
    // aborts and closes its httpx connection to this endpoint, Express fires
    // 'close' on the response. Without this, the loop below kept iterating
    // this.llmClient.streamChat() to completion regardless, so the upstream
    // Ollama/Open WebUI generation kept running and burning compute after
    // nobody was reading the tokens. Checking the flag right after each
    // write stops consuming/writing further chunks as soon as the current
    // await resolves — the best granularity available without deeper
    // OpenAI SDK abort-signal plumbing (out of scope here), since it can't
    // instantly abort a stream mid-network-call.
    let clientDisconnected = false;
    res.on('close', () => {
      clientDisconnected = true;
    });
    try {
      for await (const chunk of this.llmClient.streamChat(body.messages, {
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.responseSchema !== undefined ? { responseSchema: body.responseSchema } : {}),
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
      })) {
        // `delta` stays the wire name for final-answer content (backward
        // compatible with every existing consumer); `reasoningDelta` is new,
        // additive, and only present on a reasoning-model chunk.
        res.write(`${JSON.stringify({ ...(chunk.content ? { delta: chunk.content } : {}), ...(chunk.reasoning ? { reasoningDelta: chunk.reasoning } : {}) })}\n`);
        if (clientDisconnected) break;
      }
    } finally {
      res.end();
    }
  }

  @Get('models')
  async models(): Promise<{ models: string[] }> {
    const models = await this.llmClient.listModels();
    return { models };
  }

  @Post('embed')
  async embed(@Body() rawBody: unknown): Promise<{ embeddings: number[][] }> {
    const parseResult = llmEmbedRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: texts must be a non-empty array of strings');
    }
    const embeddings = await this.llmClient.embed(parseResult.data.texts);
    return { embeddings };
  }

  @Post('vision')
  async vision(@Body() rawBody: unknown): Promise<{ description: string }> {
    const parseResult = llmVisionRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: prompt and a non-empty images array (base64) are required');
    }
    const body = parseResult.data;
    const opts =
      body.model !== undefined || body.mimeType !== undefined
        ? {
            ...(body.model !== undefined ? { model: body.model } : {}),
            ...(body.mimeType !== undefined ? { mimeType: body.mimeType } : {}),
          }
        : undefined;
    const description = await this.llmClient.vision(body.prompt, body.images.map((image) => Buffer.from(image, 'base64')), opts);
    return { description };
  }
}
