import { BadRequestException, Controller, Get, Optional, Param, Post, Body } from '@nestjs/common';
import { z } from 'zod';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { OpenWebUiClientFactory } from '../llm/openwebui-client.factory';
import { ModelHealthService } from '../llm/model-health.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';

const chatTurnRequestSchema = z.object({
  message: z.string().min(1),
  model: z.string().optional(),
});

@Controller()
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly clientFactory: OpenWebUiClientFactory,
    @Optional() private readonly modelHealth?: ModelHealthService,
  ) {}

  // Filtered through listSelectableModels() (base models only, see B2's own
  // doc comment on that method) but kept on the pre-existing {models:
  // string[]} wire shape -- this picker only ever needed model ids, and
  // changing the shape would require an unrelated frontend rewrite outside
  // this fix's scope.
  @Get('chat/models')
  async models(@CurrentUser() user: SessionUser): Promise<{ models: string[] }> {
    const client = await this.clientFactory.getClientFor(user.userId);
    const models = await client.listSelectableModels();
    // The same filter as the job picker (models automatic health has found failing are not offered).
    const visible = (await this.modelHealth?.filterVisible(user.userId, models)) ?? models;
    return { models: visible.map((m) => m.id) };
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
