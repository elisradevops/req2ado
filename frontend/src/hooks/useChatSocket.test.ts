import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useChatSocket, toWsUrl, type StreamEvent } from './useChatSocket';
import { loadRuntimeConfig } from '../api/config';

vi.mock('../api/config');

// A minimal fake WebSocket -- real jsdom has no WebSocket implementation,
// and no test in this codebase mocks one yet. Only implements what
// useChatSocket actually touches (onmessage/onclose assignment + close()),
// plus a way for the test itself to trigger those handlers.
class FakeWebSocket {
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closedByClient = false;
  close(): void {
    this.closedByClient = true;
    this.onclose?.();
  }
}

describe('useChatSocket', () => {
  let sockets: FakeWebSocket[];

  beforeEach(() => {
    sockets = [];
    vi.mocked(loadRuntimeConfig).mockResolvedValue({ apiBaseUrl: 'http://localhost:30001' });
    vi.stubGlobal(
      'WebSocket',
      vi.fn().mockImplementation(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      }),
    );
  });

  it('builds a ws:// url from an http:// apiBaseUrl', () => {
    expect(toWsUrl('http://localhost:30001')).toBe('ws://localhost:30001/chat');
  });

  it('builds a wss:// url from an https:// apiBaseUrl', () => {
    expect(toWsUrl('https://example.com')).toBe('wss://example.com/chat');
  });

  it('does not synthesize an error event when the socket closes on unmount (intentional close)', async () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() => useChatSocket('job-1', 'n0', onEvent));
    await waitFor(() => expect(sockets).toHaveLength(1));

    unmount();

    expect(sockets[0].closedByClient).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('synthesizes an error StreamEvent when the socket closes unexpectedly (not via cleanup)', async () => {
    // Previously unhandled entirely -- an unexpected close left ChatPanel's
    // isStreaming stuck true forever, with no way for the user to recover
    // short of a full page reload.
    const onEvent = vi.fn();
    renderHook(() => useChatSocket('job-1', 'n0', onEvent));
    await waitFor(() => expect(sockets).toHaveLength(1));

    act(() => {
      sockets[0].onclose?.();
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' } satisfies Partial<StreamEvent>),
    );
  });

  it('never connects at all when disabled', async () => {
    const onEvent = vi.fn();
    renderHook(() => useChatSocket('job-1', 'n0', onEvent, false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(0);
  });
});
