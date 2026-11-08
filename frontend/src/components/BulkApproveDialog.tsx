import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';

export interface BulkApproveLeftOut {
  flagged: number;
  unscored: number;
  stale: number;
}

function itemsOf(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`;
}

// Confirmation for "Approve N clean items" (P17c). It states the rule in the words the queue
// uses -- "not flagged", never "verified" -- and keeps the approve action disabled until the
// reviewer has looked at the whole sample. Nothing here is focused except Cancel, so Enter or
// Space on opening never approves. The count shown is live; `notice` carries a failure to save.
export function BulkApproveDialog({
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
}: {
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
}): React.ReactElement {
  const checkedAll = checkedCount >= sampleSize;
  const cleanItems = `${count.toLocaleString()} clean ${count === 1 ? 'item' : 'items'}`;
  const range =
    lowestScore == null || highestScore == null
      ? ''
      : lowestScore === highestScore
        ? ` with score ${lowestScore}`
        : ` with scores ${lowestScore} to ${highestScore}`;
  const reasons = [
    leftOut.flagged > 0 ? `${leftOut.flagged.toLocaleString()} flagged or with warnings` : null,
    leftOut.unscored > 0 ? `${leftOut.unscored.toLocaleString()} not scored` : null,
    leftOut.stale > 0 ? `${leftOut.stale.toLocaleString()} with an out-of-date score` : null,
  ].filter((reason): reason is string => reason !== null);
  const leftOutTotal = leftOut.flagged + leftOut.unscored + leftOut.stale;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Approve ${cleanItems}?`}
      description={
        <>
          {itemsOf(count)} you have not reviewed yet{range}. They are not flagged: no low score, low grounding or low model
          confidence, and no blocking or review warning. That is a screen, not a judgment, so you check a sample first.
        </>
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
        <span id="bulk-approve-progress" className="mr-auto text-ink-2">
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
