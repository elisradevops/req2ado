import { Chip } from '../ui/Chip';
import { buildWorkItemUrl } from '../utils/adoLinks';

// Soft bordered status pills (not solid fills) -- matches the approved
// diff-tree mockup: "New" / "Links to WI-####" / "Near-duplicate of
// WI-####" read as status, not warnings, so they use light tints with a
// matching border rather than the loud solid CREATE/REUSE/SKIP blocks
// this replaced. dedup_skip's match confidence lives on a separate
// per-job audit endpoint (getDedupSkips / dedupSkipAudit), not on this
// entry -- shown in NodeDetailPanel, not fabricated here.
//
// `orgUrl` (optional) turns a "Links to WI-####"/"Near-duplicate of
// WI-####" badge into a real link to that item in Azure DevOps -- a
// reviewer previously had no way to verify a dedup match themselves
// short of manually searching ADO by id. Same `${orgUrl}/_workitems/edit/
// {id}` URL shape CollapsibleWarnings.tsx already uses. Omitted (no
// orgUrl, e.g. logged out) falls back to the plain, non-linked chip.
export function ActionBadge({
  action,
  existingAdoId,
  orgUrl,
  project,
}: {
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId?: number | null;
  orgUrl?: string | null;
  // The job's team project (areaPath's first `\`-delimited segment) --
  // see buildWorkItemUrl's own docstring for why this matters.
  project?: string | null;
}): React.ReactElement {
  if (action === 'create') {
    return (
      <Chip bg="#E8F6EC" color="var(--color-ok)" className="border border-[#B7E0C3]">
        New
      </Chip>
    );
  }
  if (action === 'reuse') {
    const chip = (
      <Chip bg="#EAF0FB" color="var(--color-accent)" className="border border-[#C3D2ED]">
        {`Links to WI-${existingAdoId ?? '?'}`}
      </Chip>
    );
    if (existingAdoId == null || !orgUrl) return chip;
    return (
      <a href={buildWorkItemUrl(orgUrl, project, existingAdoId)} target="_blank" rel="noreferrer">
        {chip}
      </a>
    );
  }
  const chip = (
    <Chip bg="var(--color-surface-alt)" color="var(--color-ink-3)" className="border border-hairline-strong">
      {existingAdoId != null ? `Near-duplicate of WI-${existingAdoId}` : 'Near-duplicate'}
    </Chip>
  );
  if (existingAdoId == null || !orgUrl) return chip;
  return (
    <a href={buildWorkItemUrl(orgUrl, project, existingAdoId)} target="_blank" rel="noreferrer">
      {chip}
    </a>
  );
}
