import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';
import { ChevronDown, ChevronRight, TriangleAlert, Link2, Table, Image, SquareArrowOutUpRight } from 'lucide-react';
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
  // Per-category citation text backing a SUBSET of qualityCategoryScores'
  // keys -- maps a category key to the org's own ingested quality-
  // checklist document's stated definition for it, when one was found
  // (see ingestion's quality_category_checklist docstring, app.workitem.
  // model). Not all-or-nothing like qualityCategoryScores: a category
  // absent from this map is a real, expected case (no KB standard at all,
  // or the org's document states no separate definition for that one
  // category), not a parse failure -- see QualityGauge.categoryDescription.
  qualityCategoryChecklist?: Record<string, string> | null;
  // CR-7d rescore: true from the moment a description edit invalidates the
  // score above until a successful rescore clears it -- the last-known
  // numbers are KEPT (never zeroed), only their freshness is in question.
  // See QualityGauge's Stale rendering.
  qualityStale?: boolean;
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
    // See sourceRef.ts's SourceRefLike for what each of these means --
    // same shape, just duplicated here since DryRunDiffEntry doesn't import
    // that type. Optional/nullable so an entry from before Phase 5 (or a
    // manually-added one) renders identically to today.
    sectionPath?: string[];
    pageEnd?: number | null;
    pageProvenance?: string | null;
  } | null;
  // Which JobFigureFile row(s) (see orchestrator's DryRunDiffEntry.figureIds
  // doc comment) this entry's description cited -- lets NodeDetailPanel show
  // this entry's OWN referenced figure(s) inline (thumbnail + caption +
  // manual "Upload to ADO" action), distinct from FigureDescriptions'
  // document-wide list of every figure in the source file. Empty/absent for
  // an entry whose description didn't reference any figure, or a manually-
  // added entry (addDiffEntry), which has no source document position at
  // all.
  figureIds?: string[];
  // Sibling of figureIds for tables -- same "folded into this node's
  // description" relationship, but a table's content already renders as a
  // real HTML <table> via DescriptionMarkdown, so there is no image/upload
  // treatment for these, only an id chip (NodeDetailPanel's Sources block).
  tableIds?: string[];
  // Figures folded into this node whose caption failed/was dropped (vision
  // disabled, the vision call failed, or the model found no technical
  // content) -- DISJOINT from figureIds: a given figure id appears in
  // exactly one of the two lists, never both. Rendered as a visually
  // distinct amber chip (NodeDetailPanel) so a reviewer can see a figure was
  // captured but silently contributed nothing to this item's description,
  // instead of that gap being invisible.
  uncaptionedFigureIds?: string[];
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

// Shared, lazily-created 1x1 canvas used purely for text-metrics
// measurement -- CanvasRenderingContext2D.measureText() computes glyph
// width from font metrics without ever touching layout, unlike the
// DOM-append + getBoundingClientRect() approach this replaced (a forced
// synchronous reflow PER measured string). One canvas, created once,
// reused for every column-width recompute -- never appended to the DOM at
// all.
let measurerCanvasContext: CanvasRenderingContext2D | null | undefined;
function getMeasurerContext(): CanvasRenderingContext2D | null {
  if (measurerCanvasContext !== undefined) return measurerCanvasContext;
  measurerCanvasContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  return measurerCanvasContext;
}

// letterSpacing is Canvas2D Level 2 (supported in every browser this app
// targets -- Chromium/Firefox/Safari all shipped it years ago); omitting
// it on an unsupported engine just measures very slightly narrower text,
// never wider, so a stale/absent value can only ever make a column too
// narrow by a sub-pixel amount, not clip real content.
function measureTextWidth(text: string, font: string, letterSpacing?: string): number {
  const ctx = getMeasurerContext();
  if (!ctx) return 0;
  ctx.font = font;
  if (letterSpacing !== undefined && 'letterSpacing' in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = letterSpacing;
  }
  return ctx.measureText(text).width;
}

// Resolves a CSS custom property's real computed value ONCE (not once per
// measured string) -- canvas's `font` property cannot resolve a raw
// `var(--font-mono)` token itself, unlike a real DOM element's style.
function resolveCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
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
    const fontFamily = resolveCssVar('--font-mono', 'monospace');
    const font = `12px ${fontFamily}`;
    let widest = 0;
    for (const entry of entries) {
      widest = Math.max(widest, measureTextWidth(entry.customerId ?? '', font, '-0.02em'));
    }
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
    // No font-family in the original measurer's own inline style --
    // it inherited body's own font-sans (index.css's `body { @apply
    // ... font-sans }`), which this now resolves explicitly since canvas
    // has no ambient inheritance to fall back on.
    const fontFamily = resolveCssVar('--font-sans', 'sans-serif');
    const font = `600 12px ${fontFamily}`;
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
      widest = Math.max(widest, measureTextWidth(label, font));
    }
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
// Flags column widened from 60px -- it used to fit only the issue-count and
// trace-link-count chips; a table-count and a combined figure-count chip
// (Phase 5 provenance work) can now both show alongside them on the same
// row.
const GRID_TEMPLATE_COLUMNS = '32px var(--clause-w, 44px) minmax(0,1fr) var(--status-w, 108px) 100px 36px';

export function DiffTree({
  entries,
  selectedId,
  onSelect,
  onOpenDetails,
  filterAction,
  filterText,
  onToggleExclude,
  typeCatalog,
  orgUrl,
  project,
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
  // Turns a "Links to WI-####"/"Near-duplicate of WI-####" ActionBadge
  // into a real link to that item in Azure DevOps -- see ActionBadge's own
  // doc comment. Undefined/null (e.g. logged out) falls back to the
  // plain, non-linked chip.
  orgUrl?: string | null;
  // The job's team project (areaPath's first `\`-delimited segment) --
  // see buildWorkItemUrl's own docstring for why this matters.
  project?: string | null;
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

  // Unfiltered/uncollapsed rows -- kept separate from `rows` below so the
  // selectedId-driven effects further down can find a target's real
  // ancestorIds regardless of current collapse state (that's the whole
  // point: discovering which ancestors need to be UNcollapsed).
  const allRows = useMemo(() => buildFlatRows(entries), [entries]);

  const rows = useMemo(() => {
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
  }, [allRows, filterAction, filterText, isFiltering, collapsedIds]);

  const clauseColumnWidth = useClauseColumnWidth(entries);
  const statusColumnWidth = useStatusColumnWidth(entries);

  const listRef = useRef<FixedSizeList>(null);

  const [heightRef, listHeight] = useContainerHeight();

  function openDetails(localId: string): void {
    (onOpenDetails ?? onSelect)(localId);
  }

  // Real gap this closes (user-reported): a "jump to node" action from
  // outside the tree (e.g. CollapsibleWarnings' "Review item ->") only ever
  // set `selectedId` -- if the target row's ancestor chain happened to be
  // collapsed, it never rendered at all, so the jump looked like it did
  // nothing. Expands every collapsed ancestor of `selectedId` found in the
  // FULL (unfiltered/uncollapsed) row list; a no-op when nothing needs
  // expanding (e.g. arrow-key navigation between already-visible rows).
  useEffect(() => {
    if (!selectedId) return;
    const target = allRows.find((row) => row.entry.localId === selectedId);
    if (!target || target.ancestorIds.length === 0) return;
    setCollapsedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const ancestorId of target.ancestorIds) {
        if (next.delete(ancestorId)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedId, allRows]);

  // Scrolls the selected row into view. Depends on `rows` (not just
  // `selectedId`) so this re-runs with the FINAL post-expansion index once
  // the effect above finishes uncollapsing an ancestor -- using `rows` from
  // this same render would still reflect the stale, pre-expansion filtered
  // list and could scroll to the wrong position or find nothing at all.
  useEffect(() => {
    if (!selectedId) return;
    const index = rows.findIndex((row) => row.entry.localId === selectedId);
    if (index === -1) return;
    listRef.current?.scrollToItem(index, 'center');
  }, [selectedId, rows]);

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
        className="grid items-center gap-2.5 border-b border-hairline bg-surface-alt px-3.5 py-1.5 text-micro font-semibold uppercase tracking-wide text-ink-3"
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
          <InfoTip content="Quick counts for this item: a triangle shows how many quality issues were flagged (open it for details), a link icon shows how many trace links it has, a table icon shows how many tables fed it, and an image icon shows how many figures fed it (amber when one or more of those figures got no description)." />
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
            const tableCount = entry.tableIds?.length ?? 0;
            // ONE chip for figures total (captioned + uncaptioned combined),
            // not two -- keeps the Flags column from growing a second
            // figure-specific chip on top of the table one, per DESIGN.md's
            // own width-budget call. Tinted amber below when any of those
            // figures has no description, so the gap is visible without a
            // reviewer needing to open the details dialog first.
            const uncaptionedFigureCount = entry.uncaptionedFigureIds?.length ?? 0;
            const figureCount = (entry.figureIds?.length ?? 0) + uncaptionedFigureCount;
            return (
              <div
                style={{ ...style, gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}
                role="treeitem"
                aria-selected={entry.localId === selectedId}
                className={cn(
                  // DESIGN.md §6/§7 -- the shared row-hover system
                  // (.hoverable-row) replaces this row's previous one-off
                  // custom-hex tint + border-l edge; see palette.test.ts's
                  // baseline for DiffTree.tsx, lowered in the same change.
                  'hoverable-row grid cursor-pointer items-center gap-2.5 px-3.5',
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
                  <ActionBadge action={entry.action} existingAdoId={entry.existingAdoId} orgUrl={orgUrl} project={project} />
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
                  {tableCount > 0 && (
                    <span className="flex items-center gap-0.5 text-ink-3" title={`${tableCount} table(s)`}>
                      <Table className="h-3.5 w-3.5" />
                      {tableCount}
                    </span>
                  )}
                  {figureCount > 0 && (
                    <span
                      className={cn('flex items-center gap-0.5', uncaptionedFigureCount > 0 ? 'text-warning' : 'text-ink-3')}
                      title={
                        uncaptionedFigureCount > 0
                          ? `${figureCount} figure(s), ${uncaptionedFigureCount} without a description`
                          : `${figureCount} figure(s)`
                      }
                    >
                      <Image className="h-3.5 w-3.5" />
                      {figureCount}
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
