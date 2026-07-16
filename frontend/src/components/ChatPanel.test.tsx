import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toWsUrl } from '../hooks/useChatSocket';
import { ChatPanel } from './ChatPanel';
import { ToastProvider } from './ToastProvider';
import * as chatApi from '../api/chat';

vi.mock('../api/chat');
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

import { useChatSocket } from '../hooks/useChatSocket';

describe('toWsUrl', () => {
  it('swaps http for ws and sets the /chat path', () => {
    expect(toWsUrl('http://localhost:3001')).toBe('ws://localhost:3001/chat');
  });

  it('swaps https for wss', () => {
    expect(toWsUrl('https://api.example.com')).toBe('wss://api.example.com/chat');
  });
});

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue(['llama3.1', 'qwen2.5:14b']);
    vi.mocked(chatApi.sendChatTurn).mockResolvedValue(undefined);
    vi.mocked(chatApi.stopChatTurn).mockResolvedValue(undefined);
    vi.mocked(useChatSocket).mockImplementation(() => undefined);
  });

  it('renders a disabled message when disabled=true, without calling any chat API', async () => {
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.getByText(/chat is unavailable/i)).toBeInTheDocument();
    expect(chatApi.getChatHistory).not.toHaveBeenCalled();
  });

  it('loads history and models on mount', async () => {
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([
      { id: '1', role: 'user', content: 'hi', proposedTitle: null, proposedDescription: null, model: null, createdAt: '2026-01-01' },
    ]);
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText('hi')).toBeInTheDocument());
    expect(screen.getByText('llama3.1')).toBeInTheDocument();
  });

  it('sends a message and appends it to history optimistically', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const input = await screen.findByPlaceholderText(/ask the assistant/i);
    await user.type(input, 'make this testable');
    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(chatApi.sendChatTurn).toHaveBeenCalledWith('job-1', 'n0', 'make this testable', undefined);
    await waitFor(() => expect(screen.getByText('make this testable')).toBeInTheDocument());
  });

  it('renders a proposal with Accept/Reject when the WS done event includes one, and Accept calls onAcceptProposal', async () => {
    let capturedOnEvent: ((event: import('../hooks/useChatSocket').StreamEvent) => void) | undefined;
    vi.mocked(useChatSocket).mockImplementation((_jobId, _localId, onEvent) => {
      capturedOnEvent = onEvent;
    });
    const onAcceptProposal = vi.fn();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={onAcceptProposal} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);

    capturedOnEvent?.({
      type: 'done',
      message: 'Here you go',
      proposedTitle: 'New title',
      proposedDescription: null,
      model: 'llama3.1',
    });

    const user = userEvent.setup();
    await screen.findByText('New title');
    await user.click(screen.getByRole('button', { name: /accept/i }));

    expect(onAcceptProposal).toHaveBeenCalledWith({ title: 'New title', description: undefined });
  });

  it('shows an error toast and stops the typing indicator on a WS error event', async () => {
    let capturedOnEvent: ((event: import('../hooks/useChatSocket').StreamEvent) => void) | undefined;
    vi.mocked(useChatSocket).mockImplementation((_jobId, _localId, onEvent) => {
      capturedOnEvent = onEvent;
    });
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);

    capturedOnEvent?.({ type: 'error', reason: 'LLM unreachable' });

    await waitFor(() => expect(screen.getByText(/reply failed/i)).toBeInTheDocument());
  });

  it('calls stopChatTurn when Stop generating is clicked while streaming', async () => {
    let capturedOnEvent: ((event: import('../hooks/useChatSocket').StreamEvent) => void) | undefined;
    vi.mocked(useChatSocket).mockImplementation((_jobId, _localId, onEvent) => {
      capturedOnEvent = onEvent;
    });
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const input = await screen.findByPlaceholderText(/ask the assistant/i);
    await user.type(input, 'hi{Enter}');
    capturedOnEvent?.({ type: 'chunk', delta: 'thinking' });

    await user.click(screen.getByRole('button', { name: /stop generating/i }));
    expect(chatApi.stopChatTurn).toHaveBeenCalledWith('job-1', 'n0');
  });

  it('clears a still-pending proposal when the selected node changes, so it can never be accepted onto the new node', async () => {
    let capturedOnEvent: ((event: import('../hooks/useChatSocket').StreamEvent) => void) | undefined;
    vi.mocked(useChatSocket).mockImplementation((_jobId, _localId, onEvent) => {
      capturedOnEvent = onEvent;
    });
    const onAcceptProposal = vi.fn();
    const { rerender } = render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={onAcceptProposal} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);

    capturedOnEvent?.({
      type: 'done',
      message: 'Here you go',
      proposedTitle: 'New title',
      proposedDescription: null,
      model: 'llama3.1',
    });
    await screen.findByText('New title');

    rerender(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n1" disabled={false} onAcceptProposal={onAcceptProposal} />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.queryByText('New title')).not.toBeInTheDocument());
    expect(onAcceptProposal).not.toHaveBeenCalled();
  });

  it('gates useChatSocket to not connect when disabled=true', async () => {
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    expect(useChatSocket).toHaveBeenCalledWith('job-1', 'n0', expect.any(Function), false);
  });
});
