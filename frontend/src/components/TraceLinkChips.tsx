import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';

interface TraceLinkView {
  displayName: string;
  targetKind: 'intraJob' | 'crossJob';
  targetLocalId?: string;
  targetCustomerId?: string;
  resolvedAdoId?: number;
  resolutionStatus: 'resolved' | 'unresolved' | 'pending';
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
}: {
  links?: TraceLinkView[];
  // Optional -- omitting it just means every intraJob link with no other
  // resolution falls back to showing its raw internal id (the old
  // behavior), so this is backward compatible with every existing caller.
  titles?: Record<string, string>;
}): React.ReactElement | null {
  if (!links || links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {links.map((link, i) => {
        const target = resolveTarget(link, titles);
        const chip = (
          <Chip
            data-resolution-status={link.resolutionStatus}
            bg={link.resolutionStatus === 'unresolved' ? 'var(--color-warning)' : 'var(--color-surface-alt)'}
            color={link.resolutionStatus === 'unresolved' ? '#fff' : 'var(--color-ink-2)'}
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
          <span key={`${link.displayName}-${i}`} className="inline-flex">
            {content ? <Tooltip content={content}>{chip}</Tooltip> : chip}
          </span>
        );
      })}
    </div>
  );
}
