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
    });

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [jobId, localId, enabled]);
}
