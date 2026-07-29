import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';
import { ChevronDown, ChevronRight, TriangleAlert, Link2, SquareArrowOutUpRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { ActionBadge } from './ActionBadge';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { Checkbox } from '../ui/Checkbox';
import { InfoTip } from '../ui/Tooltip';
import type { WorkItemTypeCatalogEntry } from '../api/ado';

// Rows are now pure information (exclude toggle, clause id, type+title,
// action state, a compact issue/trace-link count, a details button) -- all
// the per-node detail that used to live inline (tags, quality gauge/issues,
// trace link chips, KB citations) moved into NodeDetailDialog. Fixed height
// is the direct payoff: no more per-row measurement (MeasuredRow/sizeMap/
// resetAfterIndex) since a single-line row never wraps.
const ROW_HEIGHT = 40;

// Fallback clause-column width when no entry has a customerId yet (or
// document is unavailable, e.g. SSR/tests) -- matches the approved
// design's own fallback.
const FALLBACK_CLAUSE_WIDTH = 44;
const FALLBACK_STATUS_WIDTH = 108;

// Used only before the container's real height is first measured (see
// useContainerHeight below) -- react-window's `height` prop must be a
// concrete number, it can't take a CSS value directly.
const FALLBACK_LIST_HEIGHT = 600;

// react-window needs a real pixel height, but the tree's actual available
// space depends on the viewport and everything else on the page (header,
// stat tiles, warnings, toolbar) -- a hardcoded 600 either wastes space on
// a tall monitor or gets clipped on a short one. Measures the wrapping
// container (which gets a CSS viewport-relative height) via ResizeObserver
// and feeds that real number to FixedSizeList.
function useContainerHeight(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(FALLBACK_LIST_HEIGHT);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = (): void => setHeight(el.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, height];
}

export interface DryRunDiffEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId?: number | null;
  customerId: string | null;
  tags?: string[];
  qualityScore?: number | null;
  qualityIssues?: string[];
  // Per-dimension 0-100 breakdown backing qualityScore -- a dynamic
  // key->score map (NOT a fixed 5-field shape), see ingestion's
  // quality_category_scores docstring (app.workitem.model): an org's
  // ingested KB checklist can define its own category names. undefined/
  // null whenever qualityScore itself is (BASELINE, no scoring_client, or
  // a malformed scoring entry).
  qualityCategoryScores?: Record<string, number> | null;
  childType?: string | null;
  excluded?: boolean;
  isManual?: boolean;
  traceLinks?: {
    sourceLocalId: string;
    referenceName: string;
    displayName: string;
    targetKind: 'intraJob' | 'crossJob';
    targetLocalId?: string;
    targetCustomerId?: string;
    resolvedAdoId?: number;
    resolutionStatus: 'resolved' | 'unresolved' | 'pending';
  }[];
  // Document provenance -- computed server-side (pipeline.worker.ts) and
  // shipped on every entry, but never rendered anywhere in the frontend
  // until now (see NodeDetailPanel's Sources block). null for manually-added
  // entries (addDiffEntry), which have no source document position.
  sourceRef?: {
    documentPath: string;
    startOffset: number;
    endOffset: number;
    page: number | null;
  } | null;
}

interface FlatRow {
  entry: DryRunDiffEntry;
  depth: number;
  hasChildren: boolean;
  // Ancestor localIds, root-first -- lets the collapse filter below hide a
  // row when ANY ancestor (not just its immediate parent) is collapsed.
  ancestorIds: string[];
}

function buildFlatRows(entries: DryRunDiffEntry[]): FlatRow[] {
  const byParent = new Map<string | null, DryRunDiffEntry[]>();
  const idSet = new Set(entries.map((entry) => entry.localId));
  for (const entry of entries) {
    const parentKey = entry.parentLocalId && idSet.has(entry.parentLocalId) ? entry.parentLocalId : null;
    const siblings = byParent.get(parentKey) ?? [];
    siblings.push(entry);
    byParent.set(parentKey, siblings);
  }
  const rows: FlatRow[] = [];
  function visit(parentKey: string | null, depth: number, ancestorIds: string[]): void {
    for (const entry of byParent.get(parentKey) ?? []) {
      const hasChildren = byParent.has(entry.localId);
      rows.push({ entry, depth, hasChildren, ancestorIds });
      visit(entry.localId, depth + 1, [...ancestorIds, entry.localId]);
    }
  }
  visit(null, 0, []);
  return rows;
}

// Clause-id column width is measured from the real content, not guessed --
// a fixed pixel value fits "3.2.1" but clips "3.2.1.a" the moment a
// document numbers one level deeper. Since react-window renders each row
// as an independent absolutely-positioned element (not siblings in one CSS
// Grid), the column can't self-size via `grid-template-columns: auto`
// across rows -- it has to be measured once from all entries and applied
// as a CSS custom property on a shared ancestor, which every row then
// reads via `var(--clause-w)`.
function useClauseColumnWidth(entries: DryRunDiffEntry[]): number {
  return useMemo(() => {
    if (typeof document === 'undefined') return FALLBACK_CLAUSE_WIDTH;
    const measurer = document.createElement('span');
    measurer.style.cssText =
      'position:absolute;visibility:hidden;white-space:nowrap;font-family:var(--font-mono);font-size:12px;letter-spacing:-0.02em;';
    document.body.appendChild(measurer);
    let widest = 0;
    for (const entry of entries) {
      measurer.textContent = entry.customerId ?? '';
      widest = Math.max(widest, measurer.getBoundingClientRect().width);
    }
    document.body.removeChild(measurer);
    return widest > 0 ? Math.ceil(widest) + 18 : FALLBACK_CLAUSE_WIDTH;
  }, [entries]);
}

// Confirmed real bug (screenshot): the Status column's fixed 108px was
// sized for "New", not for the widest real label this column ever
// renders -- "Near-duplicate of WI-123456" clips mid-word. Same fix shape
// as useClauseColumnWidth above: react-window renders each row as an
// independent absolutely-positioned element, so the column can't
// self-size via `grid-template-columns: auto` across rows -- measured
// once from every entry's real label and applied as a CSS custom
// property every row reads via `var(--status-w)`.
function useStatusColumnWidth(entries: DryRunDiffEntry[]): number {
  return useMemo(() => {
    if (typeof document === 'undefined') return FALLBACK_STATUS_WIDTH;
    const measurer = document.createElement('span');
    measurer.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:12px;font-weight:600;';
    document.body.appendChild(measurer);
    let widest = 0;
    for (const entry of entries) {
      const label =
        entry.action === 'create'
          ? 'New'
          : entry.action === 'reuse'
            ? `Links to WI-${entry.existingAdoId ?? '?'}`
            : entry.existingAdoId != null
              ? `Near-duplicate of WI-${entry.existingAdoId}`
              : 'Near-duplicate';
      measurer.textContent = label;
      widest = Math.max(widest, measurer.getBoundingClientRect().width);
    }
    document.body.removeChild(measurer);
    // Chip's own horizontal padding+border (px-2 + 1px border each side =
    // 18px) plus a small buffer so text never sits flush against the
    // pill's edge.
    return widest > 0 ? Math.ceil(widest) + 18 + 8 : FALLBACK_STATUS_WIDTH;
  }, [entries]);
}

// Shared grid template for both the sticky header and every data row --
// guarantees pixel-exact column alignment (a single source of truth, not
// two hand-kept-in-sync definitions). exclude / clause id / elastic item /
// status / flags / details-button.
const GRID_TEMPLATE_COLUMNS = '32px var(--clause-w, 44px) minmax(0,1fr) var(--status-w, 108px) 60px 36px';

export function DiffTree({
  entries,
  selectedId,
  onSelect,
  onOpenDetails,
  filterAction,
  filterText,
  onToggleExclude,
  typeCatalog,
}: {
  entries: DryRunDiffEntry[];
  selectedId: string | null;
  onSelect: (localId: string) => void;
  // Opens the details dialog for a node -- distinct from onSelect (which
  // just moves the lightweight selection cursor, e.g. via arrow keys)
  // since a row click/Enter and the explicit details button both need to
  // trigger the SAME dialog-open behavior. Falls back to onSelect when
  // omitted so existing callers/tests that only care about selection are
  // unaffected.
  onOpenDetails?: (localId: string) => void;
  filterAction: string | null;
  filterText: string;
  onToggleExclude: (localId: string, excluded: boolean) => void;
  // Real per-project work-item-type colors/icons, when available (see
  // useWorkItemTypeCatalog) -- undefined falls back to WorkItemTypeBadge's
  // own hardcoded color map.
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
}): React.ReactElement {
  // Collapsed parent nodes -- purely a display concern (not lifted to
  // JobDetail), so toggling one never touches the diff data itself.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const toggleCollapsed = useCallback((localId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(localId)) next.delete(localId);
      else next.add(localId);
      return next;
    });
  }, []);

  const isFiltering = !!filterAction || !!filterText;

  const rows = useMemo(() => {
    const allRows = buildFlatRows(entries);
    return allRows.filter((row) => {
      const matchesAction = !filterAction || row.entry.action === filterAction;
      const matchesText = !filterText || row.entry.title.toLowerCase().includes(filterText.toLowerCase());
      if (!matchesAction || !matchesText) return false;
      // A search/filter in progress auto-expands -- hiding a real match
      // under a collapsed ancestor would look like the filter silently
      // missed it. Collapse state only applies when browsing unfiltered.
      if (isFiltering) return true;
      return !row.ancestorIds.some((ancestorId) => collapsedIds.has(ancestorId));
    });
  }, [entries, filterAction, filterText, isFiltering, collapsedIds]);

  const clauseColumnWidth = useClauseColumnWidth(entries);
  const statusColumnWidth = useStatusColumnWidth(entries);

  const listRef = useRef<FixedSizeList>(null);

  const [heightRef, listHeight] = useContainerHeight();

  function openDetails(localId: string): void {
    (onOpenDetails ?? onSelect)(localId);
  }

  // ArrowUp/ArrowDown move selection between currently-VISIBLE rows (post
  // filter/collapse) and scroll the new selection into view -- a virtualized
  // list has no native browser tab-order between its (mostly unmounted) rows
  // to rely on. Skip when the keypress originated in the checkbox/text
  // inputs above the tree (search field, action select) or the row's own
  // exclude checkbox, so arrow keys still work normally for editing there.
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (rows.length === 0) return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'BUTTON') return;
    event.preventDefault();
    const currentIndex = rows.findIndex((row) => row.entry.localId === selectedId);
    const nextIndex =
      event.key === 'ArrowDown'
        ? Math.min(rows.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex === -1 ? 0 : currentIndex - 1);
    onSelect(rows[nextIndex].entry.localId);
    listRef.current?.scrollToItem(nextIndex);
  }

  return (
    <div style={{ '--clause-w': `${clauseColumnWidth}px`, '--status-w': `${statusColumnWidth}px` } as React.CSSProperties}>
      {/* Sticky header row -- shares GRID_TEMPLATE with every data row below
          so columns always line up exactly. */}
      <div
        className="grid items-center gap-2.5 border-b border-hairline bg-surface-alt px-3.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3"
        style={{ gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}
      >
        <span />
        <span className="text-right">Clause</span>
        <span>Item</span>
        <span className="flex items-center gap-1">
          Status
          <InfoTip content="What will happen to this item on Confirm: New (written to ADO for the first time), Links to an existing WI-#### (reused, nothing new written), or Near-duplicate of an existing item (skipped)." />
        </span>
        <span className="flex items-center justify-end gap-1">
          Flags
          <InfoTip content="Quick counts for this item: a triangle shows how many quality issues were flagged (open it for details), a link icon shows how many trace links it has." />
        </span>
        <span />
      </div>
      <div
        ref={heightRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        role="tree"
        className="h-[calc(100vh-400px)] min-h-[280px] focus:outline-none"
      >
        <FixedSizeList ref={listRef} height={listHeight} width="100%" itemCount={rows.length} itemSize={ROW_HEIGHT}>
          {({ index, style }) => {
            const row = rows[index];
            const entry = row.entry;
            const issueCount = entry.qualityIssues?.length ?? 0;
            const traceLinkCount = entry.traceLinks?.length ?? 0;
            return (
              <div
                style={{ ...style, gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}
                role="treeitem"
                aria-selected={entry.localId === selectedId}
                className={cn(
                  // canvas (the app's default page tint) reads as almost
                  // no feedback at all against the surface-white rows
                  // around it -- a slightly stronger, slightly warmer
                  // tint plus a left accent rule makes hover/selection
                  // both unmistakable without competing with the signal
                  // ("decision needed") color.
                  'grid cursor-pointer items-center gap-2.5 border-l-2 border-l-transparent border-b border-b-hairline/60 px-3.5 transition-colors hover:border-l-navy-300 hover:bg-[#EEF3FC]',
                  entry.localId === selectedId && 'border-l-navy-600 bg-[#E7EFFC]',
                  entry.excluded && 'opacity-50',
                )}
                onClick={() => {
                  onSelect(entry.localId);
                  openDetails(entry.localId);
                }}
                data-excluded={entry.excluded ? 'true' : 'false'}
              >
                <span onClick={(e) => e.stopPropagation()} className="flex justify-center">
                  <Checkbox
                    ariaLabel={`Exclude ${entry.customerId ?? entry.title}`}
                    checked={!!entry.excluded}
                    onCheckedChange={(checked) => onToggleExclude(entry.localId, checked)}
                  />
                </span>

                {/* Clause id column -- width scales to the widest id actually present (see useClauseColumnWidth) */}
                <span className="text-right font-mono text-xs tabular-nums tracking-tight text-ink-3">{entry.customerId}</span>

                {/* Item column: indent guides -> chevron -> type badge -> title, all single-line (truncated, not
                    wrapped -- fixed row height demands it; full title/description is one click away in the
                    details dialog). */}
                <div className="flex min-w-0 items-center">
                  {Array.from({ length: row.depth }).map((_, i) => (
                    <span key={i} className="flex w-[18px] flex-none justify-center self-stretch">
                      <span className="w-px bg-hairline" />
                    </span>
                  ))}
                  {row.hasChildren && !isFiltering && (
                    <button
                      type="button"
                      aria-label={collapsedIds.has(entry.localId) ? `Expand ${entry.title}` : `Collapse ${entry.title}`}
                      aria-expanded={!collapsedIds.has(entry.localId)}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(entry.localId);
                      }}
                      className="-ml-1 flex-none rounded-sm p-0.5 text-ink-3 hover:bg-hairline-strong/40 hover:text-ink-1"
                    >
                      {collapsedIds.has(entry.localId) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  <span className="ml-1 flex min-w-0 flex-1 items-center gap-2">
                    <WorkItemTypeBadge type={entry.type} catalogEntry={typeCatalog?.[entry.type]} />
                    <p className={cn('min-w-0 flex-1 truncate text-sm font-medium leading-snug', entry.excluded && 'line-through text-ink-3')}>
                      {entry.title}
                    </p>
                  </span>
                </div>

                {/* overflow-hidden -- this span IS the 108px grid track (the
                    row is a CSS grid, not flex), so it already clips
                    anything wider. Without it, a long reuse/dedup_skip
                    label ("Near-duplicate of WI-12345") on Chip's own
                    whitespace-nowrap (shared by every Chip usage in the
                    app, so not changed here) painted past the column
                    boundary into the Signals column next to it. */}
                <span className="flex-none overflow-hidden">
                  <ActionBadge action={entry.action} existingAdoId={entry.existingAdoId} />
                </span>

                {/* Signals: compact count-only chips, not the full chip
                    wrap this replaced -- something-needs-attention
                    scanning without reintroducing wrapped rows. Full
                    detail (which issues, which links) lives in the
                    details dialog. */}
                <span className="flex flex-none items-center justify-end gap-2 text-xs">
                  {issueCount > 0 && (
                    <span className="flex items-center gap-0.5 text-warning" title={`${issueCount} quality issue(s)`}>
                      <TriangleAlert className="h-3.5 w-3.5" />
                      {issueCount}
                    </span>
                  )}
                  {traceLinkCount > 0 && (
                    <span className="flex items-center gap-0.5 text-ink-3" title={`${traceLinkCount} trace link(s)`}>
                      <Link2 className="h-3.5 w-3.5" />
                      {traceLinkCount}
                    </span>
                  )}
                </span>

                <span className="flex justify-center">
                  <button
                    type="button"
                    aria-label={`Details for ${entry.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(entry.localId);
                      openDetails(entry.localId);
                    }}
                    className="rounded-sm p-1 text-ink-3 hover:bg-hairline-strong/40 hover:text-ink-1"
                  >
                    <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            );
          }}
        </FixedSizeList>
      </div>
    </div>
  );
}
