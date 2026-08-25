import { useMemo, useState, type ReactNode } from 'react';
import { Popover } from 'radix-ui';
import { Search } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../ui/Button';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import type { WorkItemTypeCatalogEntry } from '../api/ado';

// DESIGN.md §11.5 -- the keyboard-accessible reparent path, and the
// intended path for any move requiring a scroll (native HTML5 DnD in
// DiffTree.tsx is deliberately scoped to short, in-viewport moves). Also
// backs AddChildForm's parent field (Phase 5) -- one filterable "find a
// node" component, not two independently-maintained ones.
export interface MoveToPickerCandidate {
  localId: string;
  type: string;
  title: string;
  // The Requirement's own Customer ID (e.g. "REQ-AV-014"), when the source
  // document assigns one -- a separate concept from the tree's purely
  // structural per-row index (see DiffTree.tsx). Filterable, same as title.
  customerId: string | null;
}

function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-signal px-0 text-signal-ink">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function matchesQuery(candidate: MoveToPickerCandidate, query: string): { hit: boolean; titleHit: boolean; customerIdHit: boolean } {
  const q = query.trim().toLowerCase();
  if (!q) return { hit: true, titleHit: false, customerIdHit: false };
  const titleHit = candidate.title.toLowerCase().includes(q);
  const customerIdHit = !!candidate.customerId && candidate.customerId.toLowerCase().includes(q);
  return { hit: titleHit || customerIdHit, titleHit, customerIdHit };
}

export function MoveToPicker({
  triggerLabel,
  triggerAriaLabel,
  triggerClassName,
  popoverLabel,
  candidates,
  allowRoot,
  rootLabel = 'Top level (no parent)',
  emptyText = 'No valid parent found here.',
  categoryLabels,
  typeCatalog,
  onSelect,
  disabled,
}: {
  triggerLabel: string;
  triggerAriaLabel?: string;
  triggerClassName?: string;
  popoverLabel?: string;
  candidates: MoveToPickerCandidate[];
  // Offers "Top level" as a selectable option, appended last -- omitted
  // entirely (not merely disabled) when the caller's own tier rules make
  // root placement illegal, e.g. a Requirement always requires a parent.
  allowRoot?: boolean;
  rootLabel?: string;
  emptyText?: string;
  categoryLabels?: Record<'Epic' | 'Feature' | 'Requirement', string>;
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
  onSelect: (localId: string | null) => void;
  disabled?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () => candidates.map((candidate) => ({ candidate, match: matchesQuery(candidate, query) })).filter((x) => x.match.hit),
    [candidates, query],
  );

  function select(localId: string | null): void {
    onSelect(localId);
    setOpen(false);
    setQuery('');
  }

  function realTypeName(category: string): string {
    return categoryLabels?.[category as 'Epic' | 'Feature' | 'Requirement'] ?? category;
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={triggerAriaLabel} disabled={disabled} className={triggerClassName}>
          {triggerLabel}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 w-80 rounded-sm border border-hairline-strong bg-surface p-2 shadow-popover">
          {popoverLabel && <div className="px-1.5 pb-1.5 text-xs text-ink-3">{popoverLabel}</div>}
          <div className="mb-1.5 flex items-center gap-1.5 border-b border-hairline px-1.5 pb-1.5">
            <Search className="h-3.5 w-3.5 flex-none text-ink-3" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title or customer ID…"
              className="w-full border-none bg-transparent py-0.5 text-sm text-ink-1 outline-none placeholder:text-ink-3"
            />
          </div>
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-sm text-ink-3">{query ? `Nothing matches "${query}".` : emptyText}</div>
            )}
            {filtered.map(({ candidate, match }) => (
              <button
                key={candidate.localId}
                type="button"
                onClick={() => select(candidate.localId)}
                className="hoverable-row flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-1"
              >
                <WorkItemTypeBadge type={candidate.type} catalogEntry={typeCatalog?.[realTypeName(candidate.type)]} />
                {candidate.customerId && (
                  <span className="flex-none font-mono text-xs text-ink-3">{highlightMatch(candidate.customerId, match.customerIdHit ? query : '')}</span>
                )}
                <span className={cn('min-w-0 flex-1 truncate', match.titleHit && !match.customerIdHit && 'font-medium')}>
                  {highlightMatch(candidate.title, match.titleHit ? query : '')}
                </span>
              </button>
            ))}
          </div>
          {allowRoot && (
            <div className="mt-1 border-t border-hairline pt-1">
              <button
                type="button"
                onClick={() => select(null)}
                className="hoverable-row flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm text-ink-2"
              >
                {rootLabel}
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
