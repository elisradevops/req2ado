import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ArrowLeft } from 'lucide-react';
import type { RewriteComparison, RewriteWarning } from '../api/chat';
import { NOISE_BAND, type ProposalReviewState } from '../hooks/useProposalReview';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DropdownMenu, DropdownMenuItem } from '../ui/DropdownMenu';
import { DescriptionMarkdown } from '../ui/Markdown';
import { ProposalChanges } from './ProposalChanges';
import { diffDescriptions } from '../utils/textDiff';
import { isScoredType } from '../utils/diffFlagging';
import { LABEL_MICRO } from '../utils/labelMicro';
import { categoryLabel } from '../utils/qualityCategories';
import { cn } from '../lib/cn';

// The assistant's suggested rewrite beside the original, with its predicted grade (DESIGN.md §11.4.6). It replaces the Proposed column of the
// item dialog while the reviewer is deciding, so the Source stays beside it.

const WARNING_LABEL: Record<string, string> = {
  empty_description: 'Empty description',
  title_changed: 'Title changed',
  much_longer: 'Much longer',
  more_statements: 'More statements',
  dropped_numbers: 'Numbers dropped',
  dropped_identifiers: 'Identifiers dropped',
};

export function warningText(warning: RewriteWarning): string {
  const label = WARNING_LABEL[warning.code] ?? warning.code;
  return warning.code === 'title_changed' || warning.code === 'empty_description' ? label : `${label}: ${warning.detail}`;
}

// The reviewer's last choice of view is remembered; a private window or blocked storage just means the automatic choice applies.
type ViewChoice = 'changes' | 'side';
const VIEW_KEY = 'req2ado.proposalView';
function readView(): ViewChoice | null {
  try {
    const value = window.localStorage.getItem(VIEW_KEY);
    return value === 'changes' || value === 'side' ? value : null;
  } catch {
    return null;
  }
}
function storeView(view: ViewChoice): void {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // not remembered
  }
}
// At most this share of the words may have changed for the inline view to be the automatic choice: past it, marks are noise.
const AUTO_CHANGES_MAX_SHARE = 0.4;

export interface ReviewedItem {
  type: string;
  title: string;
  description: string;
  qualityScore?: number | null;
  qualityStale?: boolean;
}

/** The line under "Suggested change": what the predicted grade is, in the words of DESIGN.md §11.4.6. Null for an item that is never scored. */
export function gradeLine(
  item: ReviewedItem,
  review: Pick<ProposalReviewState, 'proposal' | 'checking' | 'check' | 'comparison' | 'predictingSeconds'>,
): string | null {
  if (!isScoredType(item.type)) return null;
  if (!review.checking) {
    const stored = item.qualityScore != null && !item.qualityStale ? ` The text is unchanged, so the score stays ${Math.round(item.qualityScore)}.` : '';
    return `Titles are not scored.${stored}`;
  }
  const prediction = review.check?.prediction;
  if (!prediction || prediction.status === 'loading') return `Predicting the suggestion's score… ${review.predictingSeconds} s`;
  if (prediction.status === 'late') return `Still predicting (${review.predictingSeconds} s). You can apply without it; the score appears here if it arrives.`;
  const data = review.comparison;
  if (prediction.status === 'unavailable' || !data || data.delta === null || data.before.score === null || data.after.score === null) {
    return 'No predicted score: the scorer did not answer. The warnings below still apply.';
  }
  const before = Math.round(data.before.score);
  const after = Math.round(data.after.score);
  const low = data.before.confidence === 'low' || data.after.confidence === 'low' ? ' · low confidence in the scorer' : '';
  if (Math.abs(data.delta) <= NOISE_BAND) return `Predicted ${before} → ${after}: about the same (differences of ${NOISE_BAND} or less are noise).${low}`;
  return `Predicted ${before} → ${after}, ${data.delta > 0 ? 'up' : 'down'} ${Math.abs(Math.round(data.delta))}.${low}`;
}

/** A note when the stored score and the comparison's own "before" disagree, so the two numbers do not look like a contradiction. */
export function storedScoreNote(item: ReviewedItem, data: RewriteComparison | null): string | null {
  if (!data || data.before.score === null || item.qualityScore == null) return null;
  if (!item.qualityStale && Math.abs(item.qualityScore - data.before.score) <= NOISE_BAND) return null;
  return `The current text was re-scored with the suggestion (${Math.round(data.before.score)}); its stored score is ${Math.round(item.qualityScore)}.`;
}

/** The categories the suggestion moved by more than the noise, biggest first, at most four. */
export function categoryMoves(data: RewriteComparison | null): { key: string; before: number; after: number; delta: number }[] {
  if (!data?.categoryDeltas) return [];
  return Object.entries(data.categoryDeltas)
    .filter(([key, delta]) => Math.abs(delta) > NOISE_BAND && data.before.categoryScores?.[key] != null && data.after.categoryScores?.[key] != null)
    .map(([key, delta]) => ({ key, before: data.before.categoryScores![key], after: data.after.categoryScores![key], delta }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 4);
}

export function ProposalReview({
  review,
  item,
  onAccept,
  onEditFirst,
  onDiscuss,
  onReject,
  onBack,
}: {
  review: ProposalReviewState;
  item: ReviewedItem;
  // The suggestion is applied by the caller; the patch holds only what is being applied.
  onAccept: (patch: { title?: string; description?: string }) => void;
  onEditFirst: (seed: { title: string; description: string }) => void;
  onDiscuss?: (patch: { title?: string; description?: string }) => Promise<void> | void;
  onReject: () => void;
  // Below `lg` the assistant replaces the item, so a way back to it is offered.
  onBack?: () => void;
}): React.ReactElement | null {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discussing, setDiscussing] = useState(false);
  const [choice, setChoice] = useState<ViewChoice | null>(readView);
  const proposal = review.proposal;
  const proposedText = proposal?.proposedDescription ?? null;
  const diff = useMemo(() => (proposedText !== null ? diffDescriptions(item.description, proposedText) : null), [item.description, proposedText]);
  const autoView: ViewChoice = diff && !diff.tooLarge && diff.changedShare <= AUTO_CHANGES_MAX_SHARE ? 'changes' : 'side';
  const view: ViewChoice = diff?.tooLarge ? 'side' : (choice ?? autoView);

  // A suggestion appearing moves focus to the heading; closing review mode is the caller's to restore.
  const hasProposal = proposal !== null;
  useEffect(() => {
    if (hasProposal) headingRef.current?.focus();
  }, [hasProposal]);

  const newTitle = proposal?.proposedTitle && proposal.proposedTitle !== item.title ? proposal.proposedTitle : null;
  const hasDescription = !!proposal?.proposedDescription;
  const strip = proposal ? gradeLine(item, review) : null;
  const note = storedScoreNote(item, review.comparison);
  const moves = categoryMoves(review.comparison);
  const unchangedCount = review.comparison?.categoryDeltas ? Object.keys(review.comparison.categoryDeltas).length - moves.length : 0;
  const disabled = review.loading || discussing;

  function apply(patch: { title?: string; description?: string }): void {
    setConfirmOpen(false);
    onAccept(patch);
    review.setProposal(null);
  }
  const wholePatch = { title: proposal?.proposedTitle ?? undefined, description: proposal?.proposedDescription ?? undefined };
  function onAcceptClick(): void {
    if (review.needsConfirmation) setConfirmOpen(true);
    else apply(wholePatch);
  }

  // Ctrl or Cmd with Enter accepts, wherever focus is inside the dialog; no single letter does (one key overwriting text is too easy to press).
  const acceptRef = useRef(onAcceptClick);
  acceptRef.current = onAcceptClick;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing || event.defaultPrevented) return;
      if (disabledRef.current) return;
      event.preventDefault();
      acceptRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!proposal) return null;

  async function discuss(): Promise<void> {
    if (!onDiscuss || !proposal) return;
    setDiscussing(true);
    try {
      await onDiscuss({ title: proposal.proposedTitle ?? undefined, description: proposal.proposedDescription ?? undefined });
    } catch {
      return; // the caller has already surfaced the failure; keep the suggestion so it is not lost
    } finally {
      setDiscussing(false);
    }
    review.setProposal(null);
  }

  const comparison = review.comparison;
  const announcement =
    review.check?.prediction.status === 'ready' && comparison && comparison.before.score !== null && comparison.after.score !== null
      ? `Predicted score ready: ${Math.round(comparison.before.score)} to ${Math.round(comparison.after.score)}.`
      : review.check?.prediction.status === 'unavailable'
        ? 'No predicted score.'
        : '';

  return (
    <section aria-labelledby={headingId} data-testid="proposal-review" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {onBack && (
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to chat
          </Button>
        )}
        <h3 id={headingId} ref={headingRef} tabIndex={-1} className={cn(LABEL_MICRO, 'text-ink-2 outline-none')}>
          Suggested change
        </h3>
      </div>
      {strip && (
        <p data-testid="grade-line" className="text-sm font-medium text-ink-1">
          {strip}
        </p>
      )}
      {/* The result is announced once; the ticking time in the line above is not. */}
      <div role="status" className="sr-only">
        {announcement}
      </div>
      {note && <p className="text-xs text-ink-3">{note}</p>}

      {newTitle && (
        <dl className="grid grid-cols-[3.2rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-sm">
          <dt className="text-xs text-ink-3">Was</dt>
          <dd dir="auto" className="text-ink-2 line-through decoration-ink-3">
            {item.title}
          </dd>
          <dt className="text-xs text-ink-3">Now</dt>
          <dd dir="auto" className="font-medium text-ink-1">
            {newTitle}
          </dd>
        </dl>
      )}

      {hasDescription && diff && (
        <div className="flex min-w-0 flex-col gap-2">
          {!diff.tooLarge && (
            <div role="group" aria-label="View" className="inline-flex w-fit overflow-hidden rounded-md border border-hairline-strong text-xs font-semibold">
              {(['changes', 'side'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => {
                    setChoice(option);
                    storeView(option);
                  }}
                  className={cn('px-2.5 py-1', view === option ? 'bg-accent-soft text-accent-ink' : 'bg-surface text-ink-2 hover:bg-surface-alt')}
                >
                  {option === 'changes' ? 'Changes' : 'Side by side'}
                </button>
              ))}
            </div>
          )}
          {diff.tooLarge && <p className="text-xs text-ink-3">This text is too long to compare word by word, so both versions are shown.</p>}
          {!diff.tooLarge && view === 'side' && choice === null && <p className="text-xs text-ink-3">Most of the text changed, so both versions are shown.</p>}
          {view === 'changes' ? (
            <ProposalChanges diff={diff} />
          ) : (
            <div className="grid gap-3 @2xl:grid-cols-2">
              <div className="min-w-0 rounded-sm border border-hairline bg-surface-alt p-2.5">
                <p className={cn(LABEL_MICRO, 'mb-1 text-ink-3')}>Original</p>
                <div className="text-sm text-ink-2">
                  <DescriptionMarkdown>{item.description}</DescriptionMarkdown>
                </div>
              </div>
              <div className="min-w-0 rounded-sm border border-ok-border bg-ok-soft p-2.5">
                <p className={cn(LABEL_MICRO, 'mb-1 text-ok-ink')}>Suggested</p>
                <div className="text-sm text-ink-1">
                  {/* Rendered as the detail window renders it, so a table the proposal keeps shows as a table with its styling. */}
                  <DescriptionMarkdown>{proposal.proposedDescription ?? ''}</DescriptionMarkdown>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {moves.length > 0 && (
        <ul aria-label="Categories that changed" className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-1">
          {moves.map((move) => (
            <li key={move.key} dir="auto">
              {`${categoryLabel(move.key).replace(/[.?!。]+$/, '')} ${Math.round(move.before)} → ${Math.round(move.after)} (${move.delta > 0 ? '+' : ''}${Math.round(move.delta)})`}
            </li>
          ))}
          {unchangedCount > 0 && <li className="text-xs text-ink-3">{`${unchangedCount} unchanged`}</li>}
        </ul>
      )}

      {review.notChecked && <p className="text-xs text-ink-3">This rewrite could not be checked.</p>}
      {review.warningItems.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {review.warningItems.map((w) => (
            <Chip key={w.code} className={w.severity === 'high' ? 'bg-danger-soft text-danger-ink' : 'bg-canvas text-ink-2'}>
              {warningText(w)}
            </Chip>
          ))}
        </div>
      )}

      // Sticky: the decision stays in reach however long the comparison above it is.
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-hairline bg-surface py-2.5">
        <span className="inline-flex">
          <Button size="sm" onClick={onAcceptClick} disabled={disabled} className={newTitle ? 'rounded-e-none' : undefined}>
            Accept
          </Button>
          {newTitle && hasDescription && (
            <DropdownMenu
              trigger={
                <Button size="sm" aria-label="More ways to accept" disabled={disabled} className="rounded-s-none border-s border-white/30 px-1.5">
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              }
            >
              <DropdownMenuItem onSelect={() => apply({ title: newTitle })}>Title only</DropdownMenuItem>
            </DropdownMenu>
          )}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onEditFirst({ title: proposal.proposedTitle ?? item.title, description: proposal.proposedDescription ?? item.description })}
        >
          Edit first
        </Button>
        {onDiscuss && (
          <Button size="sm" variant="outline" onClick={() => void discuss()} disabled={disabled}>
            To be discussed
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onReject} disabled={discussing}>
          Reject
        </Button>
        <span className="ms-auto text-xs text-ink-3">Ctrl+Enter accepts · Esc leaves review</span>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Apply this rewrite anyway?"
        description="The check found something you may want to look at first."
        confirmLabel="Apply anyway"
        onConfirm={() => apply(wholePatch)}
      >
        <div className="flex flex-col gap-1 text-sm">
          {review.notChecked ? <p>This rewrite could not be checked.</p> : <p>{strip ?? ''}</p>}
          {review.warningItems.length > 0 && (
            <ul className="list-disc pl-5">
              {review.warningItems.map((w) => (
                <li key={w.code}>{warningText(w)}</li>
              ))}
            </ul>
          )}
        </div>
      </ConfirmDialog>
    </section>
  );
}
