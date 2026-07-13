import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import { tagColor } from '../utils/tagColors';

export function TagChips({ tags }: { tags: string[] | undefined }): React.ReactElement {
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap">
      {(tags ?? []).map((tag) => (
        <Chip key={tag} label={tag} size="small" sx={{ backgroundColor: tagColor(tag), color: '#fff' }} />
      ))}
    </Stack>
  );
}
