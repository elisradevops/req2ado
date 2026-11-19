import { Check, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { Disclosure } from '../ui/Disclosure';
import { cn } from '../lib/cn';
import type { ItemIssue } from '../utils/itemIssues';

// What needs the reviewer on one item, one plain sentence each (DESIGN.md §11.4.5). Absent, not empty, when there is nothing to say. Severity
// is carried by the icon and the order, never by colour alone.
const ICON = { fix: CircleAlert, review: TriangleAlert, info: Info } as const;
const TONE = { fix: 'text-danger-ink', review: 'text-warning-ink', info: 'text-ink-2' } as const;

export function IssuesList({ issues, onAsk, onReview, showWhenClean = false }: { issues: ItemIssue[]; onAsk?: () => void; onReview?: () => void; showWhenClean?: boolean }): React.ReactElement | null {
  // A scored item with nothing wrong still says so when asked (`showWhenClean`), so the text under it keeps its place as the reviewer steps
  // from item to item. An item that was never scored is not "clean": nothing was checked, so the caller does not ask and the scoring row says so.
  if (issues.length === 0) {
    return showWhenClean ? (
      <p data-testid="issues-clean" className="flex items-center gap-2 px-2.5 py-1.5 text-sm text-ink-3">
        <Check aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
        No issues flagged.
      </p>
    ) : null;
  }
  return (
    <ul aria-label="Issues" className="flex flex-col gap-1.5 rounded-sm border border-hairline bg-surface-alt p-2.5">
      {issues.map((issue) => {
        const Icon = ICON[issue.severity];
        return (
          <li key={issue.id} data-testid={`issue-${issue.id}`} className={cn('flex flex-col gap-1 text-sm', TONE[issue.severity])}>
            <span className="flex items-start gap-2">
              <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 flex-none" />
              <span className="min-w-0 flex-1">{issue.text}</span>
              {issue.reviewable && onReview && (
                <Button size="sm" variant="ghost" className="flex-none" onClick={onReview}>
                  Review change
                </Button>
              )}
              {issue.askable && onAsk && (
                <Button size="sm" variant="ghost" className="flex-none" onClick={onAsk}>
                  Fix with assistant
                </Button>
              )}
            </span>
            {issue.why && (
              <Disclosure title="Why">
                <p className="p-2.5 text-xs text-ink-2">{issue.why}</p>
              </Disclosure>
            )}
          </li>
        );
      })}
    </ul>
  );
}
