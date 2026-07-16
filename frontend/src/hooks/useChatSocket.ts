import { useEffect, useRef } from 'react';
import { loadRuntimeConfig } from '../api/config';

export interface StreamEvent {
  type: 'chunk' | 'done' | 'error';
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

export function useChatSocket(jobId: string, localId: string, onEvent: (event: StreamEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | undefined;

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
  }, [jobId, localId]);
}
