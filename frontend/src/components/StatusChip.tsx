import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { jobStatusLabel } from '../utils/labels';

// DESIGN.md §7, Chip / Badge: a soft fill with tinted ink, the same look as the Knowledge Base chips. The label carries the state; the
// colour only reinforces it (§13). Neutral states use the recessed surface with the secondary ink.
const NEUTRAL = { bg: 'var(--color-surface-alt)', color: 'var(--color-ink-2)' };
const LIVE = { bg: 'var(--color-live-soft)', color: 'var(--color-ink-1)' };
const INFO = { bg: 'var(--color-info-soft)', color: 'var(--color-info-ink)' };
const OK = { bg: 'var(--color-ok-soft)', color: 'var(--color-ok-ink)' };
const DANGER = { bg: 'var(--color-danger-soft)', color: 'var(--color-danger-ink)' };

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  pending: { label: 'Pending', ...NEUTRAL },
  running: { label: 'Running', ...LIVE },
  // DESIGN.md §12: sentence case everywhere -- was 'Diff Ready', the one
  // Title Case label among this map's siblings (ActionBadge/KbCitationChips
  // both use sentence case already).
  diff_ready: { label: 'Diff ready', ...INFO },
  writing: { label: 'Writing', ...LIVE },
  succeeded: { label: 'Written', ...OK },
  failed: { label: 'Failed', ...DANGER },
  rejected: { label: 'Rejected', ...NEUTRAL },
  cancelled: { label: 'Cancelled', ...NEUTRAL },
  // NEW-05 batch/folder ingestion -- JobBatchFile's own pre-submit statuses,
  // reported as a file's "status" on the batch status page alongside every
  // real Job.status above (see BatchService.externalStatusOf).
  queued: { label: 'Queued', ...NEUTRAL },
  invalid: { label: 'Invalid', ...DANGER },
  submit_failed: { label: 'Submit failed', ...DANGER },
  // A file whose Job was individually deleted after being created --
  // Job.batchId/JobBatchFile.jobId are deliberately relation-free, so this
  // is a real, expected state, not a data-integrity error.
  deleted: { label: 'Deleted', ...NEUTRAL },
};

export function StatusChip({ status }: { status: string }): React.ReactElement {
  const config = STATUS_CONFIG[status] ?? { label: status, ...NEUTRAL };
  const { description } = jobStatusLabel(status);
  const chip = (
    <Chip bg={config.bg} color={config.color}>
      {config.label}
    </Chip>
  );
  return description ? <Tooltip content={description}>{chip}</Tooltip> : chip;
}
