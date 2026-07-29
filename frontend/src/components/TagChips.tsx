import { Chip } from '../ui/Chip';
import { tagColor } from '../utils/tagColors';

export function TagChips({ tags }: { tags: string[] | undefined }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {(tags ?? []).map((tag) => (
        <Chip key={tag} bg={tagColor(tag)} color="#fff">
          {tag}
        </Chip>
      ))}
    </div>
  );
}
