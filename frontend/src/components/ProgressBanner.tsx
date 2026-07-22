import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import { ElapsedTimer } from './ElapsedTimer';
import type { JobStage, NarrationEvent } from '../api/events';

const STAGE_LABELS: Record<JobStage, string> = {
  parse: 'Parsing document...',
  infer_hierarchy_start: 'Analyzing structure...',
  infer_hierarchy_done: 'Structure analysis complete.',
  generate_requirements_start: 'Generating requirements...',
  generate_requirements_done: 'Finalizing...',
  diff_ready: 'Diff ready.',
  failed: 'Job failed.',
};

// Short sub-labels shown next to the currently-active section in the step
// list -- the narration message itself is more verbose (includes block
// counts), this is just "which of the section's three passes is running".
const PHASE_SUBLABEL: Record<NarrationEvent['phase'], string> = {
  infer_hierarchy: 'Analyzing structure',
  generate_requirements: 'Generating requirements',
  score_requirements: 'Scoring quality',
  infer_trace_links: 'Resolving trace links',
};

// Fraction of ONE section's own work considered done once a given phase
// STARTS (not finishes) -- e.g. seeing "generate_requirements" start means
// this section's hierarchy pass already finished, so that section is
// already ~40% through its own three passes. Used only to give the overall
// bar partial credit WITHIN the currently-running section, instead of the
// bar sitting frozen at the previous section's total for however long that
// section's three passes take (the actual bug being fixed here: blocksDone
// only updates once a WHOLE section finishes, which can be many minutes).
const PHASE_START_WEIGHT: Record<NarrationEvent['phase'], number> = {
  infer_hierarchy: 0,
  generate_requirements: 0.4,
  score_requirements: 0.75,
  infer_trace_links: 1,
};

export function ProgressBanner({
  stage,
  startedAt,
  mode,
  narrations,
}: {
  stage: JobStage;
  startedAt: string;
  mode: 'baseline' | 'survey';
  // SURVEY-only, richer per-step narration (see NarrationEvent) -- undefined/
  // empty falls back to the coarse stage-only display below, matching
  // pre-narration behavior exactly (BASELINE never produces these at all).
  narrations?: NarrationEvent[];
}): React.ReactElement {
  const latest = narrations && narrations.length > 0 ? narrations[narrations.length - 1] : null;

  // Estimated overall progress: fully-completed sections' share of the
  // document, plus partial credit for however far the CURRENT section has
  // gotten through its own three passes. `blocksDone` alone (completed
  // sections only) freezes at the same value for a section's entire
  // multi-minute duration -- this is a genuine estimate, not an exact
  // count, since sections vary in real size and this assumes an even split.
  let progressValue: number | undefined;
  if (latest && latest.blocksTotal > 0) {
    const averageSectionShare = latest.branchCount > 0 ? latest.blocksTotal / latest.branchCount : 0;
    const withinSectionCredit = averageSectionShare * PHASE_START_WEIGHT[latest.phase];
    progressValue = (100 * (latest.blocksDone + withinSectionCredit)) / latest.blocksTotal;
  }

  return (
    <Box p={2} bgcolor="background.paper">
      <Typography>{latest ? latest.message : STAGE_LABELS[stage]}</Typography>
      {progressValue !== undefined ? (
        <LinearProgress variant="determinate" value={Math.min(progressValue, 100)} />
      ) : (
        <LinearProgress />
      )}
      <Typography variant="caption">
        Elapsed: <ElapsedTimer startedAt={startedAt} />
        {mode === 'survey' && ' — can take up to ~40 min'}
      </Typography>
      {latest && <SectionStepList latest={latest} />}
    </Box>
  );
}

// Replaces a raw scrolling log of every narration message (which read as
// noise -- repeated phrasing, no sense of overall position) with a step
// list: one row per document section, plus a final "Resolving trace links"
// step. Each row is done / active / pending -- the same shape a person
// reads at a glance in a CI pipeline view, matched to what THIS pipeline
// actually does per section (infer hierarchy -> generate requirements ->
// score quality) rather than a generic percentage.
function SectionStepList({ latest }: { latest: NarrationEvent }): React.ReactElement {
  const sections = Array.from({ length: latest.branchCount }, (_, i) => i);
  const traceLinksActive = latest.phase === 'infer_trace_links';

  return (
    <Stack mt={1.5} spacing={0.5}>
      {sections.map((i) => {
        const isDone = traceLinksActive || i < (latest.branchIndex ?? -1);
        const isActive = !traceLinksActive && i === latest.branchIndex;
        return (
          <Stack key={i} direction="row" spacing={1} alignItems="center">
            {isDone ? (
              <CheckCircleIcon fontSize="small" color="success" />
            ) : isActive ? (
              <CircularProgress size={16} thickness={5} />
            ) : (
              <RadioButtonUncheckedIcon fontSize="small" color="disabled" />
            )}
            <Typography
              variant="body2"
              color={isActive ? 'text.primary' : isDone ? 'text.secondary' : 'text.disabled'}
              fontWeight={isActive ? 600 : 400}
            >
              Section {i + 1} of {latest.branchCount}
              {isActive && ` — ${PHASE_SUBLABEL[latest.phase]}`}
            </Typography>
          </Stack>
        );
      })}
      <Stack direction="row" spacing={1} alignItems="center">
        {traceLinksActive ? (
          <CircularProgress size={16} thickness={5} />
        ) : (
          <RadioButtonUncheckedIcon fontSize="small" color="disabled" />
        )}
        <Typography
          variant="body2"
          color={traceLinksActive ? 'text.primary' : 'text.disabled'}
          fontWeight={traceLinksActive ? 600 : 400}
        >
          Resolving trace links
        </Typography>
      </Stack>
    </Stack>
  );
}
