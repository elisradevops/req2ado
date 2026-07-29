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
            <Chip bg="#FDF3E6" color="var(--color-warning)" className="border border-[#EED8B4]">
              ▲ {label}
            </Chip>
          </Tooltip>
        );
      })}
    </div>
  );
}
