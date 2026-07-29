import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type Redis from 'ioredis';
import { ChatService } from './chat.service';
import { SessionService } from '../auth/session.service';
import { SESSION_COOKIE_NAME } from '../auth/session.constants';

// The WS upgrade request bypasses Express middleware entirely (`ws`
// listens on the HTTP server's raw 'upgrade' event, not through Express's
// request pipeline) -- cookie-parser's req.cookies is never populated
// here, so the session cookie has to be parsed out of the raw Cookie
// header by hand.
function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === SESSION_COOKIE_NAME) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}

// Must stay strictly greater than ingestion's own stream timeout
// (_STREAM_REQUEST_TIMEOUT_SECONDS = 120s in chat_client.py) — otherwise a
// legitimately slow (but still in-flight) reply gets force-timed-out here
// before ingestion's real done/error event ever arrives.
const TURN_TIMEOUT_MS = 150_000;

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
  // Channels whose turn timeout already fired a synthetic error. A real
  // done/error that arrives afterward (e.g. a legitimately slow reply that
  // still beat ingestion's own stream timeout) must be dropped rather than
  // relayed/persisted, so the user isn't shown a late "success" after
  // already being told the turn failed.
  private readonly timedOutChannels = new Set<string>();

  constructor(
    @Inject('CHAT_REDIS_SUBSCRIBER') private readonly subscriber: Redis,
    private readonly chatService: ChatService,
    private readonly sessionService: SessionService,
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

  async handleConnection(client: ChatSocket, request: { url?: string; headers?: Record<string, string | string[] | undefined> }): Promise<void> {
    // The cookie is what makes this handshake authenticable at all -- a
    // WebSocket handshake can't carry a bearer header the way a normal
    // fetch can, but it does send cookies (same-origin, browser-native).
    const cookieHeader = request.headers?.cookie;
    const token = readSessionCookie(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader);
    const user = token ? await this.sessionService.validate(token) : null;
    if (!user) {
      client.close(1008, 'Not signed in');
      return;
    }

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
    if (this.timedOutChannels.has(channel)) return;

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
    // A fresh turn on the same item reuses this channel string — reset the
    // "already timed out" marker from any prior turn before arming the timer.
    this.timedOutChannels.delete(channel);
    const timer = setTimeout(() => {
      // Relay the synthetic error first — it must still reach the socket —
      // then mark the channel so a real done/error arriving afterward is
      // dropped instead of being relayed/persisted on top of it.
      this.relay(channel, JSON.stringify({ type: 'error', reason: 'turn timed out' }));
      this.timedOutChannels.add(channel);
    }, TURN_TIMEOUT_MS);
    this.channelTimers.set(channel, timer);
  }

  onModuleDestroy(): void {
    this.subscriber.disconnect();
  }
}
