import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { jobStatusLabel } from '../utils/labels';

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'var(--color-ink-2)' },
  running: { label: 'Running', color: 'var(--color-live)' },
  // DESIGN.md §12: sentence case everywhere -- was 'Diff Ready', the one
  // Title Case label among this map's siblings (ActionBadge/KbCitationChips
  // both use sentence case already).
  diff_ready: { label: 'Diff ready', color: 'var(--color-info)' },
  writing: { label: 'Writing', color: 'var(--color-live)' },
  succeeded: { label: 'Succeeded', color: 'var(--color-ok)' },
  failed: { label: 'Failed', color: 'var(--color-danger)' },
  rejected: { label: 'Rejected', color: 'var(--color-ink-2)' },
  cancelled: { label: 'Cancelled', color: 'var(--color-ink-2)' },
  // NEW-05 batch/folder ingestion -- JobBatchFile's own pre-submit statuses,
  // reported as a file's "status" on the batch status page alongside every
  // real Job.status above (see BatchService.externalStatusOf).
  queued: { label: 'Queued', color: 'var(--color-ink-2)' },
  invalid: { label: 'Invalid', color: 'var(--color-danger)' },
  submit_failed: { label: 'Submit failed', color: 'var(--color-danger)' },
  // A file whose Job was individually deleted after being created --
  // Job.batchId/JobBatchFile.jobId are deliberately relation-free, so this
  // is a real, expected state, not a data-integrity error.
  deleted: { label: 'Deleted', color: 'var(--color-ink-2)' },
};

export function StatusChip({ status }: { status: string }): React.ReactElement {
  const config = STATUS_CONFIG[status] ?? { label: status, color: 'var(--color-ink-2)' };
  const { description } = jobStatusLabel(status);
  const chip = (
    // var(--color-white), not a raw hex literal -- ProgressBanner.tsx
    // already uses this real token for the identical white-on-fill need.
    <Chip bg={config.color} color="var(--color-white)">
      {config.label}
    </Chip>
  );
  return description ? <Tooltip content={description}>{chip}</Tooltip> : chip;
}
