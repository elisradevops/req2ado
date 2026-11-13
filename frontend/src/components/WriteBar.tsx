import { Upload, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { AnimatedNumber } from '../ui/AnimatedNumber';

// DESIGN.md §5 / §11.3.6: the review's decisions, sticky at the bottom of the review view and AFTER the tree in DOM and tab order, so a
// keyboard user meets the items before the button that writes them, and Write never scrolls out of view in a long tree. It carries the
// blocker count in text (linked to Write by aria-describedby), Reject beside Write (the counterpart decision, before it), and the one
// signal-yellow control on the page. A blocked Write stays focusable (`softDisabled`) and takes the reviewer to the first blocker.
export function WriteBar({
  blockedCount,
  onWrite,
  onReject,
  busy,
  canWriteToAdo,
}: {
  // Items still to decide before Write is available; 0 when the gate is open.
  blockedCount: number;
  onWrite: () => void;
  onReject: () => void;
  // A job-level mutation is in flight: both decisions wait for it.
  busy: boolean;
  canWriteToAdo: boolean;
}): React.ReactElement {
  const blocked = blockedCount > 0;
  return (
    <section
      aria-label="Review decision"
      className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-t-md border border-b-0 border-hairline-strong bg-surface px-3.5 py-2.5 max-md:flex-col max-md:items-stretch"
    >
      {blocked && (
        // The count ticks to its new value as items are decided (research #2); the sentence is the text equivalent, and number-flow
        // snaps under reduced motion.
        <p id="write-blocked-reason" className="mr-auto text-xs text-danger max-md:mr-0">
          <AnimatedNumber value={blockedCount} /> {blockedCount === 1 ? 'item' : 'items'} to fix before writing
        </p>
      )}
      <div className="flex items-center gap-2 max-md:w-full">
        <Button variant="danger" onClick={onReject} disabled={busy} className="max-md:min-h-11">
          <X className="h-3.5 w-3.5" />
          Reject
        </Button>
        <Tooltip content={canWriteToAdo ? 'Write the reviewed items to Azure DevOps' : 'Sign in with an Azure DevOps org URL and PAT to write'}>
          <span className="max-md:flex-1">
            <Button
              variant="cta"
              onClick={onWrite}
              softDisabled={blocked}
              aria-describedby={blocked ? 'write-blocked-reason' : undefined}
              disabled={busy || !canWriteToAdo}
              className="max-md:min-h-11 max-md:w-full"
            >
              <Upload className="h-3.5 w-3.5" />
              Write to Azure DevOps
            </Button>
          </span>
        </Tooltip>
      </div>
    </section>
  );
}
