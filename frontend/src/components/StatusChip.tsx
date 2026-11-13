import { CircleCheck, CircleDashed, CircleDotDashed, CircleX, type LucideIcon } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { jobStatusLabel } from '../utils/labels';

// DESIGN.md §7, Chip / Badge: a soft fill with tinted ink, the same look as the Knowledge Base chips. The label carries the state; the
// colour only reinforces it (§13). Neutral states use the recessed surface with the secondary ink.
const NEUTRAL = { bg: 'var(--color-surface-alt)', color: 'var(--color-ink-2)' };
const LIVE = { bg: 'var(--color-live-soft)', color: 'var(--color-ink-1)' };
const DANGER = { bg: 'var(--color-danger-soft)', color: 'var(--color-danger-ink)' };
// The four job states (DESIGN.md §2): each has its own token, icon and word, so the state never rests on colour alone (§13).
const PROPOSED = { bg: 'var(--color-job-proposed-soft)', color: 'var(--color-job-proposed)', icon: CircleDashed };
const WRITTEN = { bg: 'var(--color-job-written-soft)', color: 'var(--color-job-written)', icon: CircleCheck };
const PARTIAL = { label: 'Partly written', bg: 'var(--color-job-partial-soft)', color: 'var(--color-job-partial)', icon: CircleDotDashed };
const FAILED = { bg: 'var(--color-job-failed-soft)', color: 'var(--color-job-failed)', icon: CircleX };
const PARTIAL_DESCRIPTION = 'Some items were written before the write stopped. Writing again resumes from there and does not create duplicates.';

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string; icon?: LucideIcon }> = {
  pending: { label: 'Pending', ...NEUTRAL },
  running: { label: 'Running', ...LIVE },
  // DESIGN.md §12: sentence case everywhere -- was 'Diff Ready', the one
  // Title Case label among this map's siblings (ActionBadge/KbCitationChips
  // both use sentence case already).
  diff_ready: { label: 'Diff ready', ...PROPOSED },
  writing: { label: 'Writing', ...LIVE },
  succeeded: { label: 'Written', ...WRITTEN },
  failed: { label: 'Failed', ...FAILED },
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

// `partial`: a job in review that already wrote some items in an earlier attempt (createdItemCount > 0), shown as "Partly written".
export function StatusChip({ status, partial = false }: { status: string; partial?: boolean }): React.ReactElement {
  const config = partial && status === 'diff_ready' ? PARTIAL : (STATUS_CONFIG[status] ?? { label: status, ...NEUTRAL });
  const description = partial && status === 'diff_ready' ? PARTIAL_DESCRIPTION : jobStatusLabel(status).description;
  const Icon = config.icon;
  const chip = (
    // A live status change (Diff ready -> Writing -> Written) eases its colours at --motion-feedback; the word changes with it.
    <Chip bg={config.bg} color={config.color} className="transition-[background-color,color] ease-out [transition-duration:var(--motion-feedback)]">
      {Icon && <Icon className="h-3 w-3 flex-none" aria-hidden="true" />}
      {config.label}
    </Chip>
  );
  return description ? <Tooltip content={description}>{chip}</Tooltip> : chip;
}
