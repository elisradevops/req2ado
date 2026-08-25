import { useEffect, useMemo, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Tabs } from '../ui/Tabs';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { ActionBadge } from './ActionBadge';
import { NodeDetailPanel, canEditEntry } from './NodeDetailPanel';
import { AddChildCard } from './AddChildCard';
import { ChatPanel } from './ChatPanel';
import { MoveToPicker } from './MoveToPicker';
import { canBeRoot } from '../lib/canNest';
import { validNewParentsFor } from '../lib/moveValidation';
import type { DryRunDiffEntry } from './DiffTree';
import type { DiffTreeMoveInput } from './DiffTree';
import type { KbCitation } from './KbCitationChips';
import type { TraceLinkFailure } from '../store/jobsStore';
import type { WorkItemTypeCatalogEntry } from '../api/ado';

// Matches the `lg` breakpoint the layout below switches on -- Tailwind's
// default `lg` is 1024px. Kept as a real matchMedia query (not CSS-only
// visibility) so only ONE of the two layout variants actually MOUNTS
// ChatPanel at a time -- see useIsAboveBreakpoint's own doc comment for why
// this matters.
const LG_BREAKPOINT_QUERY = '(min-width: 1024px)';

// Real conditional mounting, not just CSS display:none/block -- ChatPanel
// fetches history and opens a websocket connection unconditionally on
// mount (see ChatPanel.tsx's own useEffect/useChatSocket calls, keyed only
// on jobId/localId, not visibility). Rendering both the mobile-tabs layout
// and the desktop two-pane layout in the DOM simultaneously (gated only by
// `lg:hidden`/`hidden lg:flex` CSS classes, as an earlier version of this
// file did) mounted TWO separate ChatPanel instances for the same
// jobId+localId -- two history fetches, two open sockets, and two
// independently-diverging histories if the viewport crossed the lg
// breakpoint while the dialog was open. Returns null on the server/during
// the first client render (no window) so this never mismatches during
// hydration-less CSR; the effect below corrects it to the real value on
// mount.
function useIsAboveBreakpoint(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const listener = (event: MediaQueryListEvent): void => setMatches(event.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [query]);

  return matches;
}

// Dedicated takeover dialog (not a centered form-sized modal, see
// ui/Dialog.tsx's unpadded/maxHeightClassName escape hatch) replacing the
// old cramped single-column sidebar: item details on the left, chat on the
// right, a collapsed-by-default "Add child item" card at the bottom of the
// left pane. Below `lg`, the two-pane layout doesn't have room for chat --
// collapses to Details/Chat tabs instead of squeezing a chat pane into a
// too-narrow column. The dialog stays open and swaps its content when a
// different row is selected (driven by the caller re-passing a new `entry`
// with the same `open=true`) -- prev/next chevrons in the header step
// through the same filtered row list the caller's arrow-key navigation
// already uses.
export function NodeDetailDialog({
  open,
  onOpenChange,
  jobId,
  entry,
  jobMode,
  jobStatus,
  kbCitations,
  traceTargetTitles,
  traceLinkFailures,
  diffByLocalId,
  descendantCountsByLocalId,
  captionByFigureId,
  nameByFigureId,
  captionByTableId,
  onSave,
  onRescore,
  onAttachFigure,
  onRetryTraceLink,
  onAddChild,
  onMove,
  onNavigate,
  hasPrev,
  hasNext,
  typeCatalog,
  categoryLabels,
  requirementClassificationField,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  entry: DryRunDiffEntry | null;
  jobMode?: 'baseline' | 'survey' | null;
  jobStatus?: string | null;
  kbCitations?: KbCitation[];
  traceTargetTitles?: Record<string, string>;
  // Task 4: see NodeDetailPanel's own doc comment -- passed straight through
  // unfiltered, same threading convention as traceTargetTitles above.
  traceLinkFailures?: TraceLinkFailure[];
  diffByLocalId?: Record<string, DryRunDiffEntry>;
  // DESIGN.md §11.4.1 -- an Epic/Feature's Scope group needs real
  // descendant counts from the WHOLE diff tree; computed once by the
  // caller (JobDetail.tsx), resolved per-entry here same as diffByLocalId.
  descendantCountsByLocalId?: Record<string, { epics: number; features: number; requirements: number }>;
  // figureId -> vision-model caption, same figureId scheme entry.figureIds
  // references -- lets NodeDetailPanel's Figures section show each of THIS
  // entry's own referenced figures with its caption, without re-deriving
  // the figureIndex/figureId relationship itself.
  captionByFigureId?: Record<string, string | null>;
  // Task 5: figureId -> the document's own figure name, same figureId
  // scheme as captionByFigureId -- passed straight through to
  // NodeDetailPanel unchanged, same threading convention as
  // captionByFigureId above.
  nameByFigureId?: Record<string, string | null>;
  // tableId -> Table.caption, same scheme entry.tableIds references -- lets
  // NodeDetailPanel's Tables section show a readable title instead of a
  // raw internal id.
  captionByTableId?: Record<string, string>;
  onSave?: (
    localId: string,
    patch: { title: string; description: string; customerId?: string | null; tags?: string[]; seCoverageRef?: string | null },
  ) => void;
  // The SAME field JobsService.confirm() will actually write a Requirement's
  // classification to -- see NodeDetailPanel's own doc comment.
  requirementClassificationField?: { referenceName: string; allowedValues: string[] } | null;
  onRescore?: (localId: string) => Promise<void>;
  // Manual "Upload to ADO" action for one of this entry's figures -- see
  // NodeDetailPanel's Figures section and JobsService.attachFigureToAdo's
  // own doc comment for why this exists alongside confirm()'s automatic
  // attachment.
  onAttachFigure?: (localId: string, figureId: string) => Promise<void>;
  // Task 4: manual retry for a trace link that failed to write to Azure
  // DevOps -- see NodeDetailPanel's own doc comment.
  onRetryTraceLink?: (failureId: string) => Promise<void>;
  // CR: reparent -- parentLocalId is string|null now (root creation is
  // possible in SURVEY mode) and is no longer always entry.localId --
  // AddChildForm's own parent picker can point it somewhere else entirely.
  onAddChild: (parentLocalId: string | null, input: { type: string; title: string; description: string }) => void;
  // DESIGN.md §11.5 -- the keyboard-accessible reparent path DiffTree.tsx's
  // own drag-and-drop implementation always claimed existed but never
  // actually built (MoveToPicker was only ever wired into AddChildForm's
  // parent field for a NEW item, not this "move an existing item" control).
  // Same onMove contract DiffTree.tsx already calls -- JobDetail.tsx's
  // handleMoveEntry (optimistic apply, snapshot-and-revert on failure)
  // handles this identically regardless of which UI entry point called it.
  // Omitted (undefined) hides the control entirely, same convention as
  // onAddChild's own optional siblings above.
  onMove?: (localId: string, input: DiffTreeMoveInput) => void;
  onNavigate?: (direction: 'prev' | 'next') => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
  // Category -> this project's real ADO type name, for AddChildForm's type
  // Select LABELS only -- see AddChildForm.tsx's own doc comment.
  categoryLabels?: Record<'Epic' | 'Feature' | 'Requirement', string>;
}): React.ReactElement | null {
  const [mobileTab, setMobileTab] = useState<'details' | 'chat'>('details');
  const isDesktop = useIsAboveBreakpoint(LG_BREAKPOINT_QUERY);

  // Reset to the details tab whenever the selected node changes -- staying
  // on a previous node's chat tab while looking at a new node's details
  // (or vice versa) would be confusing.
  useEffect(() => {
    setMobileTab('details');
  }, [entry?.localId]);

  if (!entry) return null;

  const canEdit = canEditEntry(entry, jobStatus);
  const chatDisabledReason =
    jobStatus != null && jobStatus !== 'diff_ready'
      ? "This job's review is closed -- chat is only available while it's awaiting review."
      : undefined;

  const addChildSlot =
    jobMode && jobStatus === 'diff_ready' ? (
      <AddChildCard
        parentEntry={entry}
        jobMode={jobMode}
        allEntries={Object.values(diffByLocalId ?? {})}
        categoryLabels={categoryLabels}
        typeCatalog={typeCatalog}
        onAdd={(input) => onAddChild(input.parentLocalId, { type: input.type, title: input.title, description: input.description })}
      />
    ) : undefined;

  // DESIGN.md §11.5 -- the keyboard-accessible reparent path (see onMove's
  // own doc comment above for why this didn't already exist). Available
  // regardless of entry.action -- a reuse/dedup_skip entry's DISPLAY
  // position is legitimately movable (it just never reaches ADO on
  // confirm, see DiffTree.tsx's "already in ADO" badge on this same row),
  // matching drag-and-drop's own scope exactly rather than a narrower one.
  const moveSlot =
    onMove && jobStatus === 'diff_ready' ? (
      <MoveEntryControl entry={entry} allEntries={Object.values(diffByLocalId ?? {})} categoryLabels={categoryLabels} typeCatalog={typeCatalog} onMove={onMove} />
    ) : undefined;

  const detailsContent = (
    <NodeDetailPanel
      jobId={jobId}
      entry={entry}
      jobMode={jobMode}
      jobStatus={jobStatus}
      kbCitations={kbCitations}
      traceTargetTitles={traceTargetTitles}
      traceLinkFailures={traceLinkFailures}
      parentEntry={entry.parentLocalId != null ? diffByLocalId?.[entry.parentLocalId] : undefined}
      addChildSlot={addChildSlot}
      moveSlot={moveSlot}
      captionByFigureId={captionByFigureId}
      nameByFigureId={nameByFigureId}
      captionByTableId={captionByTableId}
      onSave={onSave}
      onRescore={onRescore}
      onAttachFigure={onAttachFigure}
      onRetryTraceLink={onRetryTraceLink}
      descendantCounts={descendantCountsByLocalId?.[entry.localId]}
      requirementClassificationField={requirementClassificationField}
    />
  );

  const chatContent = (
    <ChatPanel
      jobId={jobId}
      localId={entry.localId}
      disabled={!canEdit}
      disabledReason={chatDisabledReason}
      onAcceptProposal={(patch) =>
        onSave?.(entry.localId, {
          title: patch.title ?? entry.title,
          description: patch.description ?? entry.description,
        })
      }
    />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      unpadded
      maxWidthClassName="max-w-[1180px]"
      maxHeightClassName="h-[min(760px,calc(100vh-96px))]"
      title={
        <div className="flex min-w-0 items-center gap-2">
          {onNavigate && (
            <span className="flex flex-none flex-col">
              <button
                type="button"
                aria-label="Previous item"
                disabled={!hasPrev}
                onClick={() => onNavigate('prev')}
                className="text-ink-3 hover:text-ink-1 disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="Next item"
                disabled={!hasNext}
                onClick={() => onNavigate('next')}
                className="text-ink-3 hover:text-ink-1 disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
          <WorkItemTypeBadge type={entry.type} catalogEntry={typeCatalog?.[entry.type]} />
          <span className="truncate">{entry.title}</span>
          {entry.customerId && <span className="flex-none font-mono text-xs tracking-tight text-ink-3">{entry.customerId}</span>}
          <ActionBadge action={entry.action} existingAdoId={entry.existingAdoId} />
        </div>
      }
      /* Excluded is the only thing that still needs its own row -- everything
         else now sits inline next to the title (see `title` above), closing
         the wasted full-width row a lone "New" badge used to sit alone in. */
      description={
        entry.excluded ? <span className="text-xs text-ink-3">Excluded from this run</span> : undefined
      }
    >
      {isDesktop ? (
        // `lg` and up: real two-pane layout, details left / chat right.
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto">{detailsContent}</div>
          <div className="min-h-0 w-[400px] flex-none border-l border-hairline">{chatContent}</div>
        </div>
      ) : (
        // Below `lg`: Details/Chat tabs instead of a too-narrow chat pane.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-none px-5">
            <Tabs
              value={mobileTab}
              onValueChange={(v) => setMobileTab(v as 'details' | 'chat')}
              tabs={[
                { value: 'details', label: 'Details' },
                { value: 'chat', label: 'Chat' },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{mobileTab === 'details' ? detailsContent : chatContent}</div>
        </div>
      )}
    </Dialog>
  );
}

// DESIGN.md §11.5's keyboard-accessible reparent control -- same visual
// shape as AddChildForm's own "Parent [suggested]: … Change" row (current
// value on the left, MoveToPicker trigger on the right), reused rather than
// invented fresh, but for MOVING an existing entry rather than choosing one
// for a new entry. Not exported -- specific to this dialog, unlike
// AddChildCard/AddChildForm which the tree toolbar's own "+ New item" also
// mounts directly.
function MoveEntryControl({
  entry,
  allEntries,
  categoryLabels,
  typeCatalog,
  onMove,
}: {
  entry: DryRunDiffEntry;
  allEntries: DryRunDiffEntry[];
  categoryLabels?: Record<'Epic' | 'Feature' | 'Requirement', string>;
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
  onMove: (localId: string, input: DiffTreeMoveInput) => void;
}): React.ReactElement {
  const byLocalId = useMemo(() => new Map(allEntries.map((e) => [e.localId, e])), [allEntries]);
  const candidates = useMemo(() => validNewParentsFor(allEntries, byLocalId, entry.localId), [allEntries, byLocalId, entry.localId]);
  const anyEpicExists = allEntries.some((e) => e.type === 'Epic');
  const allowRoot = canBeRoot(entry.type, anyEpicExists);
  const currentParent = entry.parentLocalId != null ? byLocalId.get(entry.parentLocalId) : undefined;
  const realTypeName = categoryLabels?.[entry.type as 'Epic' | 'Feature' | 'Requirement'] ?? entry.type;

  return (
    <div className="flex items-center gap-2 rounded-sm border border-hairline bg-surface px-2.5 py-1.5 text-xs">
      <span className="flex-none text-ink-3">Parent</span>
      <span className="min-w-0 flex-1 truncate font-medium text-ink-1">
        {currentParent
          ? `${currentParent.customerId ? currentParent.customerId + ' ' : ''}${currentParent.title}`
          : 'Top level (no parent)'}
      </span>
      <MoveToPicker
        triggerLabel="Move to…"
        triggerAriaLabel={`Move this ${realTypeName} to a different parent`}
        popoverLabel={`Move this ${realTypeName} under…`}
        candidates={candidates.map((c) => ({ localId: c.localId, type: c.type, title: c.title, customerId: c.customerId }))}
        allowRoot={allowRoot}
        rootLabel="Top level (no parent)"
        categoryLabels={categoryLabels}
        typeCatalog={typeCatalog}
        disabled={candidates.length === 0 && !allowRoot}
        onSelect={(parentLocalId) => onMove(entry.localId, { parentLocalId })}
      />
    </div>
  );
}
