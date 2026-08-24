import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';
import {
  DndContext,
  MouseSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core';
import {
  ChevronDown,
  ChevronRight,
  TriangleAlert,
  Link2,
  Table,
  Image,
  SquareArrowOutUpRight,
  GripVertical,
  EyeOff,
  Lock,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { moveValidationReason as sharedMoveValidationReason } from '../lib/moveValidation';
import { ActionBadge } from './ActionBadge';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { Checkbox } from '../ui/Checkbox';
import { Chip } from '../ui/Chip';
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
  // SUBSET of uncaptionedFigureIds -- the figures among that list the vision
  // model judged insignificant/decorative rather than a genuine vision-call
  // failure (see orchestrator's DryRunDiffEntry.insignificantFigureIds doc
  // comment). NodeDetailPanel uses this to split the uncaptioned-figure chip
  // rendering into two distinct treatments.
  insignificantFigureIds?: string[];
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
// two hand-kept-in-sync definitions). grip / exclude / clause id / elastic
// item / status / flags / details-button.
// Flags column widened from 60px -- it used to fit only the issue-count and
// trace-link-count chips; a table-count and a combined figure-count chip
// (Phase 5 provenance work) can now both show alongside them on the same
// row.
// DESIGN.md §11.5 -- the grip track is a CSS custom property, not a forked
// copy of this template string, so the header and every row stay driven by
// this ONE literal regardless of whether the current job can be moved
// (diff_ready) or not. `--grip-w` is set to 0px (not omitted) on the same
// wrapper that already carries `--clause-w`/`--status-w` when canMove is
// false, so columns still line up pixel-for-pixel either way.
const GRID_TEMPLATE_COLUMNS = 'var(--grip-w, 20px) 32px var(--clause-w, 44px) minmax(0,1fr) var(--status-w, 108px) 100px 36px';

// DESIGN.md §11.5 -- drag-and-drop is scoped to short, in-viewport moves;
// MoveToPicker (a separate component, not part of this file) is the stated
// path for anything requiring a scroll. Dropping in the top/bottom quarter
// of a row reorders as a sibling; the middle half reparents inside it.
const DROP_EDGE_FRACTION = 0.25;

type DropPosition = 'inside' | 'before' | 'after';

// Real bug fixed by switching to @dnd-kit/core (user-reported, live): native
// HTML5 drag-and-drop starts/continues a row-move gesture only when the
// BROWSER'S OWN drag arbitration lets it -- it silently loses to text
// selection over long titles, and to a native <img>/<a> drag the instant the
// pointer is over an icon or a link, no matter what this component does
// (`user-select: none`/`draggable={false}` narrowed but never closed the
// gap: "only the grip icon works reliably" was the exact symptom). dnd-kit's
// MouseSensor drives the whole gesture from mousedown/mousemove/mouseup
// instead of the browser's native dragstart/dragover/drop events,
// so none of that native-element arbitration is ever in the loop -- grabbing
// anywhere on the row (still guarded against interactive children below) is
// reliable everywhere, matching the approved mockup's own "grab anywhere"
// behavior.
function computeDropPosition(
  activeRect: { top: number; height: number },
  overRect: { top: number; height: number },
): DropPosition {
  const activeCenter = activeRect.top + activeRect.height / 2;
  const relative = overRect.height > 0 ? (activeCenter - overRect.top) / overRect.height : 0.5;
  if (relative < DROP_EDGE_FRACTION) return 'before';
  if (relative > 1 - DROP_EDGE_FRACTION) return 'after';
  return 'inside';
}

export interface DiffTreeMoveInput {
  parentLocalId: string | null;
  anchorLocalId?: string | null;
  placement?: 'before' | 'after';
}

export function DiffTree({
  entries,
  selectedId,
  onSelect,
  onOpenDetails,
  filterAction,
  filterText,
  onToggleExclude,
  typeCatalog,
  categoryLabels,
  orgUrl,
  project,
  onMove,
  canMove,
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
  // own hardcoded color map. Keyed by the project's REAL ADO type name
  // (e.g. 'User Story'), not by category -- see categoryLabels below.
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
  // Category ('Epic'/'Feature'/'Requirement', what entry.type always holds)
  // -> this project's real ADO type name. Pre-existing bug this fixes:
  // typeCatalog is keyed by real name, so indexing it directly by
  // entry.type silently missed on every non-CMMI project (where the
  // category and the real name differ, e.g. 'Requirement' vs 'User
  // Story') and fell back to WorkItemTypeBadge's hardcoded colors.
  // Undefined falls back to the identity map (CMMI-shaped labels).
  categoryLabels?: Record<'Epic' | 'Feature' | 'Requirement', string>;
  // Turns a "Links to WI-####"/"Near-duplicate of WI-####" ActionBadge
  // into a real link to that item in Azure DevOps -- see ActionBadge's own
  // doc comment. Undefined/null (e.g. logged out) falls back to the
  // plain, non-linked chip.
  orgUrl?: string | null;
  // The job's team project (areaPath's first `\`-delimited segment) --
  // see buildWorkItemUrl's own docstring for why this matters.
  project?: string | null;
  // DESIGN.md §11.5 -- reparent/reorder. Omitted (or canMove false) hides
  // the grip track entirely and disables dragging; the column still lines
  // up (--grip-w collapses to 0px) rather than shifting every other column.
  onMove?: (localId: string, input: DiffTreeMoveInput) => void;
  canMove?: boolean;
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
  //
  // Real gap this closes (user-reported): `rows` also changes identity on
  // every collapse/expand toggle (collapsedIds is one of its own memo deps,
  // see `rows`' own useMemo above) even when `selectedId` hasn't changed at
  // all -- collapsing/expanding an Epic elsewhere in the tree re-ran this
  // effect and yanked the viewport to re-center whatever row was last
  // selected, nowhere near the chevron the user just clicked (the chevron's
  // own handler deliberately calls stopPropagation and never touches
  // selectedId -- see its onClick below). `lastScrolledIdRef` makes this
  // effect fire once per REAL selection change, not once per `rows`
  // identity change: the early return on `index === -1` deliberately leaves
  // the ref unset, so the second render (once the ancestor-expand effect
  // above finishes uncollapsing) still performs the scroll for a genuinely
  // new selection.
  const lastScrolledIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId) {
      lastScrolledIdRef.current = null;
      return;
    }
    if (lastScrolledIdRef.current === selectedId) return;
    const index = rows.findIndex((row) => row.entry.localId === selectedId);
    if (index === -1) return;
    lastScrolledIdRef.current = selectedId;
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

  // Category ('Epic'/'Feature'/'Requirement') -> this project's real ADO
  // type name, for the WorkItemTypeBadge lookup below. Fails open to the
  // identity map so an unresolved catalog still shows CMMI-shaped labels
  // rather than crashing.
  const realTypeName = useCallback(
    (category: string): string => categoryLabels?.[category as 'Epic' | 'Feature' | 'Requirement'] ?? category,
    [categoryLabels],
  );

  // ---------------------------------------------------------------------
  // DESIGN.md §11.5 -- reparent/reorder via @dnd-kit/core. Scoped to short,
  // in-viewport moves (see DROP_EDGE_FRACTION above); MoveToPicker is the
  // supported path for anything crossing a scroll boundary.
  // ---------------------------------------------------------------------

  const byLocalId = useMemo(() => new Map(entries.map((entry) => [entry.localId, entry])), [entries]);

  // Shared with NodeDetailPanel's own keyboard-accessible "Move to..."
  // control (frontend/src/lib/moveValidation.ts) -- one validity rule for
  // both UI entry points, not two independently-drifting copies.
  const moveValidationReason = useCallback(
    (dragId: string, targetParentId: string | null) => sharedMoveValidationReason(entries, byLocalId, dragId, targetParentId),
    [entries, byLocalId],
  );

  // Ancestor chain has an excluded node above (not the entry itself) --
  // confirm()'s isExcluded() walks this exact chain server-side and drops
  // the whole subtree silently. Surfaced, not blocked (DESIGN.md §11.5).
  function hasExcludedAncestor(entry: DryRunDiffEntry): boolean {
    let cursor = entry.parentLocalId ? byLocalId.get(entry.parentLocalId) : undefined;
    while (cursor) {
      if (cursor.excluded) return true;
      cursor = cursor.parentLocalId ? byLocalId.get(cursor.parentLocalId) : undefined;
    }
    return false;
  }

  const sensors = useSensors(
    // MouseSensor, not PointerSensor -- this is a desktop reviewer tool
    // (touch input was never supported by the native HTML5 DnD this
    // replaced either), and mouse events give the same native-arbitration-
    // free pointer-driven gesture PointerSensor would, without pulling in
    // pointer-capture/touch-cancellation edge cases this app doesn't need.
    // A 4px activation threshold, not the bare mousedown, is what starts a
    // real drag -- this doubles as the click/drag disambiguation a plain
    // onClick handler needs (a genuine click never moves the pointer 4px,
    // so it never activates a drag at all).
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
  );
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  // Set to the row a drag ended OVER (self-drop included) so that row's own
  // onClick can ignore the click a browser may still fire when pointerdown
  // and pointerup land on the same element -- cleared on the next click.
  // Keyed by localId, not a bare boolean (CR: reparent review fix, carried
  // over from the native-DnD implementation this replaced) -- a bare
  // boolean suppressed the NEXT click on ANY row, not just the one the drag
  // ended over.
  const justCompletedDragRef = useRef<string | null>(null);

  function handleDragStart(event: DragStartEvent): void {
    setDragSourceId(String(event.active.id));
    setDropTarget(null);
  }

  function handleDragMove(event: DragMoveEvent): void {
    const { active, over } = event;
    if (!over) {
      setDropTarget(null);
      return;
    }
    const targetId = String(over.id);
    if (targetId === String(active.id)) {
      setDropTarget(null);
      return;
    }
    const activeRect = active.rect.current.translated ?? active.rect.current.initial;
    if (!activeRect) return;
    const position = computeDropPosition(activeRect, over.rect);
    setDropTarget((prev) => (prev?.id === targetId && prev.position === position ? prev : { id: targetId, position }));
  }

  function handleDragEnd(event: DragEndEvent): void {
    const dragId = String(event.active.id);
    setDragSourceId(null);
    setDropTarget(null);
    // Computed fresh from THIS event, not from the dropTarget state
    // onDragMove maintains for visual feedback -- dnd-kit's own onDragMove
    // callback reads `over` through an internal ref that trails the real
    // collision result by one render (confirmed empirically: its `over`
    // still pointed at the row the drag STARTED on, one tick after
    // collision detection had already resolved the real target), so
    // dropTarget is fine for a highlight a human never notices lagging by
    // one mousemove, but not precise enough to decide the actual move.
    // onDragEnd's own event.over/event.active.rect, by contrast, are
    // correct at the moment the mouse is released.
    const over = event.over;
    if (!over) return;
    const targetLocalId = String(over.id);
    justCompletedDragRef.current = targetLocalId;
    if (targetLocalId === dragId) return;
    const targetEntry = byLocalId.get(targetLocalId);
    if (!targetEntry) return;
    const activeRect = event.active.rect.current.translated ?? event.active.rect.current.initial;
    if (!activeRect) return;
    const position = computeDropPosition(activeRect, over.rect);
    const targetParentId = position === 'inside' ? targetLocalId : targetEntry.parentLocalId;
    if (moveValidationReason(dragId, targetParentId)) return;
    if (position === 'inside') {
      onMove?.(dragId, { parentLocalId: targetParentId });
    } else {
      onMove?.(dragId, { parentLocalId: targetParentId, anchorLocalId: targetLocalId, placement: position });
    }
  }

  function handleDragCancel(): void {
    setDragSourceId(null);
    setDropTarget(null);
  }

  return (
    <div
      style={
        {
          '--clause-w': `${clauseColumnWidth}px`,
          '--status-w': `${statusColumnWidth}px`,
          '--grip-w': canMove ? '20px' : '0px',
        } as React.CSSProperties
      }
    >
      {/* Sticky header row -- shares GRID_TEMPLATE with every data row below
          so columns always line up exactly. */}
      <div
        className="grid items-center gap-2.5 border-b border-hairline bg-surface-alt px-3.5 py-1.5 text-micro font-semibold uppercase tracking-wide text-ink-3"
        style={{ gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}
      >
        <span />
        <span />
        <span className="text-right">Clause</span>
        <span>Item</span>
        <span className="flex items-center gap-1">
          Status
          <InfoTip content="What will happen to this item on Confirm: New (written to ADO for the first time), Links to an existing WI-#### (reused, nothing new written, and it keeps its existing ADO parent regardless of where you place it in this tree), or Near-duplicate of an existing item (skipped, same parent-keeping rule)." />
        </span>
        <span className="flex items-center justify-end gap-1">
          Flags
          <InfoTip content="Quick counts for this item: a triangle shows how many quality issues were flagged (open it for details), a link icon shows how many trace links it has, a table icon shows how many tables fed it, and an image icon shows how many figures fed it (amber when one or more of those figures got no description)." />
        </span>
        <span />
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          ref={heightRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          role="tree"
          className="h-[calc(100vh-400px)] min-h-[280px] focus:outline-none"
        >
          <FixedSizeList
            ref={listRef}
            height={listHeight}
            width="100%"
            itemCount={rows.length}
            itemSize={ROW_HEIGHT}
            // Keyed by localId, not the default index -- a row dragged near
            // the viewport edge during a drag must keep its OWN DOM node as
            // the list scrolls (react-window's default index-based recycling
            // can otherwise reassign a scrolled-past row's DOM node to a
            // different entry mid-drag, which is how a source row can vanish
            // out from under an in-progress drag rather than just scrolling).
            // Also fixes a latent, unrelated bug: index-keyed rows reused DOM
            // across different entries after any dryRunDiff mutation.
            itemKey={(index) => rows[index].entry.localId}
            // More headroom while a drag is active so a source row surviving
            // a few rows of auto-scroll doesn't unmount before the drop lands
            // -- DESIGN.md §11.5 scopes DnD to short, in-viewport moves, this
            // just buys a bit more of "in-viewport" before that boundary hits.
            overscanCount={dragSourceId ? 8 : 2}
          >
            {({ index, style }) => (
              <DiffTreeRow
                row={rows[index]}
                style={style}
                selectedId={selectedId}
                onSelect={onSelect}
                openDetails={openDetails}
                onToggleExclude={onToggleExclude}
                typeCatalog={typeCatalog}
                realTypeName={realTypeName}
                orgUrl={orgUrl}
                project={project}
                canMove={!!canMove}
                isFiltering={isFiltering}
                collapsedIds={collapsedIds}
                toggleCollapsed={toggleCollapsed}
                byLocalId={byLocalId}
                moveValidationReason={moveValidationReason}
                hasExcludedAncestor={hasExcludedAncestor}
                dragSourceId={dragSourceId}
                dropTarget={dropTarget}
                justCompletedDragRef={justCompletedDragRef}
              />
            )}
          </FixedSizeList>
        </div>
      </DndContext>
    </div>
  );
}

function DiffTreeRow({
  row,
  style,
  selectedId,
  onSelect,
  openDetails,
  onToggleExclude,
  typeCatalog,
  realTypeName,
  orgUrl,
  project,
  canMove,
  isFiltering,
  collapsedIds,
  toggleCollapsed,
  byLocalId,
  moveValidationReason,
  hasExcludedAncestor,
  dragSourceId,
  dropTarget,
  justCompletedDragRef,
}: {
  row: FlatRow;
  style: React.CSSProperties;
  selectedId: string | null;
  onSelect: (localId: string) => void;
  openDetails: (localId: string) => void;
  onToggleExclude: (localId: string, excluded: boolean) => void;
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
  realTypeName: (category: string) => string;
  orgUrl?: string | null;
  project?: string | null;
  canMove: boolean;
  isFiltering: boolean;
  collapsedIds: Set<string>;
  toggleCollapsed: (localId: string) => void;
  byLocalId: Map<string, DryRunDiffEntry>;
  moveValidationReason: (dragId: string, targetParentId: string | null) => 'self' | 'cycle' | 'tier' | 'root-tier' | null;
  hasExcludedAncestor: (entry: DryRunDiffEntry) => boolean;
  dragSourceId: string | null;
  dropTarget: { id: string; position: DropPosition } | null;
  justCompletedDragRef: React.MutableRefObject<string | null>;
}): React.ReactElement {
  const entry = row.entry;
  // A row is both a drag source (useDraggable) and a drop target
  // (useDroppable) at once -- separate internal dnd-kit registries, same id
  // is fine, same as any sortable-list example.
  //
  // No <DragOverlay> -- the row itself follows the pointer via `transform`
  // below (dnd-kit's other supported pattern). This isn't just a style
  // choice: dnd-kit's own `event.active.rect.current`/`over.rect` (which
  // computeDropPosition above relies on for before/inside/after) measure
  // whatever a DragOverlay renders INSTEAD of the dragged node the moment
  // one exists (`draggingNodeRect = dragOverlay.rect ?? activeNodeRect`,
  // see @dnd-kit/core's own DndContext) -- a floating preview sized/
  // positioned differently from a 40px row would silently throw off the
  // before/inside/after math against this row's own real geometry.
  const { attributes, listeners, setNodeRef: setDragNodeRef, isDragging, transform } = useDraggable({
    id: entry.localId,
    disabled: !canMove,
  });
  const { setNodeRef: setDropNodeRef } = useDroppable({ id: entry.localId, disabled: !canMove });
  // useCallback, not a plain inline function -- both setDragNodeRef and
  // setDropNodeRef are themselves stable (dnd-kit's own useNodeRef wraps
  // them in useCallback([])), but an unstable COMBINED wrapper still isn't
  // free: React detaches (calls with null) then reattaches (calls with the
  // real node) any ref callback whose *identity* changes on a re-render,
  // even when the underlying DOM node hasn't moved. Real bug this fixes
  // (found live, not just a lint nit): useDroppable's own measuring is
  // gated on "is a drag active" -- while none is, that false detach/
  // reattach churn is inert, but the instant a drag starts, each row's
  // reattach re-triggers droppable-rect measurement, which schedules a
  // state update, which re-renders every row, which recreates every row's
  // still-unstable ref callback, which reattaches again -- a synchronous
  // render loop that pegs the tab the moment any drag activates.
  const setNodeRef = useCallback(
    (node: HTMLElement | null): void => {
      setDragNodeRef(node);
      setDropNodeRef(node);
    },
    [setDragNodeRef, setDropNodeRef],
  );

  const issueCount = entry.qualityIssues?.length ?? 0;
  const traceLinkCount = entry.traceLinks?.length ?? 0;
  const tableCount = entry.tableIds?.length ?? 0;
  // ONE chip for figures total (captioned + uncaptioned combined), not two
  // -- keeps the Flags column from growing a second figure-specific chip on
  // top of the table one, per DESIGN.md's own width-budget call. Tinted
  // amber below when any of those figures has no description, so the gap is
  // visible without a reviewer needing to open the details dialog first.
  // insignificantFigureIds (a SUBSET of uncaptionedFigureIds) are hidden
  // from the item detail view entirely (NodeDetailPanel.tsx) -- counting
  // them here would show a flag number higher than what a reviewer can
  // actually find by opening the item, exactly the "8 figures shown, only 4
  // real" bug report this excludes.
  const insignificantFigureCount = entry.insignificantFigureIds?.length ?? 0;
  const uncaptionedFigureCount = (entry.uncaptionedFigureIds?.length ?? 0) - insignificantFigureCount;
  const figureCount = (entry.figureIds?.length ?? 0) + uncaptionedFigureCount;
  // DESIGN.md §11.5 -- drop feedback. `inside` = valid reparent target;
  // `before`/`after` = valid reorder anchor; a rejected target (tier
  // violation, cycle, self) tints red instead of showing the accent
  // line/fill, so an invalid drop never looks draggable-here right up until
  // release.
  const isDropTarget = dropTarget?.id === entry.localId;
  const dropRejected =
    isDropTarget &&
    dragSourceId != null &&
    !!moveValidationReason(dragSourceId, dropTarget!.position === 'inside' ? entry.localId : entry.parentLocalId);
  const isSameTierParent = !!entry.parentLocalId && byLocalId.get(entry.parentLocalId)?.type === entry.type;
  const parentIsExcluded = hasExcludedAncestor(entry);

  // dnd-kit's MouseSensor listens for mousedown on whatever this spreads
  // onto -- guarded so grabbing an interactive child (exclude checkbox,
  // chevron, details button, ActionBadge link) starts THAT control's own
  // click/toggle, never a row drag.
  const guardedListeners = canMove
    ? {
        ...listeners,
        onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => {
          if ((event.target as HTMLElement).closest('button,input,[role="checkbox"],a')) return;
          listeners?.onMouseDown?.(event);
        },
      }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      {...(canMove ? attributes : undefined)}
      {...guardedListeners}
      style={{
        ...style,
        gridTemplateColumns: GRID_TEMPLATE_COLUMNS,
        // Row follows the pointer directly (no DragOverlay -- see the
        // comment on useDraggable above). zIndex keeps it painting over
        // whatever sibling row it's currently translated on top of --
        // react-window's own `style.zIndex` is unset, so without this the
        // row underneath (later in DOM order) would paint on top instead.
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        zIndex: isDragging ? 1 : undefined,
      }}
      role="treeitem"
      aria-selected={entry.localId === selectedId}
      // Row-level keyboard drag activation isn't wired up (MoveToPicker is
      // the keyboard-accessible reparent path per DESIGN.md §11.5) -- forced
      // to -1 so dnd-kit's own default tabIndex doesn't add every row as an
      // individual tab stop, which would change the tree's existing
      // container-level ArrowUp/ArrowDown navigation.
      tabIndex={-1}
      className={cn(
        // DESIGN.md §6/§7 -- the shared row-hover system (.hoverable-row)
        // replaces this row's previous one-off custom-hex tint + border-l
        // edge; see palette.test.ts's baseline for DiffTree.tsx, lowered in
        // the same change. `group` backs the grip's opacity-0/group-hover
        // visibility below -- not a new hover system, the same pattern
        // JobsList.tsx already ships and tests.
        'hoverable-row group grid items-center gap-2.5 px-3.5',
        canMove && 'select-none',
        canMove ? 'cursor-grab' : 'cursor-pointer',
        isDragging && 'opacity-40',
        entry.excluded && 'opacity-50',
        isDropTarget &&
          dropTarget!.position === 'inside' &&
          (dropRejected ? 'bg-danger-soft' : 'border border-dashed border-accent bg-accent-soft'),
        isDropTarget && dropTarget!.position === 'before' && (dropRejected ? 'bg-danger-soft' : 'border-t-2 border-accent'),
        isDropTarget && dropTarget!.position === 'after' && (dropRejected ? 'bg-danger-soft' : 'border-b-2 border-accent'),
      )}
      onClick={() => {
        if (justCompletedDragRef.current === entry.localId) {
          justCompletedDragRef.current = null;
          return;
        }
        onSelect(entry.localId);
        openDetails(entry.localId);
      }}
      data-excluded={entry.excluded ? 'true' : 'false'}
    >
      {/* Always rendered (even when canMove is false, where --grip-w
          collapses this track to 0px) -- omitting the element entirely
          would shift every column after it one grid track to the left,
          since CSS grid auto-places children in order into the tracks the
          template defines. */}
      <span
        className={cn(
          'flex items-center justify-center text-ink-3',
          canMove && 'cursor-grab opacity-0 transition-opacity duration-instant group-hover:opacity-100 group-focus-within:opacity-100',
        )}
        title={canMove ? 'Drag to move' : undefined}
      >
        {canMove && <GripVertical className="h-3.5 w-3.5" />}
      </span>
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
          {/* Pre-existing bug fixed here: typeCatalog is keyed by the
              project's REAL ADO type name (e.g. 'User Story'), but
              entry.type is always the internal category ('Requirement') --
              on any non-CMMI project this lookup missed silently and every
              badge fell back to hardcoded colors/icons. realTypeName()
              resolves the real name first. */}
          <WorkItemTypeBadge type={entry.type} catalogEntry={typeCatalog?.[realTypeName(entry.type)]} />
          <p className={cn('min-w-0 flex-1 truncate text-sm font-medium leading-snug', entry.excluded && 'line-through text-ink-3')}>
            {entry.title}
          </p>
          {/* DESIGN.md §11.5 -- "already in ADO" badge. Real gap this closes
              (found while investigating whether tree reorder could override
              a matched item's real ADO relationships): dragging this row
              persists a new parentLocalId with the same accepted-move
              feedback as any other row, but confirm()'s own toLink filter
              (jobs.service.ts) unconditionally excludes reuse/dedup_skip
              from linkParentChild -- the move is cosmetic for THIS row's
              own position. The reverse direction is real, though: a NEW
              item placed as this row's child DOES link to its real ADO id
              on confirm (see adoIdByLocalId's seeding for both actions) --
              both halves matter, so the tooltip states both. Neutral
              status, not a warning -- same bg-surface-alt/text-ink-3
              treatment ActionBadge's own non-link chip uses, since this is
              a fact about a read-only property, not a hazard. Icon-only
              (not a chip) because it applies to every matched row, common
              enough that spending truncatable title width on it (like
              same-tier's rarer chip does) isn't worth it. */}
          {entry.action !== 'create' && (
            <span
              className="flex flex-none items-center text-ink-3"
              title={
                (entry.action === 'reuse'
                  ? `Already exists in ADO${entry.existingAdoId != null ? ` as WI-${entry.existingAdoId}` : ''}`
                  : `Matched to a probable duplicate in ADO${entry.existingAdoId != null ? ` (WI-${entry.existingAdoId})` : ''}`) +
                ' and keeps its parent there. Moving it here only reorganizes this review tree -- Confirm never re-parents an existing item. New items you place under it will be linked to it in ADO.'
              }
            >
              <Lock className="h-3.5 w-3.5" />
            </span>
          )}
          {isSameTierParent && (
            <Chip
              bg="var(--color-danger-soft)"
              color="var(--color-danger-ink)"
              className="flex-none border border-danger-border"
              title={`Parent is also a ${realTypeName(entry.type)}. This writes fine to Azure DevOps, but its native Backlogs hub can't reorder same-category links and only shows the leaf item on sprint backlogs/taskboards.`}
            >
              same tier
            </Chip>
          )}
          {parentIsExcluded && !entry.excluded && (
            <span
              className="flex flex-none items-center gap-0.5 text-warning"
              title="An ancestor of this item is excluded -- this item's whole subtree will be dropped from Confirm along with it, unless you exclude something else instead."
            >
              <EyeOff className="h-3.5 w-3.5" />
            </span>
          )}
        </span>
      </div>

      {/* overflow-hidden -- this span IS the 108px grid track (the row is a
          CSS grid, not flex), so it already clips anything wider. Without
          it, a long reuse/dedup_skip label ("Near-duplicate of WI-12345")
          on Chip's own whitespace-nowrap (shared by every Chip usage in the
          app, so not changed here) painted past the column boundary into
          the Signals column next to it. */}
      <span className="flex-none overflow-hidden">
        <ActionBadge action={entry.action} existingAdoId={entry.existingAdoId} orgUrl={orgUrl} project={project} />
      </span>

      {/* Signals: compact count-only chips, not the full chip wrap this
          replaced -- something-needs-attention scanning without
          reintroducing wrapped rows. Full detail (which issues, which
          links) lives in the details dialog. */}
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
}
