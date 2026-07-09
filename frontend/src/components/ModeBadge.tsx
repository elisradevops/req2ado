import Chip from '@mui/material/Chip';

export function ModeBadge({ mode }: { mode: 'baseline' | 'survey' }): React.ReactElement {
  return <Chip label={mode === 'survey' ? 'SURVEY' : 'BASELINE'} variant="outlined" size="small" />;
}
