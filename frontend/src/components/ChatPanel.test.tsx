import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError } from 'axios';
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
    // Clear accumulated mock call history between tests -- mockResolvedValue
    // alone doesn't reset call counts, only the resolved value for
    // subsequent calls. Only surfaced once a test asserted an ABSOLUTE call
    // count (see the suggest-title in-flight-guard test below); same bug
    // class NodeDetailPanel.test.tsx already documents and fixes this way.
    vi.clearAllMocks();
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

  it('shows an inviting empty state before any history exists, not a blank scroll region (CR-9 Take C: a fake opening Assistant turn, not a graphic)', async () => {
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    expect(await screen.findByText(/i have read this requirement/i)).toBeInTheDocument();
  });

  it('renders an assistant reply\'s markdown (e.g. **bold**) as real formatting, not literal asterisks', async () => {
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([
      {
        id: '1', role: 'assistant', content: 'I recommend **SOSA/VITA and MIL-STD Hardware Compliance**.',
        proposedTitle: null, proposedDescription: null, model: null, createdAt: '2026-01-01',
      },
    ]);
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const strongEl = await screen.findByText('SOSA/VITA and MIL-STD Hardware Compliance');
    expect(strongEl.tagName).toBe('STRONG');
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it('shows "Ask for a change" + a "this item only" chip in the header, matching the agreed mockup -- no persistent Suggest-a-title control there', async () => {
    // Real behavior change, not a relaxed test: the header used to carry a
    // persistent "Suggest a title" button (promoted there from a separate,
    // easy-to-miss link). Overridden to match the agreed mockup (§11.4.2)
    // exactly, which has no such button in chat-h at all -- "Suggest a
    // better title" is reachable only via the empty-state chip now (see the
    // suggested-prompt-chips test below).
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await waitFor(() => expect(chatApi.getChatHistory).toHaveBeenCalled());
    expect(screen.getByText('Ask for a change')).toBeInTheDocument();
    expect(screen.getByText('this item only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /suggest a title/i })).not.toBeInTheDocument();
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
    // Options only mount once the (Radix combobox) select is opened.
    await userEvent.click(screen.getByLabelText('Model'));
    expect(await screen.findByRole('option', { name: 'llama3.1' })).toBeInTheDocument();
  });

  it('shows a specific "job is closed" message on a 409, not the generic send-failure toast', async () => {
    // Regression: a 409 here means the backend's own diff_ready gate
    // rejected the turn -- almost always because the job's status changed
    // to something terminal (rejected/confirmed/cancelled) since this page
    // loaded (e.g. in another tab). The generic "Failed to send chat
    // message" this used to show for every failure looked identical to a
    // real network blip and gave no indication a reload would explain it.
    const error = new AxiosError('Conflict', '409');
    error.response = { status: 409, data: {}, statusText: 'Conflict', headers: {}, config: {} as never };
    vi.mocked(chatApi.sendChatTurn).mockRejectedValue(error);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const input = await screen.findByPlaceholderText(/ask the assistant/i);
    await user.type(input, 'hi{Enter}');

    await waitFor(() => expect(screen.getByText(/review has closed since this page loaded/i)).toBeInTheDocument());
    expect(screen.queryByText(/^failed to send chat message\.$/i)).not.toBeInTheDocument();
  });

  it('shows the generic send-failure message for a non-409 error', async () => {
    vi.mocked(chatApi.sendChatTurn).mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const input = await screen.findByPlaceholderText(/ask the assistant/i);
    await user.type(input, 'hi{Enter}');

    await waitFor(() => expect(screen.getByText(/failed to send chat message/i)).toBeInTheDocument());
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

  it('shows a collapsed "Thinking" disclosure on reasoning_chunk events, expanding to reveal the text on click', async () => {
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

    capturedOnEvent?.({ type: 'reasoning_chunk', delta: 'Considering the wording…' });

    const toggle = await screen.findByRole('button', { name: /thinking/i });
    expect(screen.queryByText(/considering the wording/i)).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByText(/considering the wording/i)).toBeInTheDocument();
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

  // CR-8/9 -- stop only sets a Redis flag polled once per streamed token, a
  // real multi-second cooperative gap, not an immediate abort. The button
  // must visibly change state for that whole gap, not look unresponsive.
  it('keeps the Stop button in "Stopping…" state until the stream actually ends, not just for the POST round-trip (CR-8, "Wizard UX Options" Take B)', async () => {
    let capturedOnEvent: ((event: import('../hooks/useChatSocket').StreamEvent) => void) | undefined;
    vi.mocked(useChatSocket).mockImplementation((_jobId, _localId, onEvent) => {
      capturedOnEvent = onEvent;
    });
    let resolveStop: () => void = () => {};
    vi.mocked(chatApi.stopChatTurn).mockImplementation(() => new Promise((resolve) => { resolveStop = resolve; }));
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const input = await screen.findByPlaceholderText(/ask the assistant/i);
    await user.type(input, 'hi{Enter}');
    capturedOnEvent?.({ type: 'chunk', delta: 'thinking' });

    const stopButton = screen.getByRole('button', { name: /stop generating/i });
    await user.click(stopButton);

    expect(screen.getByRole('button', { name: /stopping/i })).toBeDisabled();
    expect(screen.getByText(/waiting for the model to finish the chunk it is on/i)).toBeInTheDocument();

    // The POST resolving only means the Redis flag was set -- the model
    // hasn't actually stopped yet, so the button must NOT revert to "Stop
    // generating" just because the round-trip finished (the exact bug this
    // fix corrects: a spinner that vanishes here still leaves the real,
    // longer cooperative wait unlabeled).
    await act(async () => {
      resolveStop();
    });
    expect(screen.getByRole('button', { name: /stopping/i })).toBeDisabled();

    // Only the real end-of-stream signal clears it.
    capturedOnEvent?.({ type: 'done', message: 'Stopped early', proposedTitle: null, proposedDescription: null, model: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument());
  });

  it('shows all 4 starter rows in the empty state, each with its label and effect, including Suggest a better title (CR-9 Take C)', async () => {
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);
    expect(screen.getByRole('button', { name: /^make it testable/i })).toBeInTheDocument();
    expect(screen.getByText(/rewrite so it is independently verifiable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add the missing rationale/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^tighten the wording/i })).toBeInTheDocument();
    // Exactly one control now (was a regression guard against a SECOND,
    // duplicate control -- there both is, and can only ever be, one, since
    // the persistent header button this used to also guard against is gone).
    expect(screen.getAllByRole('button', { name: /^suggest a (better )?title/i })).toHaveLength(1);
  });

  it('clicking a starter row sends its real prompt text through the normal send() path', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);
    await user.click(screen.getByRole('button', { name: /^make it testable/i }));
    expect(chatApi.sendChatTurn).toHaveBeenCalledWith('job-1', 'n0', expect.stringMatching(/testable/i), undefined);
  });

  it('scopes the model-selector InfoTip to this conversation only', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);
    await user.hover(screen.getByRole('button', { name: /more information/i }));
    expect(await screen.findByText(/this conversation only/i)).toBeInTheDocument();
  });

  it('renders the assistant turn\'s model name in font-mono, distinct from the "Assistant ·" label', async () => {
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

    capturedOnEvent?.({ type: 'done', message: 'Here you go', proposedTitle: null, proposedDescription: null, model: 'llama3.1' });

    const modelSpan = await screen.findByText('llama3.1');
    expect(modelSpan.tagName).toBe('SPAN');
    expect(modelSpan.className).toContain('font-mono');
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

  // "Suggest a title" moved here from NodeDetailPanel (Task: fix "clicked
  // Suggest a title, nothing happened") -- the previous standalone button
  // called sendChatTurn directly, bypassing ChatPanel's own isStreaming/
  // typing-indicator state entirely. A real turn was confirmed live to take
  // ~2 minutes for a large item; with zero visible feedback for that whole
  // window, "nothing happened" was a completely reasonable conclusion. It
  // now reuses send()'s exact same path, so the same typing dots and
  // eventual history/proposal-card behavior other tests above already cover.
  it('sends the fixed title-suggestion prompt via the same path as a typed message, and shows the in-flight hint', async () => {
    const user = userEvent.setup();
    let resolveTurn: () => void = () => {};
    vi.mocked(chatApi.sendChatTurn).mockImplementation(
      () => new Promise((resolve) => { resolveTurn = () => resolve(undefined); }),
    );
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    await screen.findByPlaceholderText(/ask the assistant/i);

    // Now an empty-state starter row (no persistent header control) -- see
    // the header/starter-row tests above for that behavior change.
    await user.click(screen.getByRole('button', { name: /^suggest a better title/i }));

    expect(chatApi.sendChatTurn).toHaveBeenCalledWith('job-1', 'n0', expect.stringMatching(/title/i), undefined);
    // CR-8 replaced the old static "replies can take a couple of minutes"
    // note with a live elapsed counter on the Stop button itself plus this
    // hint -- real evidence of progress, not a vague time estimate.
    expect(screen.getByText(/streaming — you can stop at any point/i)).toBeInTheDocument();
    // Send swaps to Stop generating while a turn is in flight -- there's no
    // disabled Send to check for anymore, the icon itself changes.
    expect(screen.getByRole('button', { name: /stop generating/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^send$/i })).not.toBeInTheDocument();
    resolveTurn();
  });

  it('does not fire a second turn while one is still in flight (isStreamingRef guard, exercised via the composer this time -- the suggested-prompt chips vanish once isStreaming flips, which would make clicking one twice prove nothing about the guard itself)', async () => {
    const { fireEvent } = await import('@testing-library/react');
    let resolveTurn: () => void = () => {};
    vi.mocked(chatApi.sendChatTurn).mockImplementation(
      () => new Promise((resolve) => { resolveTurn = () => resolve(undefined); }),
    );
    render(
      <ToastProvider>
        <ChatPanel jobId="job-1" localId="n0" disabled={false} onAcceptProposal={vi.fn()} />
      </ToastProvider>,
    );
    const input = await screen.findByPlaceholderText(/ask the assistant/i);
    await userEvent.type(input, 'hi');
    const sendButton = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    expect(chatApi.sendChatTurn).toHaveBeenCalledTimes(1);
    resolveTurn();
  });
});
