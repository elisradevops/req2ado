import { useEffect, useMemo, useRef, useState } from 'react';
import { useAnimate } from 'motion/react-mini';
import { ChevronUp, ChevronDown, Keyboard, MessageSquareText, Pencil } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { ActionBadge } from './ActionBadge';
import { NodeDetailPanel, canEditEntry } from './NodeDetailPanel';
import { EvidenceStrip } from './EvidenceStrip';
import { SourcePane } from './SourcePane';
import { isScoredType } from '../utils/diffFlagging';
import { AddChildCard } from './AddChildCard';
import { ChatPanel } from './ChatPanel';
import { ProposalReview } from './ProposalReview';
import { useProposalReview } from '../hooks/useProposalReview';
import { MoveToPicker, type MoveToPickerCandidate } from './MoveToPicker';
import { DuplicateMatchCard, type DuplicateOverrideOptions } from './DuplicateMatchCard';
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
  onSuggest,
  onDecideSuggestion,
  onApplySuggestion,
  onRevertSuggestion,
  onSetProposalAccepted,
  onOverrideDuplicate,
  onUndoDuplicateOverride,
  orgUrl,
  project,
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
  // The assistant's suggestion is kept with the item (so it survives closing the chat and stepping on), decided, applied with a snapshot and a
  // re-score, and undone (DESIGN.md §11.4.6). Absent: the suggestion lives only while this dialog does, and Accept saves through onSave as before.
  onSuggest?: (localId: string, proposal: { proposedTitle: string | null; proposedDescription: string | null }) => Promise<void> | void;
  onDecideSuggestion?: (localId: string, decision: 'rejected' | 'discussed', suggestionId?: string) => Promise<void> | void;
  onApplySuggestion?: (localId: string, patch: { title: string; description: string }, suggestionId?: string) => Promise<void>;
  onRevertSuggestion?: (localId: string) => Promise<void>;
  onSetProposalAccepted?: (localId: string, accepted: boolean) => Promise<void> | void;
  // "Create as new item" on a skipped near-duplicate, and its undo. Absent = the card only shows what the item matched.
  onOverrideDuplicate?: (localId: string, options: DuplicateOverrideOptions) => Promise<void>;
  onUndoDuplicateOverride?: (localId: string) => Promise<void>;
  // The org and the job's team project, for the link to the matched item.
  orgUrl?: string | null;
  project?: string | null;
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
    // The exclude button's wording; "Exclude and next" in a queue, plain "Exclude" when the item was opened from the tree.
    rejectLabel?: string;
    markHint?: string;
    // The open item is a "Fix before writing" item: keeping it as it is must be a deliberate click, so A and R do nothing (a held key could
    // clear every blocker in seconds) and `onKeyBlocked` says why.
    keepAsWritten?: boolean;
    onKeyBlocked?: () => void;
    // A review save is in flight: the mode buttons and keys do nothing (aria-disabled, never `disabled`, so focus stays put).
    busy?: boolean;
    // Called instead of the action when it is pressed while busy (the page says "Still saving").
    onBusyAttempt?: () => void;
    // Where the open item is in the list being worked through (the review queue): "3 of 17" in the note above the item.
    position?: { index: number; total: number };
  } | null;
  // The single-key shortcuts (J K A R X U E). Off turns every one of them off
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
  // The assistant is a drawer, closed to begin with. ChatPanel is mounted only while it is open, so stepping through items fetches no chat
  // history, and the one-mount rule of §11.4.0 holds. It stays open across J / K.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const askButtonRef = useRef<HTMLButtonElement>(null);
  // The assistant's suggestion and its check belong to this dialog, not to the chat panel: they outlive the drawer (DESIGN.md §11.4.6).
  const suggestion = useProposalReview(jobId, entry?.localId ?? '', !entry || entry.type === 'Requirement');
  // Review mode: the suggestion is shown beside the original, in place of the Proposed column.
  const [reviewMode, setReviewMode] = useState(false);
  const [editSeed, setEditSeed] = useState<{ title: string; description: string } | null>(null);
  const hasProposal = suggestion.proposal !== null;
  const storedSuggestion = entry?.suggestion ?? null;
  // The stored suggestion this one on screen is (same texts), when it has been kept.
  const suggestionId =
    storedSuggestion &&
    suggestion.proposal &&
    storedSuggestion.proposedTitle === suggestion.proposal.proposedTitle &&
    storedSuggestion.proposedDescription === suggestion.proposal.proposedDescription
      ? storedSuggestion.id
      : undefined;
  // Suggestions the reviewer has dealt with in this dialog: never restored from the item while their decision is still on its way to the server.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string[]>([]);
  const persistedProposal = useRef<unknown>(null);
  const restoredProposal = useRef<unknown>(null);
  const [rescoring, setRescoring] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [appliedPredicted, setAppliedPredicted] = useState<number | null>(null);
  // A new suggestion from the assistant is kept with the item (best effort); one restored from the item is already kept.
  useEffect(() => {
    const proposal = suggestion.proposal;
    if (!proposal || !entry || !onSuggest) return;
    if (persistedProposal.current === proposal) return;
    persistedProposal.current = proposal;
    if (restoredProposal.current === proposal) return;
    void onSuggest(entry.localId, proposal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion.proposal]);
  // Opening an item that still has a suggestion nobody decided on brings it back.
  const storedId = storedSuggestion?.id;
  const storedDecision = storedSuggestion?.decision;
  useEffect(() => {
    if (!storedSuggestion || storedSuggestion.decision !== 'pending' || suggestion.proposal) return;
    if (dismissedSuggestions.includes(storedSuggestion.id)) return;
    const restored = { proposedTitle: storedSuggestion.proposedTitle, proposedDescription: storedSuggestion.proposedDescription };
    restoredProposal.current = restored;
    suggestion.setProposal(restored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.localId, storedId, storedDecision, hasProposal, dismissedSuggestions]);
  useEffect(() => {
    if (!hasProposal) setReviewMode(false);
  }, [hasProposal]);
  // Leaving review mode returns focus to where the reviewer came from: the summary's button while the assistant is open, otherwise Ask.
  const wasReviewMode = useRef(false);
  useEffect(() => {
    if (wasReviewMode.current && !reviewMode && open && hasProposal) {
      (document.getElementById('review-change-button') ?? askButtonRef.current)?.focus();
    }
    wasReviewMode.current = reviewMode;
  }, [reviewMode, open, hasProposal]);
  const isDesktop = useIsAboveBreakpoint(LG_BREAKPOINT_QUERY);

  // Closing the dialog closes the assistant. Closing only the assistant returns focus to the Ask button, so a keyboard user is not dropped.
  const wasAssistantOpen = useRef(false);
  useEffect(() => {
    if (!open) setAssistantOpen(false);
  }, [open]);
  useEffect(() => {
    if (wasAssistantOpen.current && !assistantOpen && open) askButtonRef.current?.focus();
    wasAssistantOpen.current = assistantOpen;
  }, [assistantOpen, open]);

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
  // Always available: a closed review still opens the assistant, which says why it cannot change anything.
  const entryAskable = !!entry;

  // J / K step to the next / previous item, same as the chevrons in the
  // title. Ignored while typing (edit fields, chat) and with any modifier
  // held, so it never swallows a real character or a browser shortcut.
  useEffect(() => {
    if (!open || !shortcutsEnabled) return;
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
      if (event.repeat && (is('r') || is('a') || is('x') || is('u') || is('e') || is('c'))) return;
      if (is('c') && entryAskable) {
        event.preventDefault();
        setAssistantOpen((value) => !value);
      } else if (is('j') && hasNext && onNavigate) {
        event.preventDefault();
        onNavigate('next');
      } else if (is('k') && hasPrev && onNavigate) {
        event.preventDefault();
        onNavigate('prev');
      } else if ((is('r') || is('a')) && review && !review.reviewed) {
        event.preventDefault();
        if (review.keepAsWritten) review.onKeyBlocked?.();
        else if (review.busy) review.onBusyAttempt?.();
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
  }, [open, onNavigate, hasNext, hasPrev, review, shortcutsEnabled, entryEditable, entryAskable]);

  if (!entry) return null;

  const canEdit = canEditEntry(entry, jobStatus, written);
  const chatDisabledReason =
    jobStatus != null && jobStatus !== 'diff_ready'
      ? "This job's review is closed — chat is only available while it's awaiting review."
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

  const duplicateSlot =
    entry.action === 'dedup_skip' || entry.duplicateOf || (entry.action === 'reuse' && entry.changedSinceWritten) ? (
      <DuplicateMatchCard
        entry={{ ...entry, existingAdoId: entry.existingAdoId ?? null, similarity: entry.similarity ?? null }}
        orgUrl={orgUrl}
        project={project}
        canDecide={jobStatus === 'diff_ready' && !written && !!onOverrideDuplicate && !!onUndoDuplicateOverride}
        onOverride={(options) => onOverrideDuplicate?.(entry.localId, options) ?? Promise.resolve()}
        onUndo={() => onUndoDuplicateOverride?.(entry.localId) ?? Promise.resolve()}
      />
    ) : undefined;

  // The Quality panel's read-only body folds into the strip's one closed "How this was scored" disclosure (DESIGN.md §11.4), so the
  // dialog is short by default; NodeDetailPanel keeps Re-check quality / Score this item outside it.
  // A Requirement with a source location gets the Source column beside its text (decided from the location, known at once, not from the quote).
  const useSourcePane = isScoredType(entry.type) && !!entry.sourceRef;
  const counts = descendantCountsByLocalId?.[entry.localId];
  const hasChildren = !!counts && counts.epics + counts.features + counts.requirements > 0;
  const evidenceStrip = (quality: React.ReactNode) => (
    <EvidenceStrip entry={entry} jobId={jobId} jobMode={jobMode} kbCitations={kbCitations} collapsible quality={quality} sourceInPane={useSourcePane} />
  );

  const keyHints: Array<[string, string]> = [
    ['J', 'next'],
    ['K', 'previous'],
    ...(review && !review.reviewed && !review.keepAsWritten ? ([['A/R', review.markHint ?? 'mark reviewed']] as Array<[string, string]>) : []),
    ...(review && !review.reviewed && review.onReject ? ([['X', 'exclude']] as Array<[string, string]>) : []),
    ...(review?.onUndo ? ([['U', 'undo']] as Array<[string, string]>) : []),
    ...(entryEditable ? ([['E', 'edit']] as Array<[string, string]>) : []),
    ...(entryAskable ? ([['C', 'assistant']] as Array<[string, string]>) : []),
  ];

  const dismissSuggestion = (): void => {
    if (suggestionId) setDismissedSuggestions((ids) => [...ids, suggestionId]);
  };
  const reviewSlot =
    reviewMode && suggestion.proposal ? (
      <ProposalReview
        review={suggestion}
        item={{ type: entry.type, title: entry.title, description: entry.description, qualityScore: entry.qualityScore, qualityStale: entry.qualityStale }}
        onAccept={(patch) => {
          const next = { title: patch.title ?? entry.title, description: patch.description ?? entry.description };
          const applied = suggestion.proposal;
          dismissSuggestion();
          if (!onApplySuggestion) {
            onSave?.(entry.localId, next);
            return;
          }
          setAppliedPredicted(suggestion.comparison?.after.score ?? null);
          setRescoring(entry.type === 'Requirement' && entry.qualityScore != null && patch.description !== undefined);
          void onApplySuggestion(entry.localId, next, suggestionId)
            .catch(() => {
              // Not applied (the caller said why): the suggestion comes back so it can be tried again.
              if (suggestionId) setDismissedSuggestions((ids) => ids.filter((id) => id !== suggestionId));
              suggestion.setProposal(applied);
            })
            .finally(() => setRescoring(false));
        }}
        onEditFirst={(seed) => {
          // The suggestion became the starting point of a manual edit: it is no longer waiting for a decision.
          if (suggestionId) void onDecideSuggestion?.(entry.localId, 'rejected', suggestionId);
          dismissSuggestion();
          setEditSeed({ ...seed });
          suggestion.setProposal(null);
        }}
        onDiscuss={
          onAddDiscussion
            ? async (patch) => {
                await onAddDiscussion(entry.localId, { proposedTitle: patch.title, proposedDescription: patch.description });
                if (suggestionId) void onDecideSuggestion?.(entry.localId, 'discussed', suggestionId);
                dismissSuggestion();
              }
            : undefined
        }
        onReject={() => {
          if (suggestionId) void onDecideSuggestion?.(entry.localId, 'rejected', suggestionId);
          dismissSuggestion();
          suggestion.setProposal(null);
        }}
        onBack={
          isDesktop
            ? undefined
            : () => {
                setReviewMode(false);
                setAssistantOpen(true);
              }
        }
      />
    ) : undefined;

  // After a suggestion is applied: say so, say how the score settled, and offer Undo (which restores the text AND its scores from the saved revision).
  const appliedBar =
    entry.previousRevision && onRevertSuggestion ? (
      <div data-testid="applied-bar" role="status" className="mx-5 mt-1 flex flex-wrap items-center gap-2 rounded-sm border border-ok-border bg-ok-soft px-3 py-1.5 text-sm text-ok-ink">
        <span>
          {rescoring
            ? 'Applied. Re-checking the quality…'
            : entry.qualityStale || entry.qualityScore == null
              ? 'Applied.'
              : appliedPredicted != null
                ? `Applied. Predicted ${Math.round(appliedPredicted)} · Scored ${Math.round(entry.qualityScore)}`
                : `Applied. Scored ${Math.round(entry.qualityScore)}`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          disabled={reverting || rescoring}
          onClick={() => {
            setReverting(true);
            void onRevertSuggestion(entry.localId)
              .catch(() => undefined) // the caller already said why (for example, the item was edited since)
              .finally(() => setReverting(false));
          }}
        >
          Undo
        </Button>
      </div>
    ) : null;

  const detailsContent = (
    <>
      {appliedBar}
    <NodeDetailPanel
      jobId={jobId}
      entry={storedSuggestion && dismissedSuggestions.includes(storedSuggestion.id) ? { ...entry, suggestion: null } : entry}
      jobMode={jobMode}
      jobStatus={jobStatus}
      written={written}
      editRequest={editRequest}
      editSeed={editSeed}
      reviewSlot={reviewSlot}
      kbCitations={kbCitations}
      traceTargetTitles={traceTargetTitles}
      traceLinkFailures={traceLinkFailures}
      parentEntry={entry.parentLocalId != null ? diffByLocalId?.[entry.parentLocalId] : undefined}
      addChildSlot={addChildSlot}
      hideSources
      hideEditButton
      onAskAssistant={() => setAssistantOpen(true)}
      onReviewSuggestion={() => setReviewMode(true)}
      evidenceSlot={evidenceStrip}
      sourceSlot={useSourcePane ? <SourcePane entry={entry} jobId={jobId} /> : undefined}
      moveSlot={moveSlot}
      duplicateSlot={duplicateSlot}
      captionByFigureId={captionByFigureId}
      nameByFigureId={nameByFigureId}
      captionByTableId={captionByTableId}
      onSave={onSave}
      onRescore={onRescore}
      onSetProposalAccepted={onSetProposalAccepted}
      onRemoveDiscussion={onRemoveDiscussion}
      onAddDiscussion={onAddDiscussion}
      onAttachFigure={onAttachFigure}
      onMoveFigure={onMoveFigure}
      figureMoveTargets={figureMoveTargets}
      onRetryTraceLink={onRetryTraceLink}
      descendantCounts={descendantCountsByLocalId?.[entry.localId]}
      requirementClassificationField={requirementClassificationField}
    />
    </>
  );

  const chatContent = (
    <ChatPanel
      jobId={jobId}
      localId={entry.localId}
      itemType={entry.type}
      disabled={!canEdit}
      disabledReason={chatDisabledReason}
      categoryScores={entry.qualityStale ? null : entry.qualityCategoryScores}
      hasChildren={hasChildren}
      focusComposer
      isCompound={entry.type === 'Requirement' && !entry.qualityStale && (entry.qualityIssues ?? []).includes('compound')}
      review={suggestion}
      onOpenReview={() => {
        setReviewMode(true);
        if (!isDesktop) setAssistantOpen(false); // below lg the assistant replaces the item: review mode needs the item
      }}
    />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      unpadded
      // Escape closes the assistant first and the dialog only when it is already closed, so the reviewer keeps their place.
      onEscapeKeyDown={(event) => {
        if (reviewMode) {
          event.preventDefault();
          setReviewMode(false); // the suggestion stays pending
          return;
        }
        if (!assistantOpen) return;
        event.preventDefault();
        setAssistantOpen(false);
      }}
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
          <span className="ms-auto flex flex-none items-center gap-1.5">
            {entryEditable && (
              <Button size="sm" variant="outline" aria-keyshortcuts={shortcutsEnabled ? 'E' : undefined} onClick={() => setEditRequest((count) => count + 1)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit
                {shortcutsEnabled && <kbd aria-hidden="true" className="rounded-sm border border-current/30 px-1 font-mono text-micro">E</kbd>}
              </Button>
            )}
            {entryAskable && (
              <Button
                ref={askButtonRef}
                size="sm"
                variant="outline"
                aria-pressed={assistantOpen}
                aria-keyshortcuts={shortcutsEnabled ? 'C' : undefined}
                onClick={() => setAssistantOpen((value) => !value)}
              >
                <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
                Ask
                {shortcutsEnabled && <kbd aria-hidden="true" className="rounded-sm border border-current/30 px-1 font-mono text-micro">C</kbd>}
              </Button>
            )}
            {shortcutsEnabled && keyHints.length > 0 && (
              <Popover.Root>
                <Popover.Trigger asChild>
                  <Button size="sm" variant="ghost" aria-label="Keyboard shortcuts" className="max-md:hidden">
                    <Keyboard className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content align="end" sideOffset={6} className="z-50 rounded-md border border-hairline-strong bg-surface p-3 text-sm shadow-dock">
                    <p className="mb-1.5 text-xs font-semibold text-ink-2">Keyboard shortcuts</p>
                    <ul className="flex flex-col gap-1">
                      {keyHints.map(([key, label]) => (
                        <li key={key} className="flex items-center gap-2">
                          <kbd className="w-9 rounded-sm border border-hairline-strong px-1 text-center font-mono text-micro">{key}</kbd>
                          <span>{label}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 border-t border-hairline pt-2 text-xs text-ink-3">
                      Turn these off in{' '}
                      <a href="/settings" target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                        Settings
                      </a>
                      .
                    </p>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            )}
          </span>
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
              {review?.position && (
                <span className="me-2 font-semibold tabular-nums">
                  {review.position.index.toLocaleString()} of {review.position.total.toLocaleString()}
                </span>
              )}
              <span className="font-semibold">{reason.title}.</span> {reason.todo}
            </span>
          </div>
        </div>
      )}
      {isDesktop ? (
        // `lg` and up: the details, and the assistant as a right-hand drawer while it is open.
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div ref={detailsScope}>{detailsContent}</div>
          </div>
          {assistantOpen && <div className="min-h-0 w-[380px] flex-none border-l border-hairline">{chatContent}</div>}
        </div>
      ) : (
        // Below `lg`: one column. Ask swaps the body for the assistant, with a way back.
        <div className="flex min-h-0 flex-1 flex-col">
          {assistantOpen && (
            <div className="flex-none px-5 pt-2">
              <Button size="sm" variant="ghost" onClick={() => setAssistantOpen(false)}>
                <ChevronUp className="h-3.5 w-3.5 -rotate-90" aria-hidden="true" />
                Back to item
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {assistantOpen ? chatContent : <div ref={detailsScope}>{detailsContent}</div>}
          </div>
        </div>
      )}
      {review && (
        // The decision is always in the same place, whether the dialog was opened from the queue or from the tree (DESIGN.md §11.4.5).
        <div
          role="group"
          aria-label="Review decision"
          className="flex flex-none flex-wrap items-center justify-end gap-2 border-t border-hairline bg-surface px-5 py-2.5 max-md:pb-[max(0.625rem,env(safe-area-inset-bottom))]"
        >
            {(review.reviewed ? (
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
                      {review.rejectLabel ?? 'Exclude and next'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    className={cn(review.busy && BUSY_BUTTON_CLASS)}
                    aria-busy={review.busy || undefined}
                    aria-disabled={review.busy || undefined}
                    aria-keyshortcuts={onNavigate && shortcutsEnabled && !review.keepAsWritten ? 'A R' : undefined}
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
