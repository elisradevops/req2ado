import { useEffect, useRef } from 'react';
import { loadRuntimeConfig } from '../api/config';

export interface StreamEvent {
  type: 'chunk' | 'reasoning_chunk' | 'done' | 'error';
  delta?: string;
  message?: string;
  proposedTitle?: string | null;
  proposedDescription?: string | null;
  model?: string;
  reason?: string;
}

export function toWsUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/chat';
  url.search = '';
  return url.toString();
}

export function useChatSocket(
  jobId: string,
  localId: string,
  onEvent: (event: StreamEvent) => void,
  enabled = true,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | undefined;

    // Skip connecting entirely when disabled (e.g. reuse/dedup_skip/excluded
    // nodes) so no live WebSocket is ever opened for chat-inert entries.
    if (!enabled) return () => {};

    loadRuntimeConfig().then((config) => {
      if (cancelled) return;
      const wsUrl = `${toWsUrl(config.apiBaseUrl)}?jobId=${encodeURIComponent(jobId)}&localId=${encodeURIComponent(localId)}`;
      socket = new WebSocket(wsUrl);
      socket.onmessage = (event) => {
        const parsed = JSON.parse(event.data as string) as StreamEvent;
        onEventRef.current(parsed);
      };
      // Previously unhandled entirely -- a dropped connection mid-stream
      // (network hiccup, server restart) left ChatPanel's isStreaming stuck
      // true forever: the only server-side recovery (the orchestrator's
      // turn timeout) fires into the Redis channel, not this already-closed
      // socket, so it can never reach the client. `cancelled` is already
      // set true by this effect's own cleanup BEFORE it calls socket.close()
      // (see below), so a real unmount/dep-change close is silently skipped
      // here -- only a genuinely unexpected close synthesizes an 'error'
      // event, reusing ChatPanel's existing error-handling path verbatim
      // (resets isStreaming, shows a toast) rather than adding a second one.
      socket.onclose = () => {
        if (cancelled) return;
        onEventRef.current({ type: 'error', reason: 'Connection to the server was lost.' });
      };
    });

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [jobId, localId, enabled]);
}
