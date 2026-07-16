import { BadRequestException, Controller, Get, Param, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { OpenWebUiClient } from '../llm/openwebui.client';

const chatTurnRequestSchema = z.object({
  message: z.string().min(1),
  model: z.string().optional(),
});

@Controller()
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly llmClient: OpenWebUiClient,
  ) {}

  @Get('chat/models')
  async models(): Promise<{ models: string[] }> {
    return { models: await this.llmClient.listModels() };
  }

  @Post('jobs/:jobId/diff/:localId/chat')
  async sendTurn(
    @Param('jobId') jobId: string,
    @Param('localId') localId: string,
    @Body() rawBody: unknown,
  ): Promise<{ status: string }> {
    const parseResult = chatTurnRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: message is required');
    }
    const body = parseResult.data;
    await this.chatService.sendTurn(jobId, localId, body.message, body.model);
    this.chatGateway.startTurnTimeout(jobId, localId);
    return { status: 'started' };
  }

  @Get('jobs/:jobId/diff/:localId/chat')
  async getHistory(
    @Param('jobId') jobId: string,
    @Param('localId') localId: string,
  ): Promise<{ messages: Awaited<ReturnType<ChatService['getHistory']>> }> {
    return { messages: await this.chatService.getHistory(jobId, localId) };
  }

  @Post('jobs/:jobId/diff/:localId/chat/stop')
  async stop(@Param('jobId') jobId: string, @Param('localId') localId: string): Promise<{ status: string }> {
    await this.chatService.stopTurn(jobId, localId);
    return { status: 'stopping' };
  }
}
