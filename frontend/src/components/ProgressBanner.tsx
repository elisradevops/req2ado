import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import { ElapsedTimer } from './ElapsedTimer';
import type { JobStage } from '../api/events';

const STAGE_LABELS: Record<JobStage, string> = {
  parse: 'Parsing document...',
  infer_hierarchy_start: 'Analyzing structure...',
  infer_hierarchy_done: 'Structure analysis complete.',
  generate_requirements_start: 'Generating requirements...',
  generate_requirements_done: 'Finalizing...',
  diff_ready: 'Diff ready.',
  failed: 'Job failed.',
};

export function ProgressBanner({
  stage,
  startedAt,
  mode,
}: {
  stage: JobStage;
  startedAt: string;
  mode: 'baseline' | 'survey';
}): React.ReactElement {
  return (
    <Box p={2} bgcolor="background.paper">
      <Typography>{STAGE_LABELS[stage]}</Typography>
      <LinearProgress />
      <Typography variant="caption">
        Elapsed: <ElapsedTimer startedAt={startedAt} />
        {mode === 'survey' && ' — can take up to ~40 min'}
      </Typography>
    </Box>
  );
}
