import { ChatGateway } from '../src/modules/chat/chat.gateway';

const fakeSessionService = { validate: jest.fn().mockResolvedValue({ userId: 'test-user', displayName: 'Test User' }) };
const AUTHED_HEADERS = { cookie: 'req2ado_session=test-token' };

function makeSocket() {
  return { readyState: 1, OPEN: 1, send: jest.fn(), close: jest.fn() };
}

describe('ChatGateway', () => {
  it('subscribes to chat:* on construction', async () => {
    const subscriber = { psubscribe: jest.fn(), on: jest.fn() };
    new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any, fakeSessionService as any);
    expect(subscriber.psubscribe).toHaveBeenCalledWith('chat:*');
  });

  it('relays a pmessage only to sockets in the matching room', async () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any, fakeSessionService as any);

    const socketA = makeSocket();
    const socketB = makeSocket();
    await gateway.handleConnection(socketA as any, { url: '/chat?jobId=job-1&localId=n0', headers: AUTHED_HEADERS } as any);
    await gateway.handleConnection(socketB as any, { url: '/chat?jobId=job-1&localId=n1', headers: AUTHED_HEADERS } as any);

    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'Hi' }));

    expect(socketA.send).toHaveBeenCalledWith(JSON.stringify({ type: 'chunk', delta: 'Hi' }));
    expect(socketB.send).not.toHaveBeenCalled();
  });

  it('closes a connection missing jobId/localId query params', async () => {
    const subscriber = { psubscribe: jest.fn(), on: jest.fn() };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any, fakeSessionService as any);
    const socket = makeSocket();

    await gateway.handleConnection(socket as any, { url: '/chat', headers: AUTHED_HEADERS } as any);

    expect(socket.close).toHaveBeenCalledWith(1008, 'jobId and localId are required');
  });

  it('removes a disconnected socket from its room so a later relay no longer reaches it', async () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any, fakeSessionService as any);
    const socket = makeSocket();
    await gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0', headers: AUTHED_HEADERS } as any);

    gateway.handleDisconnect(socket as any);
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'Hi' }));

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('calls chatService.persistAssistantTurn when a done event is relayed', async () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const persistAssistantTurn = jest.fn().mockResolvedValue(undefined);
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn } as any, fakeSessionService as any);
    const socket = makeSocket();
    await gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0', headers: AUTHED_HEADERS } as any);

    const donePayload = { type: 'done', message: 'hi', proposedTitle: null, proposedDescription: null, model: 'llama3.1' };
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify(donePayload));

    expect(persistAssistantTurn).toHaveBeenCalledWith('chat:job-1:n0', donePayload);
  });

  it('does not call persistAssistantTurn for a chunk or error event', async () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const persistAssistantTurn = jest.fn();
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn } as any, fakeSessionService as any);
    const socket = makeSocket();
    await gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0', headers: AUTHED_HEADERS } as any);

    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'x' }));
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'error', reason: 'boom' }));

    expect(persistAssistantTurn).not.toHaveBeenCalled();
  });

  it('force-emits an error and clears the timer entry when a turn times out with no terminal event', async () => {
    jest.useFakeTimers();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any, fakeSessionService as any);
    const socket = makeSocket();
    await gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0', headers: AUTHED_HEADERS } as any);

    gateway.startTurnTimeout('job-1', 'n0');
    jest.advanceTimersByTime(150_001);

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', reason: 'turn timed out' }));
    jest.useRealTimers();
  });

  it('does not fire the timeout after a done event already arrived', async () => {
    jest.useFakeTimers();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn().mockResolvedValue(undefined) } as any, fakeSessionService as any);
    const socket = makeSocket();
    await gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0', headers: AUTHED_HEADERS } as any);

    gateway.startTurnTimeout('job-1', 'n0');
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'done', message: 'hi', proposedTitle: null, proposedDescription: null, model: 'llama3.1' }));
    socket.send.mockClear();
    jest.advanceTimersByTime(150_001);

    expect(socket.send).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('drops a real done event that arrives after the turn already timed out (no re-relay, no persist)', async () => {
    jest.useFakeTimers();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const persistAssistantTurn = jest.fn().mockResolvedValue(undefined);
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn } as any, fakeSessionService as any);
    const socket = makeSocket();
    await gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0', headers: AUTHED_HEADERS } as any);

    gateway.startTurnTimeout('job-1', 'n0');
    jest.advanceTimersByTime(150_001);
    socket.send.mockClear();

    // The real done event finally arrives from ingestion after the
    // synthetic timeout error already went out — it must be dropped.
    handlers.pmessage(
      'chat:*',
      'chat:job-1:n0',
      JSON.stringify({ type: 'done', message: 'late reply', proposedTitle: null, proposedDescription: null, model: 'llama3.1' }),
    );

    expect(socket.send).not.toHaveBeenCalled();
    expect(persistAssistantTurn).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('resets the timed-out marker for a channel when a new turn starts, so the next turn relays normally', async () => {
    jest.useFakeTimers();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const persistAssistantTurn = jest.fn().mockResolvedValue(undefined);
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn } as any, fakeSessionService as any);
    const socket = makeSocket();
    await gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0', headers: AUTHED_HEADERS } as any);

    // First turn times out.
    gateway.startTurnTimeout('job-1', 'n0');
    jest.advanceTimersByTime(150_001);
    socket.send.mockClear();

    // A fresh turn on the same item reuses the channel string.
    gateway.startTurnTimeout('job-1', 'n0');
    const donePayload = { type: 'done', message: 'hi again', proposedTitle: null, proposedDescription: null, model: 'llama3.1' };
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify(donePayload));

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify(donePayload));
    expect(persistAssistantTurn).toHaveBeenCalledWith('chat:job-1:n0', donePayload);
    jest.useRealTimers();
  });
});
