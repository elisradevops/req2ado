import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { llmChatRequestSchema } from './llm-chat.dto';
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
    const content = await this.llmClient.chat(
      body.messages,
      body.temperature !== undefined ? { temperature: body.temperature } : undefined,
    );
    return { content };
  }
}
