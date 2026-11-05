import { cn } from '../lib/cn';
import { Chip } from '../ui/Chip';
import { buildWorkItemUrl } from '../utils/adoLinks';
import { actionLabel } from '../utils/labels';

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
  quiet = false,
  hideNew = false,
}: {
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId?: number | null;
  orgUrl?: string | null;
  // The job's team project (areaPath's first `\`-delimited segment) --
  // see buildWorkItemUrl's own docstring for why this matters.
  project?: string | null;
  // Plain text instead of a filled pill, for the phone row where most rows are routine and a pill on each would drown the ones that are not.
  // Same meaning; a real link stays a link (accent colour, underlined); everything else is muted. "Near-duplicate of" is shortened to "Dup of" so
  // the status always fits beside the other marks on a phone line; the full wording is the hover title, and a screen-reader suffix explains it.
  quiet?: boolean;
  // Desktop tree rows: nearly every row is a create, so a "New" pill on each
  // is noise and drowns the rows that differ (links, near-duplicates). The word
  // stays for screen readers; those other statuses keep their pill.
  hideNew?: boolean;
}): React.ReactElement {
  if (quiet) {
    const full = actionLabel({ action, existingAdoId });
    const isLink = action !== 'create' && existingAdoId != null && !!orgUrl;
    const text = (
      <span
        className={cn('flex-none whitespace-nowrap text-xs font-medium', isLink && action === 'reuse' ? 'text-accent' : 'text-ink-3', isLink && 'underline underline-offset-2')}
        title={full}
      >
        {action === 'dedup_skip' ? (existingAdoId != null ? `Dup of WI-${existingAdoId}` : 'Dup') : full}
        {/* the visible text stays inside the accessible name (WCAG 2.5.3); the suffix says what the abbreviation means */}
        {action === 'dedup_skip' && <span className="sr-only">, a skipped near-duplicate</span>}
      </span>
    );
    if (!isLink) return text;
    return (
      <a href={buildWorkItemUrl(orgUrl, project, existingAdoId)} target="_blank" rel="noreferrer" draggable={false} className="flex h-6 flex-none items-center">
        {text}
      </a>
    );
  }
  if (action === 'create') {
    if (hideNew) return <span className="sr-only">New</span>;
    return (
      <Chip bg="#E8F6EC" color="var(--color-ok)" className="border border-[#B7E0C3]">
        New
      </Chip>
    );
  }
  if (action === 'reuse') {
    // DESIGN.md §3's role table reserves the accent family for what's
    // "currently interactive-or-chosen" (incl. links) -- this chip is only
    // ever a real link when both an id and orgUrl are known; otherwise it's
    // plain status text and gets the same neutral palette dedup_skip's own
    // non-link chip below already uses.
    const isLink = existingAdoId != null && !!orgUrl;
    const label = actionLabel({ action, existingAdoId });
    const chip = isLink ? (
      <Chip bg="#EAF0FB" color="var(--color-accent)" className="border border-[#C3D2ED]">
        {label}
      </Chip>
    ) : (
      <Chip bg="var(--color-surface-alt)" color="var(--color-ink-3)" className="border border-hairline-strong">
        {label}
      </Chip>
    );
    if (!isLink) return chip;
    return (
      // draggable={false} -- <a href> is natively draggable by default in
      // every browser, independent of any ancestor's own `draggable`
      // attribute. Inside DiffTree's now-draggable rows (DESIGN.md §11.5),
      // grabbing a row on top of this link started the browser's own
      // link-drag gesture instead of the row's custom row-move drag --
      // same bug class as WorkItemTypeBadge's icon <img>, same fix.
      <a href={buildWorkItemUrl(orgUrl, project, existingAdoId)} target="_blank" rel="noreferrer" draggable={false}>
        {chip}
      </a>
    );
  }
  const chip = (
    <Chip bg="var(--color-surface-alt)" color="var(--color-ink-3)" className="border border-hairline-strong">
      {actionLabel({ action, existingAdoId })}
    </Chip>
  );
  if (existingAdoId == null || !orgUrl) return chip;
  return (
    // draggable={false} -- see the "reuse" branch above for why.
    <a href={buildWorkItemUrl(orgUrl, project, existingAdoId)} target="_blank" rel="noreferrer" draggable={false}>
      {chip}
    </a>
  );
}
