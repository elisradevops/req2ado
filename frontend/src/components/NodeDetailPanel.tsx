import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { TagChips } from './TagChips';
import type { DryRunDiffEntry } from './DiffTree';

export function NodeDetailPanel({ entry }: { entry: DryRunDiffEntry | null }): React.ReactElement {
  if (!entry) {
    return <Box p={2}><Typography color="text.secondary">Select a node to view details.</Typography></Box>;
  }
  return (
    <Box p={2}>
      <Typography variant="overline">{entry.type}</Typography>
      <Typography variant="h6">{entry.title}</Typography>
      <Typography variant="body2">{entry.description}</Typography>
      <TagChips tags={entry.tags} />
    </Box>
  );
}
