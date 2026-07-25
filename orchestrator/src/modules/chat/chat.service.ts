import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import axios from 'axios';

const CHAT_HISTORY_LIMIT = 50;

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  model: string | null;
  createdAt: Date;
}

interface DoneEventPayload {
  message: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  model: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingestionBaseUrl: string,
    private readonly redis: Redis,
  ) {}

  async sendTurn(jobId: string, localId: string, message: string, model: string | undefined): Promise<void> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${jobId} is not in diff_ready status`);
    }
    const diff = (job.dryRunDiff as any[] | null) ?? [];
    const entry = diff.find((e) => e.localId === localId);
    if (!entry) throw new NotFoundException(`Diff entry ${localId} not found`);
    if (entry.action !== 'create' || entry.excluded) {
      throw new ConflictException(
        `Diff entry ${localId} is not chattable (action=${entry.action}, excluded=${!!entry.excluded})`,
      );
    }

    await this.prisma.chatMessage.create({
      data: { jobId, localId, role: 'user', content: message, model: model ?? null },
    });

    const history = await this.prisma.chatMessage.findMany({
      where: { jobId, localId },
      orderBy: { createdAt: 'asc' },
      take: CHAT_HISTORY_LIMIT,
    });

    const payload = {
      item: {
        type: entry.type,
        title: entry.title,
        description: entry.description,
        childType: entry.childType ?? null,
        qualityIssues: entry.qualityIssues ?? [],
      },
      history: history.map((h: { role: string; content: string }) => ({ role: h.role, content: h.content })),
      message,
      model: model ?? null,
      // Knowledge Base scope key -- the job's submitting user's identity,
      // NOT job.areaPath (ADO destination, unrelated concern here).
      user_id: job.userId,
    };

    // Fire-and-forget: the caller gets an immediate ack; the actual reply
    // streams over the WS relay this same call kicks off server-side in
    // ingestion. Never await the full turn here — it can take tens of
    // seconds and the REST response's only job is "the turn started".
    void axios
      .post(`${this.ingestionBaseUrl}/chat/${jobId}/${localId}/turn`, payload)
      .catch((err) => this.logger.error(`ingestion chat turn call failed: ${err}`));
  }

  async getHistory(jobId: string, localId: string): Promise<ChatMessageDto[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { jobId, localId },
      orderBy: { createdAt: 'asc' },
      take: CHAT_HISTORY_LIMIT,
    });
    return rows.map((r: any) => ({
      id: r.id,
      role: r.role as 'user' | 'assistant',
      content: r.content,
      proposedTitle: r.proposedTitle,
      proposedDescription: r.proposedDescription,
      model: r.model,
      createdAt: r.createdAt,
    }));
  }

  async stopTurn(jobId: string, localId: string): Promise<void> {
    await this.redis.set(`chat:abort:${jobId}:${localId}`, '1', 'EX', 30);
  }

  async persistAssistantTurn(channel: string, payload: DoneEventPayload): Promise<void> {
    const [, jobId, localId] = channel.split(':');
    await this.prisma.chatMessage.create({
      data: {
        jobId,
        localId,
        role: 'assistant',
        content: payload.message,
        proposedTitle: payload.proposedTitle,
        proposedDescription: payload.proposedDescription,
        model: payload.model || null,
      },
    });
  }
}
