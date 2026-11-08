import { Button } from '../ui/Button';
import type { WritePreview } from '../api/jobs';
import type { ApprovalBreakdown } from '../utils/approvalBreakdown';
import { writeSummaryLines, type WarningCounts } from '../utils/writeSummary';

export type WriteSummaryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; preview: WritePreview; review: ApprovalBreakdown };

function warningSentence(counts: WarningCounts): string | null {
  const open = [
    counts.open.fix > 0 ? `${counts.open.fix.toLocaleString()} ${counts.open.fix === 1 ? 'warning' : 'warnings'} to fix` : null,
    counts.open.review > 0 ? `${counts.open.review.toLocaleString()} to check` : null,
  ].filter((part): part is string => part !== null);
  const handled = counts.handled > 0 ? `${counts.handled.toLocaleString()} marked handled` : null;
  if (open.length === 0 && !handled) return null;
  const openCount = counts.open.fix + counts.open.review;
  const openText = open.length > 0 ? `${open.join(' and ')} ${openCount === 1 ? 'is' : 'are'} still open. You can still write.` : '';
  return [openText, handled ? `${handled}.` : ''].filter(Boolean).join(' ');
}

// One persistent status region (a region that is replaced is not announced): "Checking" while loading, the outcome once ready.
function statusText(state: WriteSummaryState): string {
  if (state.status === 'loading') return 'Checking what will be written…';
  if (state.status === 'error') return '';
  const total = state.preview.createdTotal;
  return total === 0
    ? 'Ready: nothing will be created, so there is nothing to write.'
    : `Ready: ${total.toLocaleString()} ${total === 1 ? 'item' : 'items'} will be created.`;
}

// The final summary inside the write confirmation (P17d): where the items go, what will be created and linked, what is left out, and how
// the reviewer reviewed them. The numbers are the server's (the write's own rules); this only shows them. Reading it never blocks the write.
export function WriteSummary({
  state,
  teamProject,
  areaPath,
  warnings,
  onBackToTree,
}: {
  state: WriteSummaryState;
  teamProject: string | null;
  areaPath: string | null;
  warnings: WarningCounts;
  onBackToTree: () => void;
}): React.ReactElement {
  const destination = areaPath ?? teamProject;
  const warningText = warningSentence(warnings);
  return (
    <div className="flex flex-col gap-2 text-sm">
      {destination && (
        <p className="text-ink-2">
          Destination: <bdi className="font-medium text-ink-1 [overflow-wrap:anywhere]">{destination}</bdi>
        </p>
      )}
      <p role="status" className={state.status === 'loading' ? 'text-ink-2' : 'sr-only'}>
        {statusText(state)}
      </p>
      {state.status === 'error' && (
        <p role="alert" className="text-warning-ink">
          Couldn&apos;t check what will be written. You can still write.
        </p>
      )}
      {state.status === 'ready' && (
        <ul className="flex flex-col gap-1.5 rounded-md border border-hairline bg-surface-alt p-2.5">
          {writeSummaryLines(state.preview, state.review).map((line) => (
            <li key={line.id} className={line.tone === 'notice' ? 'text-warning-ink' : 'text-ink-1'}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
      {warningText && <p className="text-warning-ink">{warningText}</p>}
      <div>
        <Button size="sm" variant="ghost" className="max-md:min-h-11" onClick={onBackToTree}>
          Back to the tree
        </Button>
      </div>
    </div>
  );
}
