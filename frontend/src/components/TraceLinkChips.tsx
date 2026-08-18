import { RefreshCw, Check } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../lib/cn';

interface TraceLinkView {
  referenceName: string;
  displayName: string;
  targetKind: 'intraJob' | 'crossJob';
  targetLocalId?: string;
  targetCustomerId?: string;
  resolvedAdoId?: number;
  resolutionStatus: 'resolved' | 'unresolved' | 'pending';
}

// A JobTraceLinkFailure row (see jobsStore.TraceLinkFailure), narrowed to
// just what's needed to match it to a link and drive its retry. The caller
// (NodeDetailPanel) has already filtered this down to failures for the
// SAME entry these links belong to (matching on sourceLocalId) -- this
// component only needs to further match on referenceName below.
interface TraceLinkFailureView {
  id: string;
  referenceName: string;
}

interface ResolvedTarget {
  kind: 'ado' | 'customer' | 'title' | 'raw';
  text: string;
}

// Priority mirrors targetLabel's old fallback chain, with one addition:
// an intraJob link's targetLocalId (e.g. "br0_n7") means nothing to a user
// on its own -- it's this SURVEY job's own internal branch-node id, not
// anything they recognize. When the target is another node THIS job
// produced, resolve it to that node's real title via `titles` (a
// localId -> title lookup built once in JobDetail.tsx from the full diff
// array) instead of showing the raw id.
function resolveTarget(link: TraceLinkView, titles: Record<string, string> | undefined): ResolvedTarget {
  if (link.resolvedAdoId != null) return { kind: 'ado', text: `WI-${link.resolvedAdoId}` };
  if (link.targetCustomerId) return { kind: 'customer', text: link.targetCustomerId };
  if (link.targetLocalId) {
    const title = titles?.[link.targetLocalId];
    if (title) return { kind: 'title', text: title };
    return { kind: 'raw', text: link.targetLocalId };
  }
  return { kind: 'raw', text: '?' };
}

export function TraceLinkChips({
  links,
  titles,
  failures,
  retryStatus,
  onRetry,
}: {
  links?: TraceLinkView[];
  // Optional -- omitting it just means every intraJob link with no other
  // resolution falls back to showing its raw internal id (the old
  // behavior), so this is backward compatible with every existing caller.
  titles?: Record<string, string>;
  // Task 4: failure rows for the entry these links belong to (already
  // filtered by sourceLocalId -- see NodeDetailPanel). Matched to a link on
  // referenceName ALONE, not the full (sourceLocalId, referenceName,
  // targetAdoId) key the backend uses -- an intraJob link only carries the
  // OTHER node's localId here, not its resolved real ADO id, and this
  // component has no diff-wide lookup to resolve that itself. A same-
  // source, same-reference-name collision across two DIFFERENT failed
  // targets can still bind a chip to the "wrong" one of the two failures --
  // an acceptable, documented limitation not worth the extra plumbing (a
  // full diffByLocalId lookup) to close for this feature. What is NOT
  // acceptable, and IS guarded against below (consumedFailureIds): letting
  // two DIFFERENT chips resolve to the SAME failure id. Without that guard,
  // retrying chip 1 deletes its failure row server-side and marks it
  // 'done'; retrying chip 2 (which reused chip 1's already-consumed id)
  // then 404s against the now-gone row, and the catch handler clears
  // retryStatus for that shared id -- silently REVERTING chip 1 back to a
  // failed/clickable state even though it already succeeded, while chip
  // 2's real underlying failure is never retried at all. Tracking consumed
  // ids while mapping over `links` prevents two chips from ever sharing one
  // failure id, eliminating that revert/double-fire bug entirely.
  failures?: TraceLinkFailureView[];
  // failureId -> in-flight/done status, owned by the caller (NodeDetailPanel)
  // same convention as its own figureAttachStatus.
  retryStatus?: Record<string, 'retrying' | 'done'>;
  onRetry?: (failureId: string) => void;
}): React.ReactElement | null {
  if (!links || links.length === 0) return null;
  // Task 4 fix: shared across the whole map below (NOT re-created per
  // link) so that once a failure row is bound to one chip, no later chip
  // in this same render can bind to that same id -- see the `failures`
  // prop's own doc comment for the corruption this prevents.
  const consumedFailureIds = new Set<string>();
  return (
    <div className="flex flex-wrap gap-1">
      {links.map((link, i) => {
        const target = resolveTarget(link, titles);
        const failure = failures?.find((f) => f.referenceName === link.referenceName && !consumedFailureIds.has(f.id));
        if (failure) consumedFailureIds.add(failure.id);
        const status = failure ? retryStatus?.[failure.id] : undefined;
        const failed = failure != null && status !== 'done';
        const chip = (
          <Chip
            data-resolution-status={link.resolutionStatus}
            data-write-status={failure ? (status === 'done' ? 'retried' : 'failed') : undefined}
            bg={failed ? 'var(--color-danger-soft)' : link.resolutionStatus === 'unresolved' ? 'var(--color-warning)' : 'var(--color-surface-alt)'}
            color={failed ? 'var(--color-danger-ink)' : link.resolutionStatus === 'unresolved' ? '#fff' : 'var(--color-ink-2)'}
          >
            {link.displayName} →{' '}
            {target.kind === 'ado' || target.kind === 'customer' ? (
              <span className="font-mono">{target.text}</span>
            ) : target.kind === 'title' ? (
              <span className="max-w-[220px] truncate">“{target.text}”</span>
            ) : (
              <span className="font-mono">{target.text}</span>
            )}
          </Chip>
        );
        // Only wrap in a Tooltip when there's something worth explaining --
        // an ado/customer id is already self-explanatory, a resolved title
        // is shown in full unless truncated (rare), but a raw internal id
        // needs the "what is this" context every time.
        const content =
          target.kind === 'raw'
            ? "Internal id for an item this job produced -- its title isn't available in this view yet."
            : target.kind === 'title' && target.text.length > 40
              ? target.text
              : null;
        return (
          <span key={`${link.displayName}-${i}`} className="inline-flex items-center gap-1">
            {content ? <Tooltip content={content}>{chip}</Tooltip> : chip}
            {/* Manual retry for a trace link whose write to Azure DevOps
                failed during confirm() -- see JobsService.retryTraceLinkWrite
                and NodeDetailPanel's handleRetryTraceLinkClick (same
                in-flight/done status convention as its figure-attach
                button). Stays visible (as a done checkmark, not hidden)
                after a successful retry, mirroring the Figures section's
                "Uploaded" treatment. */}
            {failure && onRetry && (
              <Tooltip content={status === 'done' ? 'Retried -- written to Azure DevOps.' : 'This trace link failed to write to Azure DevOps. Retry?'}>
                <button
                  type="button"
                  aria-label={`Retry writing "${link.displayName}" trace link to Azure DevOps`}
                  disabled={status === 'retrying' || status === 'done'}
                  onClick={() => onRetry(failure.id)}
                  className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-ink-3 hover:bg-surface-alt hover:text-ink-1 disabled:cursor-default disabled:opacity-60"
                >
                  {status === 'done' ? (
                    <Check className="h-3 w-3" style={{ color: 'var(--color-ok)' }} />
                  ) : (
                    <RefreshCw className={cn('h-3 w-3', status === 'retrying' && 'animate-spin')} />
                  )}
                </button>
              </Tooltip>
            )}
          </span>
        );
      })}
    </div>
  );
}
