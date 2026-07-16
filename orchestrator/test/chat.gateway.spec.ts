import { ChatGateway } from '../src/modules/chat/chat.gateway';

function makeSocket() {
  return { readyState: 1, OPEN: 1, send: jest.fn(), close: jest.fn() };
}

describe('ChatGateway', () => {
  it('subscribes to chat:* on construction', () => {
    const subscriber = { psubscribe: jest.fn(), on: jest.fn() };
    new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);
    expect(subscriber.psubscribe).toHaveBeenCalledWith('chat:*');
  });

  it('relays a pmessage only to sockets in the matching room', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);

    const socketA = makeSocket();
    const socketB = makeSocket();
    gateway.handleConnection(socketA as any, { url: '/chat?jobId=job-1&localId=n0' } as any);
    gateway.handleConnection(socketB as any, { url: '/chat?jobId=job-1&localId=n1' } as any);

    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'Hi' }));

    expect(socketA.send).toHaveBeenCalledWith(JSON.stringify({ type: 'chunk', delta: 'Hi' }));
    expect(socketB.send).not.toHaveBeenCalled();
  });

  it('closes a connection missing jobId/localId query params', () => {
    const subscriber = { psubscribe: jest.fn(), on: jest.fn() };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);
    const socket = makeSocket();

    gateway.handleConnection(socket as any, { url: '/chat' } as any);

    expect(socket.close).toHaveBeenCalledWith(1008, 'jobId and localId are required');
  });

  it('removes a disconnected socket from its room so a later relay no longer reaches it', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    gateway.handleDisconnect(socket as any);
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'Hi' }));

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('calls chatService.persistAssistantTurn when a done event is relayed', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const persistAssistantTurn = jest.fn().mockResolvedValue(undefined);
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    const donePayload = { type: 'done', message: 'hi', proposedTitle: null, proposedDescription: null, model: 'llama3.1' };
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify(donePayload));

    expect(persistAssistantTurn).toHaveBeenCalledWith('chat:job-1:n0', donePayload);
  });

  it('does not call persistAssistantTurn for a chunk or error event', () => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const persistAssistantTurn = jest.fn();
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'chunk', delta: 'x' }));
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'error', reason: 'boom' }));

    expect(persistAssistantTurn).not.toHaveBeenCalled();
  });

  it('force-emits an error and clears the timer entry when a turn times out with no terminal event', () => {
    jest.useFakeTimers();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn() } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    gateway.startTurnTimeout('job-1', 'n0');
    jest.advanceTimersByTime(90_001);

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', reason: 'turn timed out' }));
    jest.useRealTimers();
  });

  it('does not fire the timeout after a done event already arrived', () => {
    jest.useFakeTimers();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const subscriber = { psubscribe: jest.fn(), on: jest.fn((event, cb) => (handlers[event] = cb)) };
    const gateway = new ChatGateway(subscriber as any, { persistAssistantTurn: jest.fn().mockResolvedValue(undefined) } as any);
    const socket = makeSocket();
    gateway.handleConnection(socket as any, { url: '/chat?jobId=job-1&localId=n0' } as any);

    gateway.startTurnTimeout('job-1', 'n0');
    handlers.pmessage('chat:*', 'chat:job-1:n0', JSON.stringify({ type: 'done', message: 'hi', proposedTitle: null, proposedDescription: null, model: 'llama3.1' }));
    socket.send.mockClear();
    jest.advanceTimersByTime(90_001);

    expect(socket.send).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
