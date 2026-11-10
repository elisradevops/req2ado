import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useAnimate } from 'motion/react-mini';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Tabs } from '../ui/Tabs';
import { Button } from '../ui/Button';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { ActionBadge } from './ActionBadge';
import { NodeDetailPanel, canEditEntry } from './NodeDetailPanel';
import { EvidenceStrip } from './EvidenceStrip';
import { AddChildCard } from './AddChildCard';
import { ChatPanel } from './ChatPanel';
import { MoveToPicker, type MoveToPickerCandidate } from './MoveToPicker';
import { cn } from '../lib/cn';
import { canBeRoot } from '../lib/canNest';
import type { WarningGroup } from '../utils/warningKinds';
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
// J/K presses closer together than this are a held key or fast stepping: no settle effect between them.
const SETTLE_REPEAT_MS = 300;

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
const WIDGET_ROLE_SELECTOR =
  '[role=listbox],[role=option],[role=combobox],[role=menu],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]';

// 24px hit area (WCAG 2.5.8), a visible focus ring, and 16px icons.
const CHEVRON_BUTTON_CLASS =
  'inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm text-ink-3 hover:text-ink-1 disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

const BUSY_BUTTON_CLASS = 'cursor-not-allowed opacity-60';

// A shortcut letter matches the typed character, or -- on a layout whose character is not a Latin letter (Hebrew,
// Cyrillic) -- the physical key. A Latin character always wins, so AZERTY's A stays A.
function matchesShortcutLetter(event: KeyboardEvent, letter: string): boolean {
  const key = event.key.toLowerCase();
  if (key === letter) return true;
  const latin = /^[a-z]$/.test(key);
  // Only a real typed character may fall back to the physical key: 'Dead', 'Unidentified' and 'Process' (IME) are not letters.
  return !latin && event.key.length === 1 && event.code === `Key${letter.toUpperCase()}`;
}

function KeyHints({ hints }: { hints: Array<[string, string]> }): React.ReactElement {
  return (
    <span data-testid="key-hints" aria-hidden="true" className="ms-2 text-xs opacity-80">
      {hints.map(([key, label], index) => (
        <Fragment key={key}>
          {/* The break point is this space, outside the nowrap pair: the line breaks between hints, never inside one. */}
          {index > 0 && ' '}
          <span className="whitespace-nowrap">
            <kbd className="rounded-sm border border-current/30 px-1 font-mono text-micro">{key}</kbd> {label}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

export function NodeDetailDialog({
  open,
  onOpenChange,
  jobId,
  entry,
  jobMode,
  jobStatus,
  written,
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
  onSetProposalAccepted,
  onAddDiscussion,
  onRemoveDiscussion,
  onAttachFigure,
  onMoveFigure,
  figureMoveTargets,
  onRetryTraceLink,
  onAddChild,
  onMove,
  onNavigate,
  hasPrev,
  hasNext,
  reason,
  review,
  shortcutsEnabled = true,
  announcement = '',
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
  // Already written to Azure DevOps by an earlier attempt (locks editing like the other read-only reasons).
  written?: boolean;
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
  onSetProposalAccepted?: (localId: string, accepted: boolean) => Promise<void> | void;
  // "To be discussed": park a chat proposal in the item's ADO Discussion instead of applying it; remove one later from the item's list.
  onAddDiscussion?: (localId: string, entry: { proposedTitle?: string; proposedDescription?: string }) => Promise<void> | void;
  onRemoveDiscussion?: (localId: string, entryId: string) => Promise<void> | void;
  // Manual "Upload to ADO" action for one of this entry's figures -- see
  // NodeDetailPanel's Figures section and JobsService.attachFigureToAdo's
  // own doc comment for why this exists alongside confirm()'s automatic
  // attachment.
  onAttachFigure?: (localId: string, figureId: string) => Promise<void>;
  // Pass-through to NodeDetailPanel: move one of this entry's figures to another item, or detach it (null).
  onMoveFigure?: (figureId: string, targetLocalId: string | null) => Promise<void>;
  figureMoveTargets?: MoveToPickerCandidate[];
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
  // Why this item is being stepped through, when it was opened from a
  // focused integrity warning -- shown as a banner above the item so the
  // reviewer doesn't have to remember what they're checking for.
  reason?: { title: string; todo: string; group: WarningGroup } | null;
  // Marks this item as reviewed and steps on (A or R). Present only when the
  // item was opened from a fix/review warning, or from the risk-ordered
  // queue, on a job still awaiting review. `reviewed` swaps the primary
  // action for an undo. `onReject` (X) excludes the item and steps on; only
  // the queue offers it.
  review?: {
    reviewed: boolean;
    onMark: () => void;
    onUnmark: () => void;
    onReject?: () => void;
    onUndo?: () => void;
    // Wording for the mark when it is not "mark reviewed" (the spot-check's "Looks right and next").
    markLabel?: string;
    markHint?: string;
    // A review save is in flight: the mode buttons and keys do nothing (aria-disabled, never `disabled`, so focus stays put).
    busy?: boolean;
    // Called instead of the action when it is pressed while busy (the page says "Still saving").
    onBusyAttempt?: () => void;
  } | null;
  // The single-key shortcuts (J K R A X). Off turns every one of them off
  // (WCAG 2.1.4); the buttons keep working.
  shortcutsEnabled?: boolean;
  // What the review queue just did ("Marked reviewed. 2 left."). Spoken from inside the dialog:
  // the page behind a modal dialog is hidden from screen readers, so the page's own region is not.
  announcement?: string;
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

  // Brief settle-in when J/K/R moves to another item, so the reviewer sees
  // the content change under their hands. Not on first open (the dialog's
  // own entrance covers that) and skipped for reduced-motion users.
  const [detailsScope, animateDetails] = useAnimate<HTMLDivElement>();
  const previousLocalId = useRef<string | undefined>(undefined);
  const lastSettleAt = useRef(0);
  useEffect(() => {
    const localId = entry?.localId;
    const hadPrevious = previousLocalId.current !== undefined;
    previousLocalId.current = localId;
    if (!hadPrevious || localId === undefined || !detailsScope.current) return;
    // motion/mini drives the Web Animations API; an environment without it
    // (jsdom, very old browsers) just skips the effect.
    if (typeof detailsScope.current.animate !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A repeated action: opacity only, short, and skipped while the key is held or pressed again within 300ms
    // (DESIGN.md section 8.3), so stepping through a list never leaves the content shimmering.
    const now = performance.now();
    const repeated = now - lastSettleAt.current < SETTLE_REPEAT_MS;
    lastSettleAt.current = now;
    if (repeated) return;
    void animateDetails(detailsScope.current, { opacity: [0.7, 1] }, { duration: 0.11, ease: 'easeOut' });
  }, [entry?.localId, animateDetails, detailsScope]);

  // E asks the panel to open its edit form (the form's state lives there); a counter so every press counts.
  const [editRequest, setEditRequest] = useState(0);
  const entryEditable = !!entry && canEditEntry(entry, jobStatus, written);

  // J / K step to the next / previous item, same as the chevrons in the
  // title. Ignored while typing (edit fields, chat) and with any modifier
  // held, so it never swallows a real character or a browser shortcut.
  useEffect(() => {
    if (!open || !onNavigate || !shortcutsEnabled) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // composedPath()[0] is the real origin even inside a shadow root, where event.target is retargeted to the host.
      const target = (event.composedPath?.()[0] ?? event.target) as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      // A letter typed to pick an option or menu entry is not a review shortcut.
      if (target?.closest?.(WIDGET_ROLE_SELECTOR)) return;
      const is = (letter: string): boolean => matchesShortcutLetter(event, letter);
      // A held A, R or X must not mark or exclude the whole queue at key-repeat speed.
      if (event.repeat && (is('r') || is('a') || is('x') || is('u') || is('e'))) return;
      if (is('j') && hasNext) {
        event.preventDefault();
        onNavigate?.('next');
      } else if (is('k') && hasPrev) {
        event.preventDefault();
        onNavigate?.('prev');
      } else if ((is('r') || is('a')) && review && !review.reviewed) {
        event.preventDefault();
        if (review.busy) review.onBusyAttempt?.();
        else review.onMark();
      } else if (is('x') && review?.onReject && !review.reviewed) {
        event.preventDefault();
        if (review.busy) review.onBusyAttempt?.();
        else review.onReject();
      } else if (is('u') && review?.onUndo) {
        event.preventDefault();
        review.onUndo();
      } else if (is('e') && entryEditable) {
        event.preventDefault();
        setEditRequest((count) => count + 1);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onNavigate, hasNext, hasPrev, review, shortcutsEnabled, entryEditable]);

  if (!entry) return null;

  const canEdit = canEditEntry(entry, jobStatus, written);
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

  const evidenceStrip = <EvidenceStrip entry={entry} jobMode={jobMode} kbCitations={kbCitations} />;

  const keyHints: Array<[string, string]> = [
    ['J', 'next'],
    ['K', 'previous'],
    ...(review && !review.reviewed ? ([['A/R', review.markHint ?? 'mark reviewed']] as Array<[string, string]>) : []),
    ...(review && !review.reviewed && review.onReject ? ([['X', 'exclude']] as Array<[string, string]>) : []),
    ...(review?.onUndo ? ([['U', 'undo']] as Array<[string, string]>) : []),
    ...(entryEditable ? ([['E', 'edit']] as Array<[string, string]>) : []),
  ];

  const detailsContent = (
    <NodeDetailPanel
      jobId={jobId}
      entry={entry}
      jobMode={jobMode}
      jobStatus={jobStatus}
      written={written}
      editRequest={editRequest}
      kbCitations={kbCitations}
      traceTargetTitles={traceTargetTitles}
      traceLinkFailures={traceLinkFailures}
      parentEntry={entry.parentLocalId != null ? diffByLocalId?.[entry.parentLocalId] : undefined}
      addChildSlot={addChildSlot}
      hideSources
      moveSlot={moveSlot}
      captionByFigureId={captionByFigureId}
      nameByFigureId={nameByFigureId}
      captionByTableId={captionByTableId}
      onSave={onSave}
      onRescore={onRescore}
      onSetProposalAccepted={onSetProposalAccepted}
      onRemoveDiscussion={onRemoveDiscussion}
      onAttachFigure={onAttachFigure}
      onMoveFigure={onMoveFigure}
      figureMoveTargets={figureMoveTargets}
      onRetryTraceLink={onRetryTraceLink}
      descendantCounts={descendantCountsByLocalId?.[entry.localId]}
      requirementClassificationField={requirementClassificationField}
    />
  );

  const chatContent = (
    <ChatPanel
      jobId={jobId}
      localId={entry.localId}
      itemType={entry.type}
      disabled={!canEdit}
      disabledReason={chatDisabledReason}
      categoryScores={entry.qualityStale ? null : entry.qualityCategoryScores}
      isCompound={entry.type === 'Requirement' && !entry.qualityStale && (entry.qualityIssues ?? []).includes('compound')}
      onAcceptProposal={(patch) =>
        onSave?.(entry.localId, {
          title: patch.title ?? entry.title,
          description: patch.description ?? entry.description,
        })
      }
      onDiscuss={
        onAddDiscussion
          ? (patch) => onAddDiscussion(entry.localId, { proposedTitle: patch.title, proposedDescription: patch.description })
          : undefined
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
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {onNavigate && (
            <span className="flex flex-none flex-col">
              <button
                type="button"
                aria-label="Previous item"
                disabled={!hasPrev}
                onClick={() => onNavigate('prev')}
                aria-keyshortcuts={shortcutsEnabled ? 'K' : undefined}
                className={CHEVRON_BUTTON_CLASS}
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Next item"
                disabled={!hasNext}
                onClick={() => onNavigate('next')}
                aria-keyshortcuts={shortcutsEnabled ? 'J' : undefined}
                className={CHEVRON_BUTTON_CLASS}
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </span>
          )}
          <WorkItemTypeBadge type={entry.type} catalogEntry={typeCatalog?.[entry.type]} />
          <span dir="auto" className="min-w-[12rem] flex-1 break-words" title={entry.title}>{entry.title}</span>
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
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {reason && (
        <div
          role="note"
          className={cn(
            'flex-none border-b px-5 py-2 text-sm',
            reason.group === 'fix' && 'border-danger-border bg-danger-soft text-danger-ink',
            reason.group === 'review' && 'border-warning-border bg-warning-soft text-warning-ink',
            reason.group === 'info' && 'border-hairline bg-surface-sunken text-ink-2',
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            {/* basis-56: below that width the buttons wrap onto their own line instead of squeezing the text. */}
            <span className="min-w-0 flex-1 basis-56">
              <span className="font-semibold">{reason.title}.</span> {reason.todo}
              {onNavigate && shortcutsEnabled && <KeyHints hints={keyHints} />}
            </span>
            {review &&
              (review.reviewed ? (
                <Button
                  size="sm"
                  variant="outline"
                  className={cn('flex-none', review.busy && BUSY_BUTTON_CLASS)}
                  aria-busy={review.busy || undefined}
                  aria-disabled={review.busy || undefined}
                  onClick={() => {
                    if (review.busy) review.onBusyAttempt?.();
                    else review.onUnmark();
                  }}
                >
                  Mark not reviewed
                </Button>
              ) : (
                <div className="flex flex-none items-center gap-2">
                  {review.onReject && (
                    <Button
                      size="sm"
                      variant="outline"
                      className={cn(review.busy && BUSY_BUTTON_CLASS)}
                      aria-busy={review.busy || undefined}
                      aria-disabled={review.busy || undefined}
                      aria-keyshortcuts={onNavigate && shortcutsEnabled ? 'X' : undefined}
                      onClick={() => {
                        if (review.busy) review.onBusyAttempt?.();
                        else review.onReject?.();
                      }}
                    >
                      Exclude and next
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    className={cn(review.busy && BUSY_BUTTON_CLASS)}
                    aria-busy={review.busy || undefined}
                    aria-disabled={review.busy || undefined}
                    aria-keyshortcuts={onNavigate && shortcutsEnabled ? 'A R' : undefined}
                    onClick={() => {
                      if (review.busy) review.onBusyAttempt?.();
                      else review.onMark();
                    }}
                  >
                    {review.markLabel ?? 'Mark reviewed and next'}
                  </Button>
                </div>
              ))}
          </div>
        </div>
      )}
      {!reason && onNavigate && shortcutsEnabled && (
        <div className="flex-none border-b border-hairline bg-surface-sunken px-5 py-1 text-ink-2">
          <KeyHints hints={keyHints} />
        </div>
      )}
      {isDesktop ? (
        // `lg` and up: real two-pane layout, details left / chat right.
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div ref={detailsScope}>{evidenceStrip}{detailsContent}</div>
          </div>
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            {mobileTab === 'details' ? <div ref={detailsScope}>{evidenceStrip}{detailsContent}</div> : chatContent}
          </div>
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
