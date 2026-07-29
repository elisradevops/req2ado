import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { jobStatusLabel } from '../utils/labels';

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'var(--color-ink-2)' },
  running: { label: 'Running', color: 'var(--color-live)' },
  diff_ready: { label: 'Diff Ready', color: 'var(--color-info)' },
  writing: { label: 'Writing', color: 'var(--color-live)' },
  succeeded: { label: 'Succeeded', color: 'var(--color-ok)' },
  failed: { label: 'Failed', color: 'var(--color-danger)' },
  rejected: { label: 'Rejected', color: 'var(--color-ink-2)' },
  cancelled: { label: 'Cancelled', color: 'var(--color-ink-2)' },
};

export function StatusChip({ status }: { status: string }): React.ReactElement {
  const config = STATUS_CONFIG[status] ?? { label: status, color: 'var(--color-ink-2)' };
  const { description } = jobStatusLabel(status);
  const chip = (
    <Chip bg={config.color} color="#fff">
      {config.label}
    </Chip>
  );
  return description ? <Tooltip content={description}>{chip}</Tooltip> : chip;
}
