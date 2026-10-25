import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { MessageSquareText, SendHorizontal, ChevronRight } from 'lucide-react';
import { checkRewrite, getChatHistory, listModels, sendChatTurn, stopChatTurn, type ChatMessage, type RewriteComparison, type RewriteWarning } from '../api/chat';
import { useChatSocket, type StreamEvent } from '../hooks/useChatSocket';
import { useToast } from './ToastProvider';
import { ElapsedTimer } from './ElapsedTimer';
import { TextField } from '../ui/TextField';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { InfoTip } from '../ui/Tooltip';
import { DescriptionMarkdown, Markdown } from '../ui/Markdown';
import { cn } from '../lib/cn';
import { LABEL_MICRO } from '../utils/labelMicro';

interface Proposal {
  proposedTitle: string | null;
  proposedDescription: string | null;
}

const HISTORY_DISPLAY_LIMIT = 50;

// The prediction is a model call and can be slow (the server stops waiting for it at 60 s). Past this limit the proposal can be applied
// without it, but the card keeps listening: an answer that arrives later still updates it. The warnings do not wait for the prediction
// (they need no model), and a warning still asks for confirmation.
const CHECK_TIMEOUT_MS = 75_000;
// The scorer is a sampled model: a difference this small is noise, not a better or worse rewrite.
const NOISE_BAND = 5;

/**
 * What is known about ONE proposal. `warnings` come back at once; `prediction` (the original and the proposal scored together)
 * takes a model call. Kept with the proposal it belongs to, so a state left over from an earlier proposal is never read for a newer one.
 */
interface ProposalCheck {
  proposal: Proposal;
  warnings: { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; items: RewriteWarning[] };
  // `late`: the limit passed without an answer; Accept is open, the answer may still come.
  prediction: { status: 'loading' } | { status: 'late' } | { status: 'unavailable' } | { status: 'ready'; data: RewriteComparison };
}

const WARNING_LABEL: Record<string, string> = {
  empty_description: 'Empty description',
  title_changed: 'Title changed',
  much_longer: 'Much longer',
  more_statements: 'More statements',
  dropped_numbers: 'Numbers dropped',
  dropped_identifiers: 'Identifiers dropped',
};

function warningText(warning: RewriteWarning): string {
  const label = WARNING_LABEL[warning.code] ?? warning.code;
  return warning.code === 'title_changed' || warning.code === 'empty_description' ? label : `${label}: ${warning.detail}`;
}

function predictedLine(data: RewriteComparison | null): string {
  if (!data || data.delta === null || data.before.score === null || data.after.score === null) return 'The predicted score is unavailable.';
  const sign = data.delta > 0 ? '+' : '';
  const verdict = Math.abs(data.delta) <= NOISE_BAND ? ', about the same' : '';
  return `Predicted score: ${data.before.score} → ${data.after.score} (${sign}${data.delta}${verdict})`;
}

// Fixed, non-editable prompt for the "Suggest a better title" chip -- title
// distillation beyond the first-sentence rule (a shorter label, or a fully
// custom title unrelated to the source text) can't be done
// deterministically: two independent heuristic attempts, hand-verified
// against the golden TV-Receiver/Remote-Control scenario, were rejected --
// the oracle's own title choices are provably inconsistent under any
// per-line textual signal (same shape input, different desired output).
// Sent via the exact same send() path as a normal typed message (in-flight
// state, typing indicator, proposal card), same as every other suggested
// prompt below.
const SUGGEST_TITLE_PROMPT = 'Suggest a more specific, concise title for this requirement based on its description.';

// CR-9 (Take C, "Wizard UX Options" sheet) -- the empty state used to be a
// centered icon graphic + a row of label-only chips. Replaced with a fake
// opening Assistant turn ("I have read this requirement. Want me to:")
// followed by starter rows in the transcript's own voice: each row states
// the action AND its one-line effect, so the panel teaches what this chat
// is for instead of just naming four ideas. "Suggest a better title" folds
// in as a row here rather than a separate control -- it has no other home
// now that the header button and the old chip row are both gone. Each row
// reuses send()'s existing in-flight/typing-indicator path, same as before.
const SUGGESTED_PROMPTS: { label: string; effect: string; prompt: string }[] = [
  {
    label: 'Make it testable',
    effect: 'rewrite so it is independently verifiable, with clear acceptance criteria',
    prompt: 'Rewrite this so it is independently testable, with clear acceptance criteria.',
  },
  {
    label: 'Add the missing rationale',
    effect: 'add a brief rationale explaining why this requirement exists',
    prompt: 'Add a brief rationale explaining why this requirement exists.',
  },
  {
    label: 'Tighten the wording',
    effect: 'remove ambiguity and vague terms',
    prompt: 'Tighten the wording -- remove ambiguity and vague terms.',
  },
  {
    label: 'Suggest a better title',
    effect: 'was a separate button in the header, before this change',
    prompt: SUGGEST_TITLE_PROMPT,
  },
];

// Same rule as ingestion's chat prompt (chat_service._weakest_categories): the lowest score, and only when it is below the bar.
const WEAK_CATEGORY_SCORE = 70;

function weakestCategory(scores: Record<string, number> | null | undefined): { name: string; score: number } | null {
  const usable = Object.entries(scores ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value));
  usable.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const [weakest] = usable;
  return weakest && weakest[1] < WEAK_CATEGORY_SCORE ? { name: weakest[0], score: weakest[1] } : null;
}

export function ChatPanel({
  jobId,
  localId,
  itemType,
  disabled,
  disabledReason,
  categoryScores,
  onAcceptProposal,
}: {
  jobId: string;
  localId: string;
  // Only requirements are checked (the check judges a requirement's description); an Epic or Feature proposal is applied as before.
  itemType?: string;
  disabled: boolean;
  // Shown in place of the composer when disabled -- callers pass a
  // specific reason (e.g. "this job's review is closed") rather than
  // relying on the generic fallback below, which doesn't tell the user
  // WHY chat is unavailable.
  disabledReason?: string;
  // The item's score per quality category: a rewrite is aimed at the weakest one, and the proposal card says which.
  categoryScores?: Record<string, number> | null;
  onAcceptProposal: (patch: { title?: string; description?: string }) => void;
}): React.ReactElement {
  const { showToast, showErrorToast } = useToast();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
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
  // CR-8/9 -- stop only sets a Redis flag polled once per streamed token
  // (chat.service.ts), a real multi-second cooperative gap, not an
  // immediate abort -- there is no AbortController anywhere in this path.
  // `stopping` stays true for that whole gap (cleared only once the stream
  // actually ends, via the socket's done/error handler below), not just for
  // the brief POST round-trip -- a spinner that vanishes the instant the
  // POST resolves still leaves the real multi-second wait unlabeled.
  // `isStoppingRef` is the separate synchronous re-entry guard on the click
  // handler itself, same pattern as isStreamingRef above.
  const [stopping, setStopping] = useState(false);
  const isStoppingRef = useRef(false);
  // Set when a turn starts sending, read by the composer's live elapsed
  // counter while streaming -- real evidence something is progressing,
  // stronger than a static "can take a couple of minutes" sentence.
  const [streamStartedAt, setStreamStartedAt] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [checkState, setCheckState] = useState<ProposalCheck | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const checkRequestRef = useRef(0);
  const [predictingSeconds, setPredictingSeconds] = useState(0);
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
    setStopping(false);
    isStoppingRef.current = false;
    setStreamStartedAt(null);
  }, [jobId, localId]);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    getChatHistory(jobId, localId)
      .then((h) => {
        if (!cancelled) setHistory(h);
      })
      .catch((err) => {
        if (!cancelled) showErrorToast('Failed to load chat history for this item.', err);
      });
    setModelsLoading(true);
    listModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch((err) => {
        if (cancelled) return;
        setModels([]);
        showErrorToast('Could not load the model list; the default model is used.', err);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, localId, disabled]);

  // A proposal with a description is checked before it can be applied: the warnings come back at once (no model), the predicted score
  // (the original and the proposal scored together) when the model has answered. A result that arrives after the proposal or the node
  // changed is discarded.
  const checkedKind = itemType === undefined || itemType === 'Requirement';
  useEffect(() => {
    const request = ++checkRequestRef.current;
    setConfirmOpen(false);
    if (!checkedKind || !proposal?.proposedDescription) {
      setCheckState(null);
      return;
    }
    const target = { proposedTitle: proposal.proposedTitle, proposedDescription: proposal.proposedDescription };
    const fresh = () => request === checkRequestRef.current;
    const update = (patch: Partial<Pick<ProposalCheck, 'warnings' | 'prediction'>>) =>
      setCheckState((prev) => (prev && prev.proposal === proposal ? { ...prev, ...patch } : prev));
    setCheckState({ proposal, warnings: { status: 'loading' }, prediction: { status: 'loading' } });

    checkRewrite(jobId, localId, { ...target, warningsOnly: true })
      .then((data) => {
        if (fresh()) update(data && Array.isArray(data.warnings) ? { warnings: { status: 'ready', items: data.warnings } } : { warnings: { status: 'unavailable' } });
      })
      .catch(() => {
        if (fresh()) update({ warnings: { status: 'unavailable' } });
      });

    // Past the limit Accept opens up (`late`), but the request is not abandoned: an answer that comes later still updates the card.
    setPredictingSeconds(0);
    const startedAt = Date.now();
    const ticker = setInterval(() => setPredictingSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    const limit = setTimeout(
      () => setCheckState((prev) => (prev && prev.proposal === proposal && prev.prediction.status === 'loading' ? { ...prev, prediction: { status: 'late' } } : prev)),
      CHECK_TIMEOUT_MS,
    );
    const settle = () => {
      clearInterval(ticker);
      clearTimeout(limit);
    };
    checkRewrite(jobId, localId, target)
      .then((data) => {
        if (!fresh()) return;
        if (data && Array.isArray(data.warnings)) update({ prediction: { status: 'ready', data }, warnings: { status: 'ready', items: data.warnings } });
        else update({ prediction: { status: 'unavailable' } });
      })
      .catch(() => {
        if (fresh()) update({ prediction: { status: 'unavailable' } });
      })
      .finally(settle);
    return settle;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, jobId, localId, checkedKind]);

  // Only the state that belongs to the proposal on screen counts (the render before the effect runs would otherwise see the last one's).
  const check = checkState && checkState.proposal === proposal ? checkState : null;
  const checking = checkedKind && !!proposal?.proposedDescription;
  const targetCategory = weakestCategory(categoryScores);
  const loading = checking && (!check || check.warnings.status === 'loading' || check.prediction.status === 'loading');
  const warningItems = check?.warnings.status === 'ready' ? check.warnings.items : [];
  const comparison = check?.prediction.status === 'ready' ? check.prediction.data : null;
  const notChecked = checking && check?.warnings.status === 'unavailable';

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
        setStopping(false);
        setStreamStartedAt(null);
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
        setStopping(false);
        setStreamStartedAt(null);
        setStreaming('');
        setReasoning('');
        const reason = event.reason ?? 'unknown error';
        showErrorToast(`Chat reply failed: ${reason}`, {
          message: reason,
          status: event.details?.status,
          method: event.details?.method,
          url: event.details?.url,
          serverStack: event.details?.traceback,
          timestamp: new Date().toISOString(),
        });
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

  // `explicitText` lets every suggested-prompt chip (including "Suggest a
  // better title") reuse this exact same in-flight/typing-indicator/history
  // path instead of each duplicating it with its own separate state.
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
    setStreamStartedAt(new Date().toISOString());
    setProposal(null);
    try {
      await sendChatTurn(jobId, localId, text, model);
    } catch (err) {
      isStreamingRef.current = false;
      setIsStreaming(false);
      setStreamStartedAt(null);
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

  async function stop(): Promise<void> {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    setStopping(true);
    try {
      await stopChatTurn(jobId, localId);
      // `stopping` deliberately stays true here -- the POST resolving only
      // means the Redis flag was set, not that the model has stopped. It
      // clears in the socket done/error handler above, once the stream
      // actually ends.
    } catch (err) {
      setStopping(false);
      showErrorToast('Failed to stop -- the reply may still be generating.', err);
    } finally {
      isStoppingRef.current = false;
    }
  }

  // Applying asks first when the check predicts a lower score, found something that probably lost content, or could not check at all
  // ("unchecked" is not "fine").
  const needsConfirmation =
    !loading && (notChecked || warningItems.some((w) => w.severity === 'high') || (comparison?.delta != null && comparison.delta < -NOISE_BAND));

  function onAcceptClick(): void {
    if (needsConfirmation) setConfirmOpen(true);
    else acceptProposal();
  }

  function acceptProposal(): void {
    if (!proposal) return;
    setConfirmOpen(false);
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
      {/* Matches the agreed mockup's chat-h bar exactly (§11.4.2): icon +
          "Ask for a change" + a "this item only" chip -- no persistent
          Suggest-a-title button here. That button (and its own real
          benefit: staying reachable once the chat has history, unlike an
          empty-state-only affordance) is genuinely gone now, not relocated
          -- "Suggest a better title" is reachable only as a starter row
          below when the chat is empty (see CR-9/Take C). */}
      <div className="flex flex-none items-center gap-2">
        <MessageSquareText className="h-3.5 w-3.5 flex-none text-ink-3" />
        <p className="text-sm font-semibold text-ink-1">Ask for a change</p>
        <Chip className="ml-auto border border-hairline-strong text-micro font-normal text-ink-3">this item only</Chip>
      </div>
      <div className="mb-2 mt-1.5 flex-1 overflow-y-auto">
        {isEmpty ? (
          <div>
            {/* Fake opening Assistant turn -- same border-l-2/eyebrow
                convention the real turns below use, so the empty state
                reads as the start of this transcript rather than a
                separate graphic. */}
            <div className="mb-2 max-w-[85%] border-l-2 border-hairline-strong pl-2.5">
              <p className={LABEL_MICRO}>Assistant</p>
              <p className="text-sm text-ink-1">I have read this requirement. Want me to:</p>
            </div>
            <div className="ml-2.5 flex flex-col gap-1.5">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => void send(p.prompt)}
                  disabled={isStreaming}
                  className="rounded-md border border-hairline px-2.5 py-2 text-left transition-colors duration-fast ease-out hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="block text-sm font-semibold text-ink-1">{p.label}</span>
                  <span className="block text-xs text-ink-3">{p.effect}</span>
                </button>
              ))}
            </div>
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
                  <p className={LABEL_MICRO}>
                    Assistant{m.model ? <> · <span className="font-mono">{m.model}</span></> : ''}
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
                      className={cn('flex items-center gap-1', LABEL_MICRO, 'hover:text-ink-2')}
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
                  <p className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-live">
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
        <Card className="mb-2 p-2">
          <p className="text-xs">Proposed change</p>
          {targetCategory && (
            <p className="text-xs text-ink-3">
              Aimed at: {targetCategory.name} ({targetCategory.score})
            </p>
          )}
          {proposal.proposedTitle && (
            <p className="text-sm">
              <strong>Title:</strong> {proposal.proposedTitle}
            </p>
          )}
          {proposal.proposedDescription && (
            <div className="text-sm">
              <strong>Description:</strong>
              {/* Rendered as the detail window renders it, so a table the proposal keeps shows as a table with its styling. */}
              <DescriptionMarkdown>{proposal.proposedDescription}</DescriptionMarkdown>
            </div>
          )}
          {notChecked && <p className="mt-1 text-xs text-ink-3">This rewrite could not be checked.</p>}
          {warningItems.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {warningItems.map((w) => (
                <Chip key={w.code} className={w.severity === 'high' ? 'bg-danger-soft text-danger-ink' : 'bg-canvas text-ink-2'}>
                  {warningText(w)}
                </Chip>
              ))}
            </div>
          )}
          {checking && check && check.prediction.status === 'loading' && (
            <p className="mt-1 text-xs text-ink-3">Predicting the score… ({predictingSeconds} s)</p>
          )}
          {checking && check && check.prediction.status === 'late' && (
            <p className="mt-1 text-xs text-ink-3">The score is still being predicted ({predictingSeconds} s); you can apply without it.</p>
          )}
          {checking && check && (check.prediction.status === 'ready' || check.prediction.status === 'unavailable') && !notChecked && (
            <p className="mt-1 text-xs text-ink-2">{predictedLine(comparison)}</p>
          )}
          <div className="mt-1.5 flex gap-2">
            <Button size="sm" onClick={onAcceptClick} disabled={loading}>
              Accept
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
              Reject
            </Button>
          </div>
        </Card>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Apply this rewrite anyway?"
        description="The check found something you may want to look at first."
        confirmLabel="Apply anyway"
        onConfirm={acceptProposal}
      >
        <div className="flex flex-col gap-1 text-sm">
          {notChecked ? <p>This rewrite could not be checked.</p> : <p>{predictedLine(comparison)}</p>}
          {warningItems.length > 0 && (
            <ul className="list-disc pl-5">
              {warningItems.map((w) => (
                <li key={w.code}>{warningText(w)}</li>
              ))}
            </ul>
          )}
        </div>
      </ConfirmDialog>
      <div className="flex flex-col gap-2 border-t border-hairline pt-3">
        {/* Model picker is a secondary control (most turns leave it on
            Default) -- kept narrow so it doesn't compete with the input for
            width; the input is the row people actually look at and type
            into. w-20 clipped real model names ("qwen3.6:35b" and longer --
            confirmed live), so this is wide enough for those while the
            Select component itself now ellipsizes (+ shows the full value
            on hover) if a future name is longer still. */}
        <div className="flex items-center gap-1.5">
          <Select aria-label="Model" value={model ?? ''} onChange={(e) => setModel(e.target.value || undefined)} loading={modelsLoading} className="w-28 text-xs">
            <option value="">Default</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <InfoTip content="Fetched live from the LLM backend. Leave on Default to use the orchestrator's configured model. This applies to this conversation only -- it does not change the model the job was analysed with." />
        </div>
        {/* CR-8 ("Wizard UX Options" Take B) -- the composer holds the
            state instead of swapping one icon next to a fixed input: while
            streaming, this whole row becomes the Stop control (with a live
            elapsed counter -- real evidence of progress, replacing the old
            static "can take a couple of minutes" note below it, which is
            now redundant with it and removed); once actually stopping, it
            shows the honest cooperative-cancellation sentence instead of a
            bare spinner. */}
        {isStreaming ? (
          <div className="flex flex-col gap-1.5">
            <Button
              onClick={stop}
              variant="danger"
              loading={stopping}
              className="w-full justify-between"
              aria-label={stopping ? 'Stopping' : 'Stop generating'}
            >
              <span>{stopping ? 'Stopping…' : 'Stop generating'}</span>
              {!stopping && streamStartedAt && (
                <span className="text-xs opacity-60">
                  <ElapsedTimer startedAt={streamStartedAt} />
                </span>
              )}
            </Button>
            {stopping ? (
              <div className="rounded-md bg-surface-alt px-2.5 py-1.5">
                <p className="text-xs text-ink-3">Waiting for the model to finish the chunk it is on. The reply so far is kept.</p>
              </div>
            ) : (
              <p className="text-center text-xs text-ink-3">Streaming — you can stop at any point.</p>
            )}
          </div>
        ) : (
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
            <Button onClick={() => void send()} className="flex-none px-2.5" aria-label="Send">
              <SendHorizontal className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
