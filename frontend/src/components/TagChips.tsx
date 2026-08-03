import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { tagColor } from '../utils/tagColors';
import { requirementTagLabel } from '../utils/labels';

// Same Tooltip-wrapping pattern as IssueChips.tsx -- these tags previously
// rendered as raw snake_case strings with no explanation, unlike every other
// jargon surface in this app (quality issues, mode badges, warnings).
export function TagChips({ tags }: { tags: string[] | undefined }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {(tags ?? []).map((tag) => {
        const { label, description } = requirementTagLabel(tag);
        return (
          <Tooltip key={tag} content={description || label}>
            <Chip bg={tagColor(tag)} color="#fff">
              {label}
            </Chip>
          </Tooltip>
        );
      })}
    </div>
  );
}
