import { BadRequestException, Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { llmChatRequestSchema } from './llm-chat.dto';
import { llmEmbedRequestSchema } from './llm-embed.dto';
import { LlmProxyBearerGuard } from './llm-proxy-bearer.guard';
import { OpenWebUiClient } from './openwebui.client';

@Controller('llm')
@UseGuards(LlmProxyBearerGuard)
export class LlmController {
  constructor(private readonly llmClient: OpenWebUiClient) {}

  @Post('chat')
  async chat(@Body() rawBody: unknown): Promise<{ content: string }> {
    const parseResult = llmChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: messages must be a non-empty array');
    }
    const body = parseResult.data;
    const content = await this.llmClient.chat(body.messages, {
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    });
    return { content };
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
      for await (const delta of this.llmClient.streamChat(body.messages, {
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      })) {
        res.write(`${JSON.stringify({ delta })}\n`);
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
}
