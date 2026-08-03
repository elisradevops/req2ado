import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { MODE_COPY } from './ModeCards';

// Previously unexplained once a job existed -- ModeCards' picker (job
// creation) already has full copy for SURVEY vs BASELINE, but this badge
// (job list/detail headers, seen long after creation) had no tooltip at
// all. Reuses the exact same MODE_COPY description, not new content.
export function ModeBadge({ mode }: { mode: 'baseline' | 'survey' }): React.ReactElement {
  return (
    <Tooltip content={MODE_COPY[mode].description}>
      <Chip className="border border-navy-300/60 font-mono text-[10.5px] tracking-wide text-navy-600" bg="transparent">
        {mode === 'survey' ? 'SURVEY' : 'BASELINE'}
      </Chip>
    </Tooltip>
  );
}
