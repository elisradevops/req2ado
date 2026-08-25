import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { tagColor } from '../utils/tagColors';
import { requirementTagLabel } from '../utils/labels';

// Same Tooltip-wrapping pattern as IssueChips.tsx -- these tags previously
// rendered as raw snake_case strings with no explanation, unlike every other
// jargon surface in this app (quality issues, mode badges, warnings).
//
// `winningTag`: when more than one tag is present, only one can ever be
// written to ADO's own classification field (it's single-valued) -- see
// utils/requirementClassification.ts's resolveWinningTag, which decides the
// same priority order the backend actually writes with. Marking it here
// lets a reviewer see the full classification AND which one lands in ADO,
// in one view, rather than picking a value and finding out later.
export function TagChips({ tags, winningTag }: { tags: string[] | undefined; winningTag?: string | null }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {(tags ?? []).map((tag) => {
        const { label, description } = requirementTagLabel(tag);
        const isWinner = tag === winningTag;
        return (
          <Tooltip key={tag} content={isWinner ? `${description || label} -- written to ADO's Requirement Type field` : description || label}>
            <Chip bg={tagColor(tag)} color="#fff" className={isWinner ? 'ring-2 ring-offset-1 ring-ink-1' : undefined}>
              {label}
              {isWinner ? ' →' : ''}
            </Chip>
          </Tooltip>
        );
      })}
    </div>
  );
}
