import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type Redis from 'ioredis';
import type { ChatService } from './chat.service';

const TURN_TIMEOUT_MS = 90_000;

interface ChatSocket {
  readyState: number;
  OPEN: number;
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
  jobId?: string;
  localId?: string;
}

interface DoneEvent {
  type: 'done';
  message: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  model: string;
}

@Injectable()
@WebSocketGateway({ path: '/chat' })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(ChatGateway.name);
  private readonly rooms = new Map<string, Set<ChatSocket>>();
  private readonly channelTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly subscriber: Redis,
    private readonly chatService: ChatService,
  ) {
    // Single shared subscriber for ALL open chats (pattern-subscribe), not
    // one dedicated Redis connection per open chat — deliberate deviation
    // from the SSE precedent (job-events.controller.ts), see
    // docs/superpowers/specs/2026-07-15-p3b-ai-assist-chat-design.md §6.
    this.subscriber.psubscribe('chat:*');
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      this.relay(channel, message);
    });
  }

  handleConnection(client: ChatSocket, request: { url?: string }): void {
    const url = new URL(request.url ?? '', 'http://localhost');
    const jobId = url.searchParams.get('jobId');
    const localId = url.searchParams.get('localId');
    if (!jobId || !localId) {
      client.close(1008, 'jobId and localId are required');
      return;
    }
    client.jobId = jobId;
    client.localId = localId;
    const channel = `chat:${jobId}:${localId}`;
    if (!this.rooms.has(channel)) this.rooms.set(channel, new Set());
    this.rooms.get(channel)!.add(client);
  }

  handleDisconnect(client: ChatSocket): void {
    if (!client.jobId || !client.localId) return;
    const channel = `chat:${client.jobId}:${client.localId}`;
    const room = this.rooms.get(channel);
    room?.delete(client);
    if (room && room.size === 0) this.rooms.delete(channel);
  }

  private relay(channel: string, message: string): void {
    const sockets = this.rooms.get(channel);
    if (sockets) {
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(message);
      }
    }

    let parsed: { type: string };
    try {
      parsed = JSON.parse(message) as { type: string };
    } catch {
      return;
    }

    if (parsed.type === 'done' || parsed.type === 'error') {
      const timer = this.channelTimers.get(channel);
      if (timer) {
        clearTimeout(timer);
        this.channelTimers.delete(channel);
      }
    }
    if (parsed.type === 'done') {
      void this.chatService.persistAssistantTurn(channel, parsed as unknown as DoneEvent).catch((err) => {
        this.logger.error(`failed to persist assistant turn for ${channel}: ${err}`);
      });
    }
  }

  /** Called by ChatController.sendTurn right after kicking off the
   * ingestion call — force-emits an error and drops bookkeeping if no
   * done/error event ever arrives (ingestion process killed mid-turn). */
  startTurnTimeout(jobId: string, localId: string): void {
    const channel = `chat:${jobId}:${localId}`;
    const timer = setTimeout(() => {
      this.relay(channel, JSON.stringify({ type: 'error', reason: 'turn timed out' }));
    }, TURN_TIMEOUT_MS);
    this.channelTimers.set(channel, timer);
  }

  onModuleDestroy(): void {
    this.subscriber.disconnect();
  }
}
