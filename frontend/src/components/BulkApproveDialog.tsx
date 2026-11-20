import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';

export interface BulkApproveLeftOut {
  flagged: number;
  unscored: number;
  stale: number;
  // BASELINE: Epics and Features, which are never offered (checked one by one).
  structure?: number;
}

function itemsOf(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`;
}

// Confirmation for "Approve N clean items" (P17c). It states the rule in the words the queue
// uses -- "not flagged", never "verified" -- and keeps the approve action disabled until the
// reviewer has looked at the whole sample. Nothing here is focused except Cancel, so Enter or
// Space on opening never approves. The count shown is live; `notice` carries a failure to save.
// BASELINE items are verbatim and carry no score, so its copy names only the warnings it screens on
// and says plainly that nothing was scored (DESIGN.md §11.6).
export function BulkApproveDialog({
  mode = 'survey',
  open,
  onOpenChange,
  count,
  lowestScore,
  highestScore,
  leftOut,
  sampleSize,
  checkedCount,
  notice,
  onStartSpotCheck,
  onShowList,
  onApprove,
  returnFocusRef,
  restoreFocus,
}: {
  mode?: 'survey' | 'baseline';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  lowestScore: number | null;
  highestScore: number | null;
  leftOut: BulkApproveLeftOut;
  sampleSize: number;
  checkedCount: number;
  notice: string;
  onStartSpotCheck: () => void;
  onShowList: () => void;
  onApprove: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  restoreFocus?: boolean;
}): React.ReactElement {
  const checkedAll = checkedCount >= sampleSize;
  const cleanItems = `${count.toLocaleString()} clean ${count === 1 ? 'item' : 'items'}`;
  const range =
    lowestScore == null || highestScore == null
      ? ''
      : lowestScore === highestScore
        ? ` with score ${lowestScore}`
        : ` with scores ${lowestScore} to ${highestScore}`;
  const baseline = mode === 'baseline';
  const structure = leftOut.structure ?? 0;
  const reasons = (
    baseline
      ? [
          leftOut.flagged > 0 ? `${leftOut.flagged.toLocaleString()} with warnings` : null,
          structure > 0 ? `${structure.toLocaleString()} ${structure === 1 ? 'Epic or Feature' : 'Epics and Features'}, which you check one by one` : null,
        ]
      : [
          leftOut.flagged > 0 ? `${leftOut.flagged.toLocaleString()} flagged or with warnings` : null,
          leftOut.unscored > 0 ? `${leftOut.unscored.toLocaleString()} not scored` : null,
          leftOut.stale > 0 ? `${leftOut.stale.toLocaleString()} with an out-of-date score` : null,
        ]
  ).filter((reason): reason is string => reason !== null);
  const leftOutTotal = baseline ? leftOut.flagged + structure : leftOut.flagged + leftOut.unscored + leftOut.stale;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      restoreFocus={restoreFocus}
      title={`Approve ${cleanItems}?`}
      description={
        baseline ? (
          <>
            {itemsOf(count)} you have not reviewed yet. They are not flagged: no blocking or review warning. BASELINE items are copied
            word for word and are not scored, so this is a screen, not a judgment: check a sample first.
          </>
        ) : (
          <>
            {itemsOf(count)} you have not reviewed yet{range}. They are not flagged: no low score, low grounding or low model
            confidence, and no blocking or review warning. That is a screen, not a judgment, so you check a sample first.
          </>
        )
      }
      footer={
        <>
          {/* Wraps, so a long count does not push the buttons off a phone-width dialog. */}
          <div className="flex w-full flex-wrap justify-end gap-2.5">
            <Button variant="ghost" autoFocus onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onApprove} disabled={!checkedAll || count === 0} aria-describedby="bulk-approve-progress">
              {`Approve ${cleanItems}`}
            </Button>
          </div>
        </>
      }
    >
      <p className="text-sm text-ink-2">
        This only marks them reviewed. Nothing is written to Azure DevOps until you confirm the write, and you can undo it.
      </p>
      {leftOutTotal > 0 && (
        <p className="text-sm text-ink-2">
          {itemsOf(leftOutTotal)} left out: {reasons.join(', ')}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-surface-alt p-2.5 text-sm">
        <span id="bulk-approve-progress" className="me-auto text-ink-2">
          Spot-check: {Math.min(checkedCount, sampleSize).toLocaleString()} of {sampleSize.toLocaleString()} checked
        </span>
        {!checkedAll && (
          <Button size="sm" variant="outline" onClick={onStartSpotCheck}>
            {checkedCount > 0 ? 'Continue spot-check' : 'Start spot-check'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onShowList}>
          Show these items in the tree
        </Button>
      </div>
      <div role="alert" className="text-sm text-warning-ink empty:hidden">
        {notice}
      </div>
    </Dialog>
  );
}
