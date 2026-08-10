import { TriangleAlert } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { qualityIssueLabel } from '../utils/labels';

// Uniform warning-amber pill for every issue code -- matches the approved
// diff-tree design: a quality flag always means "needs attention," so one
// consistent color communicates that better than a different arbitrary hue
// per issue code (the previous per-code rainbow map this replaced). Label
// text and the fix-oriented explanation both come from the shared label map
// (utils/labels.ts) so the diff tree and the detail panel never disagree.
export function IssueChips({ issues }: { issues: string[] | undefined }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {(issues ?? []).map((issue) => {
        const { label, description } = qualityIssueLabel(issue);
        return (
          <Tooltip key={issue} content={description || label}>
            {/* DESIGN.md §10: lucide-react only -- was a bare Unicode "▲"
                glyph, the one place in the app expressing "risk flag" with
                text instead of the real icon DiffTree.tsx/
                CollapsibleWarnings.tsx already use for the same concept. */}
            <Chip bg="#FDF3E6" color="var(--color-warning)" className="border border-[#EED8B4]">
              <TriangleAlert className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
              {label}
            </Chip>
          </Tooltip>
        );
      })}
    </div>
  );
}
