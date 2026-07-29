import { Chip } from '../ui/Chip';

// Soft bordered status pills (not solid fills) -- matches the approved
// diff-tree mockup: "New" / "Links to WI-####" / "Near-duplicate of
// WI-####" read as status, not warnings, so they use light tints with a
// matching border rather than the loud solid CREATE/REUSE/SKIP blocks
// this replaced. dedup_skip's match confidence lives on a separate
// per-job audit endpoint (getDedupSkips / dedupSkipAudit), not on this
// entry -- shown in NodeDetailPanel, not fabricated here.
export function ActionBadge({ action, existingAdoId }: { action: 'create' | 'reuse' | 'dedup_skip'; existingAdoId?: number | null }): React.ReactElement {
  if (action === 'create') {
    return (
      <Chip bg="#E8F6EC" color="var(--color-ok)" className="border border-[#B7E0C3]">
        New
      </Chip>
    );
  }
  if (action === 'reuse') {
    return (
      <Chip bg="#EAF0FB" color="var(--color-navy-600)" className="border border-[#C3D2ED]">
        {`Links to WI-${existingAdoId ?? '?'}`}
      </Chip>
    );
  }
  return (
    <Chip bg="var(--color-surface-alt)" color="var(--color-ink-3)" className="border border-hairline-strong">
      {existingAdoId != null ? `Near-duplicate of WI-${existingAdoId}` : 'Near-duplicate'}
    </Chip>
  );
}
