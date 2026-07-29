import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { MessageSquareText, Sparkles, SendHorizontal, Square, ChevronRight } from 'lucide-react';
import { getChatHistory, listModels, sendChatTurn, stopChatTurn, type ChatMessage } from '../api/chat';
import { useChatSocket, type StreamEvent } from '../hooks/useChatSocket';
import { useToast } from './ToastProvider';
import { TextField } from '../ui/TextField';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { InfoTip } from '../ui/Tooltip';
import { Markdown } from '../ui/Markdown';

interface Proposal {
  proposedTitle: string | null;
  proposedDescription: string | null;
}

const HISTORY_DISPLAY_LIMIT = 50;

// Fixed, non-editable prompt for the "Suggest a title" button -- title
// distillation beyond the first-sentence rule (a shorter label, or a fully
// custom title unrelated to the source text) can't be done
// deterministically: two independent heuristic attempts, hand-verified
// against the golden TV-Receiver/Remote-Control scenario, were rejected --
// the oracle's own title choices are provably inconsistent under any
// per-line textual signal (same shape input, different desired output).
// Reuses the exact same send() path as a normal typed message (in-flight
// state, typing indicator, proposal card) rather than a separate button
// with its own state -- that separation was the actual bug: a suggest-title
// turn could take real minutes (confirmed live: ~2 min for an Epic-level
// node) with zero visible feedback because it bypassed ChatPanel's own
// isStreaming/typing-dots state entirely.
const SUGGEST_TITLE_PROMPT = 'Suggest a more specific, concise title for this requirement based on its description.';

export function ChatPanel({
  jobId,
  localId,
  disabled,
  disabledReason,
  onAcceptProposal,
}: {
  jobId: string;
  localId: string;
  disabled: boolean;
  // Shown in place of the composer when disabled -- callers pass a
  // specific reason (e.g. "this job's review is closed") rather than
  // relying on the generic fallback below, which doesn't tell the user
  // WHY chat is unavailable.
  disabledReason?: string;
  onAcceptProposal: (patch: { title?: string; description?: string }) => void;
}): React.ReactElement {
  const { showToast } = useToast();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [streaming, setStreaming] = useState('');
  // A reasoning/"thinking" model's chain-of-thought, streamed on a separate
  // wire event (reasoning_chunk) from the final answer (chunk) -- see
  // llm-client.interface.ts's LlmStreamChunk doc comment for why these are
  // two distinct streams rather than one. Cleared on done/error/reset same
  // as `streaming`, but never appended to history -- it's process, not
  // content.
  const [reasoning, setReasoning] = useState('');
  // Collapsed by default -- reasoning is optional-viewing "process," not the
  // answer itself, so it doesn't compete with the actual reply for
  // attention unless a reviewer actively wants to see it.
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  // Synchronous guard alongside isStreaming's state -- several synchronous
  // clicks landing before the first re-render would all read isStreaming's
  // stale `false` closure value and slip past a state-only check (this is
  // exactly the bug the old standalone "Suggest a title" button in
  // NodeDetailPanel had a ref guard for; moving the button here must not
  // lose that protection).
  const isStreamingRef = useRef(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const historyEndRef = useRef<HTMLDivElement>(null);

  // Reset chat state whenever the selected node changes so a stale
  // proposal/history from a different node can never be shown or accepted
  // onto the newly-selected one.
  useEffect(() => {
    setHistory([]);
    setProposal(null);
    setDraft('');
    setModel(undefined);
    setStreaming('');
    setReasoning('');
    setReasoningExpanded(false);
    setIsStreaming(false);
  }, [jobId, localId]);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    getChatHistory(jobId, localId).then((h) => {
      if (!cancelled) setHistory(h);
    });
    listModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, localId, disabled]);

  useChatSocket(
    jobId,
    localId,
    (event: StreamEvent) => {
      if (disabled) return;
      if (event.type === 'chunk') {
        setStreaming((prev) => prev + (event.delta ?? ''));
      } else if (event.type === 'reasoning_chunk') {
        setReasoning((prev) => prev + (event.delta ?? ''));
      } else if (event.type === 'done') {
        isStreamingRef.current = false;
        setIsStreaming(false);
        setStreaming('');
        setReasoning('');
        setHistory((prev) => [
          ...prev,
          {
            id: `local-${prev.length}`,
            role: 'assistant',
            content: event.message ?? '',
            proposedTitle: event.proposedTitle ?? null,
            proposedDescription: event.proposedDescription ?? null,
            model: event.model ?? null,
            createdAt: new Date().toISOString(),
          },
        ]);
        if (event.proposedTitle || event.proposedDescription) {
          setProposal({ proposedTitle: event.proposedTitle ?? null, proposedDescription: event.proposedDescription ?? null });
        }
      } else if (event.type === 'error') {
        isStreamingRef.current = false;
        setIsStreaming(false);
        setStreaming('');
        setReasoning('');
        showToast(`Chat reply failed: ${event.reason ?? 'unknown error'}`, 'error');
      }
    },
    !disabled,
  );

  // Follows new messages and in-flight streamed tokens to the bottom of the
  // scroll region -- history/streaming are the two things that grow this
  // panel's content, so both need to trigger a re-scroll.
  useEffect(() => {
    historyEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [history, streaming, reasoning]);

  // `explicitText` lets suggestTitle() below reuse this exact same
  // in-flight/typing-indicator/history path instead of duplicating it with
  // its own separate (and previously invisible) state.
  async function send(explicitText?: string): Promise<void> {
    const text = explicitText ?? draft;
    if (!text.trim() || isStreamingRef.current) return;
    isStreamingRef.current = true;
    if (explicitText === undefined) setDraft('');
    setReasoningExpanded(false);
    setHistory((prev) => [
      ...prev,
      {
        id: `local-user-${prev.length}`,
        role: 'user',
        content: text,
        proposedTitle: null,
        proposedDescription: null,
        model: model ?? null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setIsStreaming(true);
    setProposal(null);
    try {
      await sendChatTurn(jobId, localId, text, model);
    } catch (err) {
      isStreamingRef.current = false;
      setIsStreaming(false);
      // A 409 here means the backend's own diff_ready gate rejected this
      // turn (chat.service.ts's sendTurn) -- almost always because the
      // job's status changed to something terminal (rejected/confirmed/
      // cancelled) SINCE this page loaded, e.g. in another tab or another
      // session. The generic "Failed to send chat message" this used to
      // show regardless of cause looked identical to a real network
      // failure and gave no indication a reload would explain it (confirmed
      // live: a real 409 read as an unexplained dead end).
      const isClosed = isAxiosError(err) && err.response?.status === 409;
      showToast(
        isClosed
          ? "This job's review has closed since this page loaded — reload to see its current status."
          : 'Failed to send chat message.',
        'error',
      );
    }
  }

  function suggestTitle(): void {
    void send(SUGGEST_TITLE_PROMPT);
  }

  async function stop(): Promise<void> {
    await stopChatTurn(jobId, localId);
  }

  function acceptProposal(): void {
    if (!proposal) return;
    onAcceptProposal({
      title: proposal.proposedTitle ?? undefined,
      description: proposal.proposedDescription ?? undefined,
    });
    setProposal(null);
  }

  if (disabled) {
    return (
      <div className="flex h-full flex-col p-4">
        <p className="text-sm text-ink-3">{disabledReason ?? 'Chat is unavailable for this item.'}</p>
      </div>
    );
  }

  const visibleHistory = history.slice(-HISTORY_DISPLAY_LIMIT);
  const isEmpty = visibleHistory.length === 0 && !isStreaming;

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {/* Suggest-a-title promoted next to the CHAT eyebrow -- it used to be
          a tiny ghost-styled text link below the composer, easy to miss
          for what's actually a commonly-used, high-value action. */}
      <div className="flex flex-none items-center justify-between gap-2">
        <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Chat</p>
        <Button size="sm" variant="outline" onClick={suggestTitle} disabled={isStreaming}>
          <Sparkles className="h-3.5 w-3.5" />
          Suggest a title
        </Button>
      </div>
      <div className="mb-2 mt-1.5 flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <MessageSquareText className="h-6 w-6 text-hairline-strong" aria-hidden="true" />
            <p className="text-sm font-semibold text-ink-2">Ask about this item</p>
            <p className="max-w-[240px] text-xs leading-relaxed text-ink-3">
              e.g. make it testable, tighten the wording, or suggest a better title.
            </p>
          </div>
        ) : (
          <>
            {/* User turns: right-aligned inset chip -- a functional "this is
                your input" distinction, not a chat-app bubble aesthetic.
                Assistant turns: left-aligned, no fill, a thin rule + the
                same eyebrow-label convention NodeDetailPanel already uses
                for "REQUIREMENT" -- ties the transcript into the dialog's
                existing identifier typography instead of inventing a new
                chat-bubble language for a professional review tool. */}
            {visibleHistory.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="mb-3 flex justify-end">
                  <p className="max-w-[85%] rounded-md bg-surface-alt px-3 py-1.5 text-sm text-ink-1">{m.content}</p>
                </div>
              ) : (
                <div key={m.id} className="mb-3 max-w-[85%] border-l-2 border-hairline-strong pl-2.5">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                    Assistant{m.model ? ` · ${m.model}` : ''}
                  </p>
                  <Markdown>{m.content}</Markdown>
                </div>
              ),
            )}
            {isStreaming && (
              <>
                {/* A reasoning model's chain-of-thought, streamed on a
                    separate wire event from the final answer -- previously
                    dropped entirely, so the whole "thinking" phase
                    (confirmed live: the bulk of a ~2min turn) showed nothing
                    but typing dots. Collapsed by default (an expandable
                    disclosure, not a required view) -- it's optional
                    process detail, not the answer, and is discarded once
                    the turn completes (never added to history). */}
                {reasoning && (
                  <div className="mb-2 max-w-[85%] border-l-2 border-hairline pl-2.5">
                    <button
                      type="button"
                      onClick={() => setReasoningExpanded((prev) => !prev)}
                      aria-expanded={reasoningExpanded}
                      className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3 hover:text-ink-2"
                    >
                      <ChevronRight className={`h-3 w-3 transition-transform ${reasoningExpanded ? 'rotate-90' : ''}`} />
                      Thinking
                    </button>
                    {reasoningExpanded && (
                      // Capped height + its own scroll region -- growing
                      // chain-of-thought text used to push the toggle
                      // itself off-screen as it streamed in, so collapsing
                      // meant scrolling back up through everything it had
                      // pushed down. The toggle now always stays in place;
                      // only this box scrolls.
                      <div className="mt-1 max-h-32 overflow-y-auto">
                        <p className="whitespace-pre-line text-xs italic leading-relaxed text-ink-3">{reasoning}</p>
                      </div>
                    )}
                  </div>
                )}
                <div className="mb-3 max-w-[85%] border-l-2 border-hairline-strong pl-2.5">
                  <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-live">
                    Assistant
                    {!streaming && !reasoning && (
                      <span className="inline-flex items-center gap-0.5" aria-label="typing">
                        <span className="h-1 w-1 animate-[typedot_1.1s_ease-in-out_infinite] rounded-full bg-live" style={{ animationDelay: '0ms' }} />
                        <span className="h-1 w-1 animate-[typedot_1.1s_ease-in-out_infinite] rounded-full bg-live" style={{ animationDelay: '160ms' }} />
                        <span className="h-1 w-1 animate-[typedot_1.1s_ease-in-out_infinite] rounded-full bg-live" style={{ animationDelay: '320ms' }} />
                      </span>
                    )}
                  </p>
                  {streaming ? <Markdown>{streaming}</Markdown> : null}
                </div>
              </>
            )}
          </>
        )}
        <div ref={historyEndRef} />
      </div>
      {proposal && (
        <div className="mb-2 rounded-sm border border-hairline p-2">
          <p className="text-xs">Proposed change</p>
          {proposal.proposedTitle && (
            <p className="text-sm">
              <strong>Title:</strong> {proposal.proposedTitle}
            </p>
          )}
          {proposal.proposedDescription && (
            <p className="text-sm">
              <strong>Description:</strong> {proposal.proposedDescription}
            </p>
          )}
          <div className="mt-1.5 flex gap-2">
            <Button size="sm" onClick={acceptProposal}>
              Accept
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
              Reject
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-hairline pt-3">
        {/* Model picker is a secondary control (most turns leave it on
            Default) -- shrunk to just fit "Default"/short model names so it
            doesn't compete with the input for width; the input is the row
            people actually look at and type into. */}
        <div className="flex items-center gap-1.5">
          <Select aria-label="Model" value={model ?? ''} onChange={(e) => setModel(e.target.value || undefined)} className="w-20 text-xs">
            <option value="">Default</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <InfoTip content="Fetched live from the LLM backend. Leave on Default to use the orchestrator's configured model." />
        </div>
        {/* Input + an icon-only Send/Stop inline, input taking all the
            remaining width. While streaming, the same slot becomes a stop
            (square) icon instead of a separate "Stop generating" text button
            elsewhere on the row -- one control, whose icon and action swap
            with state, rather than two controls competing for attention. */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <TextField
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask the assistant to refine this item…"
              fullWidth
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          {isStreaming ? (
            <Button onClick={stop} variant="danger" className="flex-none px-2.5" aria-label="Stop generating">
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button onClick={() => void send()} className="flex-none px-2.5" aria-label="Send">
              <SendHorizontal className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {/* Real local-model turns have been observed taking ~2 minutes for a
          large/Epic-level item -- without this, the multi-minute wait (with
          only the typing dots as a signal) reads as broken, exactly what
          triggered this note (a user reported "nothing happened" after
          clicking Suggest a title on a slow item). */}
      {isStreaming && <p className="text-xs text-ink-3">Replies can take a couple of minutes for larger items.</p>}
    </div>
  );
}
