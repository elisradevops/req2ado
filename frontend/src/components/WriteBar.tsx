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
}): React.ReactElement {
  const blocked = blockedCount > 0;
  const describedBy = [blocked ? 'write-blocked-reason' : null, !canWriteToAdo ? 'write-ado-reason' : null].filter(Boolean).join(' ') || undefined;
  const writeButton = (
    <span className="max-md:flex-1">
      <Button
        variant="cta"
        onClick={onWrite}
        softDisabled={blocked}
        aria-describedby={describedBy}
        disabled={busy || !canWriteToAdo}
        className="max-md:min-h-11 max-md:w-full"
      >
        <Upload className="h-3.5 w-3.5" />
        Write to Azure DevOps
      </Button>
    </span>
  );
  return (
    // Its own panel at the end of the review (not sticky, DESIGN.md §11.3.5: it used to float over the tabs and the last rows): inset from the edges of the card it sits under (mx-2 / md:mx-4; on a phone the page gutter
    // does it), a full border, radius-md corners and its own shadow, so it shares no edge with the card. It was a flat footer, white on white,
    // the same width as the tree card, and read as that card's footer. `bottom-0` rests it one page padding above the edge (main keeps its
    // p-3 / md:p-5), which is also where it sits at the end of the scroll, so it never covers the last rows; mid-scroll that strip shows
    // rows beneath it, which is what makes it read as floating. On a phone it clears the home indicator.
    <section
      aria-label="Review decision"
      className="mx-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-md border border-hairline-strong bg-surface px-3.5 py-2.5 shadow-dock max-md:mx-0 max-md:mb-[env(safe-area-inset-bottom)] max-md:flex-col max-md:items-stretch md:mx-4"
    >
      {(includedCount !== undefined || blocked || !canWriteToAdo) && (
        <div className="mr-auto flex min-w-0 flex-col gap-0.5 max-md:mr-0">
          {includedCount !== undefined && (
            <>
              <p className="text-xs font-semibold text-ink-1">
                {includedCount.toLocaleString()} included{leftOutCount > 0 ? ` · ${leftOutCount.toLocaleString()} left out` : ''}
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
        </div>
      )}
      <div className="flex items-center gap-2 max-md:w-full">
        <Button variant="danger" onClick={onReject} disabled={busy} className="max-md:min-h-11">
          <X className="h-3.5 w-3.5" />
          Reject
        </Button>
        {canWriteToAdo ? <Tooltip content="Write the reviewed items to Azure DevOps">{writeButton}</Tooltip> : writeButton}
      </div>
    </section>
  );
}
