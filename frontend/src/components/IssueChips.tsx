import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import { issueColor } from '../utils/issueColors';

export function IssueChips({ issues }: { issues: string[] | undefined }): React.ReactElement {
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap">
      {(issues ?? []).map((issue) => (
        <Chip key={issue} label={issue} size="small" sx={{ backgroundColor: issueColor(issue), color: '#fff' }} />
      ))}
    </Stack>
  );
}
