import { Button } from '../ui/Button';
import type { WritePreview } from '../api/jobs';
import type { ApprovalBreakdown } from '../utils/approvalBreakdown';
import { isFiguresOnlyWrite, remainingLinksPhrase, writeSummaryLines, type WarningCounts } from '../utils/writeSummary';

export type WriteSummaryState =
  | { status: 'loading' }
  | { status: 'error'; reason?: 'timeout' }
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
  const remaining = total === 0 ? remainingLinksPhrase(state.preview) : null;
  if (remaining) return `Ready: nothing new to create; ${remaining}.`;
  if (isFiguresOnlyWrite(state.preview)) {
    const figures = state.preview.figuresToAttach;
    return `No new items will be created. ${figures.toLocaleString()} ${figures === 1 ? 'figure' : 'figures'} will be attached to their items in Azure DevOps.`;
  }
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
  onReviewUnreviewed,
  onShowWarnings,
  onShowExcluded,
}: {
  state: WriteSummaryState;
  teamProject: string | null;
  areaPath: string | null;
  warnings: WarningCounts;
  // Shortcuts that take the reviewer to the thing to deal with first; each shows only when it applies and its callback is given.
  onReviewUnreviewed?: () => void;
  onShowWarnings?: () => void;
  onShowExcluded?: () => void;
}): React.ReactElement {
  const destination = areaPath ?? teamProject;
  const warningText = warningSentence(warnings);
  const unreviewed = state.status === 'ready' ? state.review.notReviewed : 0;
  const excluded = state.status === 'ready' ? state.preview.excluded.direct + state.preview.excluded.viaAncestor : 0;
  const fixCount = warnings.open.fix;
  const actions = [
    unreviewed > 0 && onReviewUnreviewed
      ? { id: 'review', label: `Review ${unreviewed.toLocaleString()} unreviewed ${unreviewed === 1 ? 'item' : 'items'}`, run: onReviewUnreviewed }
      : null,
    fixCount > 0 && onShowWarnings
      ? { id: 'warnings', label: `Go to ${fixCount.toLocaleString()} ${fixCount === 1 ? 'warning' : 'warnings'} to fix`, run: onShowWarnings }
      : null,
    excluded > 0 && onShowExcluded
      ? { id: 'excluded', label: `Show the ${excluded.toLocaleString()} excluded ${excluded === 1 ? 'item' : 'items'}`, run: onShowExcluded }
      : null,
  ].filter((action): action is { id: string; label: string; run: () => void } => action !== null);
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
          {state.reason === 'timeout'
            ? 'The check took too long. You can still write, or close this and try again.'
            : "Couldn't check what will be written. You can still write."}
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
      {actions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-ink-2">Before you write:</p>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button key={action.id} size="sm" variant="outline" className="max-md:min-h-11" onClick={action.run}>
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
