import { Upload, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { AnimatedNumber } from '../ui/AnimatedNumber';

// DESIGN.md §5 / §11.3.6: the review's decisions, docked to the bottom edge of the review view and AFTER the tree in DOM and tab order, so a
// keyboard user meets the items before the button that writes them, and Write never scrolls out of view in a long tree. It carries the
// blocker count in text (linked to Write by aria-describedby), Reject beside Write (the counterpart decision, before it), and the one
// signal-yellow control on the page. A blocked Write stays focusable (`softDisabled`) and takes the reviewer to the first blocker.
export function WriteBar({
  blockedCount,
  onWrite,
  onReject,
  busy,
  canWriteToAdo,
  includedCount,
  leftOutCount = 0,
  destination,
  nothingToWrite = false,
  reviewedCount = 0,
  reviewableCount = 0,
}: {
  // Items still to decide before Write is available; 0 when the gate is open.
  blockedCount: number;
  onWrite: () => void;
  onReject: () => void;
  // A job-level mutation is in flight: both decisions wait for it.
  busy: boolean;
  canWriteToAdo: boolean;
  // What the write is made of, from the job as it stands: items in, items left out (themselves or under an excluded parent), and the
  // area path they go to. Omitted: no summary line.
  includedCount?: number;
  leftOutCount?: number;
  destination?: string;
  // No new item is left to create (every one is excluded or already exists), from the diff as it stands. Said only when Write is otherwise
  // available. Write stays enabled: the Write dialog's server preview is the authority (it may still have links or figures to write).
  nothingToWrite?: boolean;
  // Review progress: the new items still in the write (reviewable) and how many are marked reviewed. Plain text, so it is read as a
  // number; not said when nothing is left to review.
  reviewedCount?: number;
  reviewableCount?: number;
}): React.ReactElement {
  const blocked = blockedCount > 0;
  const showNothingToWrite = nothingToWrite && !blocked && canWriteToAdo;
  const describedBy =
    [blocked ? 'write-blocked-reason' : null, !canWriteToAdo ? 'write-ado-reason' : null, showNothingToWrite ? 'write-nothing-reason' : null]
      .filter(Boolean)
      .join(' ') || undefined;
  // One button that names the next step (owner decision, 2026-11-25): "Fix 1 item" while something blocks the write -- plain, not the yellow
  // control, because it does not write; it takes the reviewer to the first blocker -- then "Write 156 items", the one yellow control. Its
  // accessible name says where the items go; the visible words stay part of it (WCAG 2.5.3).
  const total = includedCount !== undefined ? includedCount + leftOutCount : undefined;
  const writeLabel =
    includedCount === undefined || total === undefined
      ? 'Write to Azure DevOps'
      : `Write ${includedCount === total ? total.toLocaleString() : `${includedCount.toLocaleString()} of ${total.toLocaleString()}`} ${total === 1 ? 'item' : 'items'}`;
  const writeButton = blocked ? (
    <span className="max-md:flex-1">
      <Button variant="primary" onClick={onWrite} aria-describedby={describedBy} disabled={busy} className="max-md:min-h-11 max-md:w-full">
        Fix {blockedCount.toLocaleString()} {blockedCount === 1 ? 'item' : 'items'}
      </Button>
    </span>
  ) : (
    <span className="max-md:flex-1">
      <Button
        variant="cta"
        onClick={onWrite}
        aria-label={writeLabel === 'Write to Azure DevOps' ? undefined : `${writeLabel} to Azure DevOps`}
        aria-describedby={describedBy}
        disabled={busy || !canWriteToAdo}
        className="max-md:min-h-11 max-md:w-full"
      >
        <Upload className="h-3.5 w-3.5" />
        {writeLabel}
      </Button>
    </span>
  );
  return (
    // Its own panel at the end of the review (DESIGN.md §11.3.5): inset from the card above, bordered, with its own shadow. On a phone it clears the home indicator.
    // Sticky to the bottom of the screen (owner decision, 2026-11-25: the write bar ends the tree and stays in reach). Being positioned also keeps
    // its screen-reader text inside it: unpositioned, that absolute text sat at its place in the scrolled page and made the window scroll.
    <section
      aria-label="Review decision"
      data-dock
      className="sticky bottom-0 z-10 mx-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-md border border-hairline-strong bg-surface px-3.5 py-2.5 shadow-dock max-md:mx-0 max-md:mb-[env(safe-area-inset-bottom)] max-md:flex-col max-md:items-stretch md:mx-4"
    >
      {(includedCount !== undefined || blocked || !canWriteToAdo || showNothingToWrite) && (
        <div className="mr-auto flex min-w-0 flex-col gap-0.5 max-md:mr-0">
          {includedCount !== undefined && (
            <>
              <p className="text-xs font-semibold text-ink-1">
                {includedCount.toLocaleString()} included{leftOutCount > 0 ? ` · ${leftOutCount.toLocaleString()} left out` : ''}
                {reviewableCount > 0 && (
                  <span className="font-normal text-ink-2">{` · ${reviewedCount.toLocaleString()} of ${reviewableCount.toLocaleString()} reviewed`}</span>
                )}
              </p>
              {destination && (
                <p className="min-w-0 truncate text-xs text-ink-2" title={destination}>
                  to <bdi>{destination}</bdi>
                </p>
              )}
            </>
          )}
          {blocked && (
            // The count ticks to its new value as items are decided (research #2); the sentence is the text equivalent, and number-flow
            // snaps under reduced motion.
            <p id="write-blocked-reason" className="text-xs text-danger">
              <AnimatedNumber value={blockedCount} /> {blockedCount === 1 ? 'item' : 'items'} to fix before writing
            </p>
          )}
          {!canWriteToAdo && (
            // In text, not only a hover tooltip: a phone has no hover, and the reason Write is unavailable must be readable.
            <p id="write-ado-reason" className="text-xs text-ink-2">
              Sign in with an Azure DevOps org URL and PAT to write
            </p>
          )}
          {showNothingToWrite && (
            <p id="write-nothing-reason" className="text-xs text-ink-2">
              Nothing left to write: every item is excluded or already exists.
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 max-md:w-full">
        <Button variant="danger" onClick={onReject} disabled={busy} className="max-md:min-h-11">
          <X className="h-3.5 w-3.5" />
          Reject
        </Button>
        {canWriteToAdo && !blocked ? <Tooltip content="Write the reviewed items to Azure DevOps">{writeButton}</Tooltip> : writeButton}
      </div>
    </section>
  );
}
