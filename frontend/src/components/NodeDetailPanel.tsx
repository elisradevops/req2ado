import { useEffect, useRef, useState } from 'react';
import { Pencil, Link2, RefreshCw, Upload, Check, X } from 'lucide-react';
import { MoveToPicker, type MoveToPickerCandidate } from './MoveToPicker';
import { getServerMessage } from '../lib/errorDetails';
import { TagChips } from './TagChips';
import { resolveWinningTag } from '../utils/requirementClassification';
import { REQUIREMENT_TAG_LABELS } from '../utils/labels';
import { QualityGauge, type QualityCategoryScores } from './QualityGauge';
import { ScoreExplanationPanel } from './ScoreExplanationPanel';
import { explainScore } from '../api/jobs';
import { TraceLinkChips } from './TraceLinkChips';
import { SourceProvenance } from './SourceProvenance';
import type { KbCitation } from './KbCitationChips';
import { FigureImage } from './FigureImage';
import type { DryRunDiffEntry } from './DiffTree';
import { attachFigureIdsOf } from '../utils/figures';
import type { TraceLinkFailure } from '../store/jobsStore';
import { TextField, TextArea } from '../ui/TextField';
import { Button } from '../ui/Button';
import { ProposalCard } from './ProposalCard';
import { Chip } from '../ui/Chip';
import { IssuesList } from './IssuesList';
import { itemIssues } from '../utils/itemIssues';
import { missingValuesOf } from '../utils/proposal';
import { Tooltip } from '../ui/Tooltip';
import { DescriptionMarkdown, Markdown } from '../ui/Markdown';
import { cn } from '../lib/cn';
import { LABEL_MICRO } from '../utils/labelMicro';
import { isFlaggedDiffEntry } from '../utils/diffFlagging';
import { formatDateTime } from '../utils/formatDateTime';

// CR-7d rescore: the quality score/categoryScores from JUST BEFORE a
// successful rescore -- held briefly so QualityGauge can render a real
// before/after delta instead of only the new number with no context for
// what changed. Cleared after RESCORE_DELTA_VISIBLE_MS or when the
// selected node changes.
const RESCORE_DELTA_VISIBLE_MS = 8000;

// Item-details ONLY -- chat lives in NodeDetailDialog's own right pane
// (ChatPanel, composed as a sibling, not a child, of this component) since
// the dialog redesign put details and chat in separate panes side by side
// rather than one stacked column. `canEdit` (used by the caller to gate
// ChatPanel too) is exported so both panes derive it from the exact same
// rule instead of two copies drifting apart.
export type EntryEditability =
  | { editable: true }
  | { editable: false; reason: 'matched' | 'excluded' | 'job_locked' | 'written' };

// Discriminates WHY an entry isn't editable, not just whether it is --
// canEditEntry's boolean alone collapsed 4 distinct reasons (not a create,
// excluded, job past diff_ready) into one, so the Edit button's absence was
// indistinguishable from a broken UI to a reviewer looking at a
// reuse/dedup_skip entry. canEditEntry stays a thin wrapper (unchanged
// signature/behavior) so NodeDetailDialog's ChatPanel gating needs no change.
const WRITTEN_NOTE = 'Already written to Azure DevOps by an earlier attempt, so this can no longer change.';

// `written`: an earlier failed attempt already wrote this item to Azure DevOps, and the server refuses changes to it.
export function editabilityOf(entry: DryRunDiffEntry, jobStatus?: string | null, written?: boolean): EntryEditability {
  if (written) return { editable: false, reason: 'written' };
  if (jobStatus != null && jobStatus !== 'diff_ready') return { editable: false, reason: 'job_locked' };
  if (entry.excluded) return { editable: false, reason: 'excluded' };
  if (entry.action !== 'create') return { editable: false, reason: 'matched' };
  return { editable: true };
}

// What an Epic or Feature covers, as one plain line; a count of zero is left out.
function coverageLine(type: string, counts?: { epics: number; features: number; requirements: number }): string {
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
  const parts = [
    counts && counts.epics > 0 ? plural(counts.epics, 'epic') : null,
    counts && counts.features > 0 ? plural(counts.features, 'feature') : null,
    counts && counts.requirements > 0 ? plural(counts.requirements, 'requirement') : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `Covers ${parts.join(', ')}.` : `No child items under this ${type} yet.`;
}

export function canEditEntry(entry: DryRunDiffEntry, jobStatus?: string | null, written?: boolean): boolean {
  return editabilityOf(entry, jobStatus, written).editable;
}

// Every loader mints table ids as `t{0-based index}` (pdf_loader.py,
// docx_loader.py, pptx_loader.py, xlsx_loader.py all share this exact
// convention) -- a reviewer seeing the raw id ("Table t7") has no way to
// know that. Falls back to the raw id itself if the format is ever
// unrecognized (a network response, not a value this file controls), so
// this never renders something worse than what it replaces.
function tableChipLabel(tableId: string, caption: string | undefined): string {
  if (caption) return caption;
  const match = /^t(\d+)$/.exec(tableId);
  return match ? `Table ${Number(match[1]) + 1}` : `Table ${tableId}`;
}

const NO_DESCRIPTION_EXISTING_ITEM_HINT =
  'No description. Figures are not attached automatically to items that already exist. You can upload it to this item yourself.';
const NO_DESCRIPTION_TOOLTIP =
  'No description. It will be attached to this item when you write. If it belongs to another item, upload it there after writing.';

export function NodeDetailPanel({
  jobId,
  entry,
  jobMode,
  jobStatus,
  written,
  kbCitations,
  traceTargetTitles,
  traceLinkFailures,
  parentEntry,
  addChildSlot,
  hideSources,
  hideEditButton,
  onAskAssistant,
  onReviewSuggestion,
  onAddDiscussion,
  evidenceSlot,
  sourceSlot,
  moveSlot,
  parentSlot,
  duplicateSlot,
  captionByFigureId,
  nameByFigureId,
  captionByTableId,
  onSave,
  onRescore,
  onSetProposalAccepted,
  onRemoveDiscussion,
  onAttachFigure,
  onMoveFigure,
  figureMoveTargets,
  onRetryTraceLink,
  descendantCounts,
  requirementClassificationField,
  editRequest = 0,
  editSeed,
  reviewSlot,
}: {
  // Needed only by the Figures section below (FigureImage's fetch route is
  // job-scoped) -- optional so every existing caller/test that has no
  // reason to touch figures keeps working unchanged.
  jobId?: string;
  entry: DryRunDiffEntry | null;
  jobMode?: 'baseline' | 'survey' | null;
  jobStatus?: string | null;
  // Already written to Azure DevOps by an earlier attempt: locked like the other read-only reasons.
  written?: boolean;
  kbCitations?: KbCitation[];
  // localId -> title lookup across the WHOLE job's diff, not just this
  // entry -- lets TraceLinkChips resolve an intraJob link's target to a
  // real title instead of showing its raw internal id. See
  // TraceLinkChips.tsx's own doc comment.
  traceTargetTitles?: Record<string, string>;
  // Task 4: JobTraceLinkFailure rows for the WHOLE job (computed once by
  // the caller, JobDetail.tsx, same threading convention as kbCitations
  // above) -- filtered down to just THIS entry's own failures below
  // (matching on sourceLocalId === entry.localId, always true for a link
  // in entry.traceLinks -- see pipeline.worker.ts's traceLinksByLocalId)
  // before being passed to TraceLinkChips.
  traceLinkFailures?: TraceLinkFailure[];
  // This entry's own parent, looked up by the caller (JobDetail.tsx) from
  // the full diff array via entry.parentLocalId -- lets a 'create' entry
  // whose PARENT already resolved to 'reuse'/'dedup_skip' tell the
  // reviewer a similar parent item already exists in ADO. The backend
  // already re-parents this kind of child under the real existing ADO id
  // at confirm time (jobs.service.ts) -- this is purely making that
  // already-correct behavior visible, not new linking logic.
  parentEntry?: DryRunDiffEntry;
  // Rendered directly under the title, next to Edit -- owned/wired by the
  // caller (NodeDetailDialog builds the actual <AddChildCard>) since this
  // component doesn't know about onAddChild. Used to live at the very
  // bottom of the pane, after Sources -- disconnected from the title and
  // easy to miss below a long description/quality/trace-link stack.
  addChildSlot?: React.ReactNode;
  // The caller shows this entry's provenance itself (NodeDetailDialog's EvidenceStrip owns it there), so the Sources block is left out.
  // A caller that renders this panel without an EvidenceStrip must not set it.
  hideSources?: boolean;
  // The dialog shows Edit in its own header; the panel keeps its button when it is used on its own.
  hideEditButton?: boolean;
  // Opens the assistant from an issue's "Fix with assistant" button.
  onAskAssistant?: () => void;
  // Opens the comparison of a suggestion kept with the item.
  onReviewSuggestion?: () => void;
  // Parks a note for the item's Azure DevOps Discussion, posted when the item is created. Absent = notes can only be read (and removed).
  onAddDiscussion?: (localId: string, entry: { proposedTitle?: string; proposedDescription?: string }) => Promise<void> | void;
  // The dialog's evidence strip (file, location, "How this was scored"): drawn right after the item's text and any proposal or discussion, so
  // the source is next to what it supports and the long score panel comes after it.
  // A function receives the Quality panel's read-only body (gauge, score explanation, grounding line) so the strip can fold it into its
  // "How this was scored" disclosure; the Re-check / Score this item line then stays outside it, in view.
  evidenceSlot?: React.ReactNode | ((quality: React.ReactNode) => React.ReactNode);
  // The Source column, shown beside the proposed text in two columns when the pane is wide enough (container query), stacked under it otherwise.
  sourceSlot?: React.ReactNode;
  // DESIGN.md §11.5 -- the keyboard-accessible "Move to..." control, owned/
  // wired by the caller (NodeDetailDialog builds the actual
  // MoveEntryControl) for the same reason addChildSlot is: this component
  // doesn't know about onMove or the full diff array MoveToPicker's
  // candidate list needs. Rendered right under the title, before the
  // editability message -- visible without scrolling, the same reasoning
  // addChildSlot's own doc comment gives for not burying it at the bottom.
  moveSlot?: React.ReactNode;
  // An Epic's or Feature's own sections (its decision, what is under it), in place of the one-line coverage sentence.
  parentSlot?: React.ReactNode;
  // The "already exists" card for a skipped near-duplicate (or one created anyway), built by the caller for the same reason moveSlot is.
  duplicateSlot?: React.ReactNode;
  onSave?: (
    localId: string,
    patch: { title: string; description: string; customerId?: string | null; tags?: string[]; seCoverageRef?: string | null },
  ) => void;
  // The SAME field JobsService.confirm() will actually write a Requirement's
  // classification to -- undefined/null when there's no diff yet, no
  // credential, or resolution failed (JobsController.getById's own
  // best-effort enrichment). Used only to show which tag would land in ADO;
  // never gates whether the edit control itself is shown.
  requirementClassificationField?: { referenceName: string; allowedValues: string[] } | null;
  // CR-7d rescore: owned by the caller (JobDetail.tsx), which persists the
  // fresh score/issues/categoryScores and shows a toast, mirroring onSave's
  // own contract. Rejecting leaves the stored entry (and its qualityStale
  // flag) untouched -- this component never fabricates a fresh number on
  // failure, it just reflects whatever the server actually persisted.
  // P9d review gate: accepts or withdraws the generated acceptance-criteria proposal. Owned by the caller (JobDetail.tsx), which persists it.
  onSetProposalAccepted?: (localId: string, accepted: boolean) => Promise<void> | void;
  // Removes one "To be discussed" item; owned by the caller (JobDetail.tsx), which persists it. Absent = the list is read-only.
  onRemoveDiscussion?: (localId: string, entryId: string) => Promise<void> | void;
  onRescore?: (localId: string) => Promise<void>;
  // figureId -> vision-model caption, same figureId scheme entry.figureIds
  // references (computed by the caller, JobDetail.tsx, from the SAME
  // figureIndex-based array FigureDescriptions renders). Absent figures
  // (e.g. a caption event that never fired, or a job reopened whose live
  // narration history hasn't loaded yet) just render without caption text.
  captionByFigureId?: Record<string, string | null>;
  // Task 5: figureId -> the document's own figure name (same figureId
  // scheme as captionByFigureId, computed by the same caller from the
  // same figureDescriptions array). Used for FigureImage's alt text in
  // place of the generic "Figure referenced by ..." fallback when present.
  nameByFigureId?: Record<string, string | null>;
  // tableId -> Table.caption, same scheme entry.tableIds references
  // (computed by the caller, JobDetail.tsx, from Job.tableDescriptions).
  // A table with no real caption is absent here -- the Tables chip below
  // falls back to a friendlier ordinal derived from the id instead of the
  // raw internal id.
  captionByTableId?: Record<string, string>;
  // Manual "Upload to ADO" action for one of entry.figureIds -- see the
  // Figures section below and JobsService.attachFigureToAdo's own doc
  // comment for why this exists alongside confirm()'s automatic
  // attachment. Same re-throw-on-failure contract as onRescore.
  onAttachFigure?: (localId: string, figureId: string) => Promise<void>;
  // Moves one figure of this item to another item (before the write), or detaches it when targetLocalId is null.
  // Rejects on failure; the card shows the reason and keeps the figure where it is.
  onMoveFigure?: (figureId: string, targetLocalId: string | null) => Promise<void>;
  // Items a figure may be moved to (the current item is left out here). Only the picker needs them.
  figureMoveTargets?: MoveToPickerCandidate[];
  // Task 4: manual retry for a trace link (identified by its own
  // JobTraceLinkFailure row id) that failed to write to Azure DevOps during
  // confirm() -- see JobsService.retryTraceLinkWrite's own doc comment. Same
  // re-throw-on-failure contract as onAttachFigure/onRescore above.
  onRetryTraceLink?: (failureId: string) => Promise<void>;
  // DESIGN.md §11.4.1 -- an Epic/Feature has no quality rubric (it's judged
  // on scope coherence, a review note, not a number), so its Scope group
  // shows what it covers instead: how many Feature/Requirement descendants
  // sit under it in the diff tree. Computed by the caller (JobDetail.tsx)
  // over the WHOLE diff array, not here -- this component only ever sees
  // one entry at a time. Absent (not zeroed) for a Requirement, which
  // never renders this group at all.
  descendantCounts?: { epics: number; features: number; requirements: number };
  // Bumped by the parent (the dialog's E key) to ask for the edit form. A counter, not a
  // boolean: the form's state lives here, and every press has to count. Only a change
  // after mount is a request, and only an editable entry honors it.
  editRequest?: number;
  // "Edit first" on a suggestion: the edit form opens with these texts instead of the item's own. A new object each time it should apply.
  editSeed?: { title: string; description: string } | null;
  // The assistant's suggestion beside the original (review mode): it replaces the Proposed column's content while the reviewer decides.
  reviewSlot?: React.ReactNode;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [notePending, setNotePending] = useState(false);
  // The note box belongs to one item: stepping on clears it, and a save that finishes after the step must not clear the next item's draft.
  const noteEntryRef = useRef(entry?.localId);
  noteEntryRef.current = entry?.localId;
  useEffect(() => {
    setNoteDraft('');
    setNotePending(false);
  }, [entry?.localId]);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  // Requirement-only (see WorkItemNode.customer_id's own docstring, ingestion
  // side) -- a per-Requirement source reference derived from the document's
  // own numbering, editable here so a reviewer can correct it or fill it in
  // when it couldn't be auto-detected (see the missing_source_reference
  // warning this pairs with).
  const [draftCustomerId, setDraftCustomerId] = useState('');
  // Requirement-only, same reasoning as draftCustomerId above -- classification
  // is a per-Requirement attribute (see WorkItemNode.tags's own docstring).
  const [draftTags, setDraftTags] = useState<string[]>([]);
  // Requirement-only, same reasoning as draftCustomerId above. Unlike
  // Customer ID, never auto-populated from the document under any
  // circumstance -- a manually-entered forward reference to a Systems
  // Engineering requirements-layer artifact (see WorkItemNode.
  // se_coverage_ref's own docstring). No matching/linking behavior exists
  // for this field -- it is purely a hook to hold a future reference.
  const [draftSeCoverageRef, setDraftSeCoverageRef] = useState('');
  const [rescoring, setRescoring] = useState(false);
  const isRescoringRef = useRef(false);
  const [preRescoreSnapshot, setPreRescoreSnapshot] = useState<{
    score: number;
    categoryScores: QualityCategoryScores | null;
    issues: string[];
  } | null>(null);
  // Tracks whichever node is CURRENTLY selected, updated synchronously in
  // the same effect that resets the rest of this component's state below
  // -- lets handleRescoreClick's async continuation (after its own await)
  // tell whether the user switched to a different node while a rescore
  // request for the PREVIOUS node was still in flight, and skip applying
  // that now-stale response. A plain `entry` read inside the closure
  // wouldn't work here: the closure captures the entry reference from the
  // render that created it, not the entry the component displays by the
  // time the promise resolves.
  const selectedLocalIdRef = useRef(entry?.localId);
  // Per-figureId "Upload to ADO" status, keyed by figureId since an entry
  // can reference more than one figure and each has its own independent
  // in-flight/done state. attachingFigureIdsRef is the synchronous guard
  // (checked/set before the await, per this project's Async Mutation
  // Handler convention) -- figureAttachStatus alone can't serve that role
  // since its update is async and wouldn't be visible yet to a second
  // rapid click on the same button.
  const [figureAttachStatus, setFigureAttachStatus] = useState<Record<string, 'attaching' | 'done' | 'failed'>>({});
  const attachingFigureIdsRef = useRef<Set<string>>(new Set());
  // Task 4: per-failureId trace-link retry status, same in-flight/done
  // convention (and same synchronous-guard-ref reasoning) as
  // figureAttachStatus/attachingFigureIdsRef above.
  const [traceLinkRetryStatus, setTraceLinkRetryStatus] = useState<Record<string, 'retrying' | 'done'>>({});
  const retryingFailureIdsRef = useRef<Set<string>>(new Set());
  const figuresHeadingRef = useRef<HTMLSpanElement>(null);
  const panelRootRef = useRef<HTMLDivElement>(null);
  const refocusAfterFigureChangeRef = useRef(false);
  // Per-figureId move/detach state, same synchronous-guard-ref pattern as the upload status above.
  const [figureMoveStatus, setFigureMoveStatus] = useState<Record<string, { pending: boolean; error: string | null }>>({});
  const movingFigureIdsRef = useRef<Set<string>>(new Set());

  // Exit edit mode whenever the selected node changes so a stale draft from
  // the previously-edited node can never be saved onto a different node.
  // Depend on entry?.localId (not entry itself) — JobDetail.tsx passes a new
  // entry object reference on every parent re-render even for the same node.
  useEffect(() => {
    selectedLocalIdRef.current = entry?.localId;
    setEditing(false);
    setDraftTitle('');
    setDraftDescription('');
    setDraftCustomerId('');
    setDraftTags([]);
    setDraftSeCoverageRef('');
    setRescoring(false);
    isRescoringRef.current = false;
    setPreRescoreSnapshot(null);
    setFigureAttachStatus({});
    attachingFigureIdsRef.current = new Set();
    setTraceLinkRetryStatus({});
    retryingFailureIdsRef.current = new Set();
    setFigureMoveStatus({});
    movingFigureIdsRef.current = new Set();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.localId]);

  const handledEditRequestRef = useRef(editRequest);
  useEffect(() => {
    if (editRequest === handledEditRequestRef.current) return;
    handledEditRequestRef.current = editRequest;
    if (entry && canEditEntry(entry, jobStatus, written) && !editing) startEditing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest]);

  // "Edit first": the same form, opened with the suggestion's texts.
  const handledSeedRef = useRef(editSeed);
  useEffect(() => {
    if (!editSeed || editSeed === handledSeedRef.current) return;
    handledSeedRef.current = editSeed;
    if (entry && canEditEntry(entry, jobStatus, written)) {
      startEditing();
      setDraftTitle(editSeed.title);
      setDraftDescription(editSeed.description);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSeed]);

  // After a figure move the diff updates; if the Figures section is gone, keep focus inside the panel.
  useEffect(() => {
    if (!refocusAfterFigureChangeRef.current) return;
    refocusAfterFigureChangeRef.current = false;
    if (!figuresHeadingRef.current) panelRootRef.current?.focus();
  }, [entry]);

  if (!entry) {
    return (
      <div className="p-4">
        <p className="text-sm text-ink-3">Select a node to view details.</p>
      </div>
    );
  }

  // Edit calls a backend route (editDiffEntry) that 409s once the job
  // leaves diff_ready, same as chat's sendTurn -- both panes derive this
  // from the same shared rule (see canEditEntry's own doc comment).
  const editability = editabilityOf(entry, jobStatus, written);
  const canEdit = editability.editable;
  // Insignificant figures (vision model correctly judged decorative/
  // non-technical) are excluded from this per-item view entirely -- they
  // carry no content relevant to this item, so a chip here was pure noise
  // for a reviewer. They're still counted in the document-wide "N figures
  // excluded as decorative" summary (JobDetail.tsx), just not repeated on
  // every item that happened to be near one in the source document.
  // Figures attach automatically only to items this job creates or resumes.
  const noDescriptionHint =
    entry.action === 'reuse' || entry.action === 'dedup_skip' ? NO_DESCRIPTION_EXISTING_ITEM_HINT : NO_DESCRIPTION_TOOLTIP;
  const attachFigureIds = attachFigureIdsOf(entry);
  const detachedFigureIds = entry.detachedFigureIds ?? [];
  const visibleUncaptionedFigureIds = (entry.uncaptionedFigureIds ?? []).filter((figureId) =>
    entry.action === 'create'
      ? attachFigureIds.includes(figureId) || detachedFigureIds.includes(figureId)
      : !(entry.insignificantFigureIds ?? []).includes(figureId),
  );
  const undescribedFigureCount = visibleUncaptionedFigureIds.filter((figureId) => !detachedFigureIds.includes(figureId)).length;
  // The same rule as the tree's flag (utils/diffFlagging): only Requirements are checked against the source.
  const isLowGrounding = isFlaggedDiffEntry({ type: entry.type, groundingScore: entry.groundingScore, qualityScore: null });
  // The row's flag only carries this as a tooltip, so the same reason is written out here for keyboard and touch users.
  // An Epic or Feature is not scored (quality scoring judges how a requirement is worded), so its score, and the model's confidence in
  // that score, are never a reason to review it; loose wording against the source still is.
  const isParentEntry = entry.type === 'Epic' || entry.type === 'Feature';
  // The suggestion being reviewed right here is not "waiting" any more.
  const issues = itemIssues(entry).filter((issue) => !(issue.id === 'suggestion-waiting' && reviewSlot));
  // The values the source left open are marked in the text, so the "Missing value" issue points at words.
  const missingTokens = entry.proposal?.kind === 'needs-input' ? missingValuesOf(entry.proposal.html) : [];
  // A note can be parked for a new item that is still being reviewed (the server accepts discussion on creates only).
  const canDiscuss = canEdit && entry.action === 'create' && !!onAddDiscussion;
  // An Epic or Feature whose description only repeats its title says nothing the header does not.
  const echoesTitle = isParentEntry && entry.description.replace(/\W+/g, '').toLowerCase() === entry.title.replace(/\W+/g, '').toLowerCase();

  function startEditing(): void {
    setDraftTitle(entry!.title);
    setDraftDescription(entry!.description);
    setDraftCustomerId(entry!.customerId ?? '');
    setDraftTags(entry!.tags ?? []);
    setDraftSeCoverageRef(entry!.seCoverageRef ?? '');
    setEditing(true);
  }

  function save(): void {
    // Only ever sent for a Requirement -- omitted (undefined) for Epic/
    // Feature leaves their customerId/seCoverageRef untouched server-side
    // rather than attempting a write the backend would reject (see
    // JobsService.editDiffEntry's own type gate).
    const customerId = entry!.type === 'Requirement' ? draftCustomerId.trim() || null : undefined;
    const tags = entry!.type === 'Requirement' ? draftTags : undefined;
    const seCoverageRef = entry!.type === 'Requirement' ? draftSeCoverageRef.trim() || null : undefined;
    onSave?.(entry!.localId, { title: draftTitle, description: draftDescription, customerId, tags, seCoverageRef });
    setEditing(false);
  }

  function toggleDraftTag(tag: string): void {
    setDraftTags((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]));
  }

  async function handleRescoreClick(): Promise<void> {
    if (!entry || !onRescore || isRescoringRef.current) return;
    isRescoringRef.current = true;
    setRescoring(true);
    // No snapshot (no delta shown) for a first-ever score -- "was null"
    // has nothing meaningful to render a ▲/▼ delta against, unlike an
    // actual rescore of a previously-scored item.
    const snapshot =
      entry.qualityScore != null
        ? { score: entry.qualityScore, categoryScores: entry.qualityCategoryScores ?? null, issues: entry.qualityIssues ?? [] }
        : null;
    const localIdAtRequest = entry.localId;
    try {
      await onRescore(entry.localId);
      // The selected node may have changed while this request was in
      // flight -- applying a stale snapshot/confirmation now would show a
      // delta and a "Rescored." message built from a DIFFERENT node's
      // numbers under whichever node is displayed now.
      if (!snapshot || selectedLocalIdRef.current !== localIdAtRequest) return;
      setPreRescoreSnapshot(snapshot);
      window.setTimeout(() => {
        setPreRescoreSnapshot((current) => (current === snapshot ? null : current));
      }, RESCORE_DELTA_VISIBLE_MS);
    } catch {
      // onRescore's caller (JobDetail.tsx) owns surfacing the failure (a
      // toast) -- the stored entry (and its qualityStale flag) is
      // untouched on a rejected promise, so the gauge simply stays Stale,
      // never a fabricated fresh number.
    } finally {
      isRescoringRef.current = false;
      setRescoring(false);
    }
  }

  async function handleAttachFigureClick(figureId: string): Promise<void> {
    if (!entry || !onAttachFigure || attachingFigureIdsRef.current.has(figureId)) return;
    attachingFigureIdsRef.current.add(figureId);
    setFigureAttachStatus((prev) => ({ ...prev, [figureId]: 'attaching' }));
    try {
      await onAttachFigure(entry.localId, figureId);
      setFigureAttachStatus((prev) => ({ ...prev, [figureId]: 'done' }));
    } catch {
      // onAttachFigure's caller (JobDetail.tsx) owns surfacing the failure
      // (a toast) -- drop this figureId's status entirely so the button
      // reverts to its normal, clickable state for a retry rather than
      // getting stuck showing "Uploading...". 'failed' keeps the button
      // clickable and adds an inline line; a retry resets it to 'attaching'.
      setFigureAttachStatus((prev) => ({ ...prev, [figureId]: 'failed' }));
    } finally {
      attachingFigureIdsRef.current.delete(figureId);
    }
  }

  async function handleMoveFigureClick(figureId: string, targetLocalId: string | null): Promise<void> {
    if (!onMoveFigure || movingFigureIdsRef.current.has(figureId)) return;
    movingFigureIdsRef.current.add(figureId);
    setFigureMoveStatus((prev) => ({ ...prev, [figureId]: { pending: true, error: null } }));
    try {
      await onMoveFigure(figureId, targetLocalId);
      // Keep keyboard and screen reader users in the Figures section; the toast announces the result.
      // When the last figure leaves, the heading unmounts; the effect below then falls back to the panel root.
      (figuresHeadingRef.current ?? panelRootRef.current)?.focus();
      refocusAfterFigureChangeRef.current = true;
      // The diff update removes this card; nothing to keep.
      setFigureMoveStatus((prev) => {
        const next = { ...prev };
        delete next[figureId];
        return next;
      });
    } catch (err) {
      const reason = getServerMessage(err) ?? (err instanceof Error && err.message ? err.message : null);
      const isMove = targetLocalId != null && targetLocalId !== entry?.localId;
      const prefix = isMove ? 'Could not move the figure' : 'Could not change the figure';
      const message = reason ? `${prefix}: ${reason}` : `${prefix}. Please try again.`;
      setFigureMoveStatus((prev) => ({ ...prev, [figureId]: { pending: false, error: message } }));
    } finally {
      movingFigureIdsRef.current.delete(figureId);
    }
  }

  // One figure's image card, shared by the captioned list and the
  // uncaptioned list (same image, same Upload button logic). `uncaptioned`
  // only swaps the alt text and adds the amber "No description" label.
  // `entry` is a parameter so it stays narrowed to non-null here.
  function renderFigureCard(entry: DryRunDiffEntry, figureId: string, jobId: string, uncaptioned: boolean): React.ReactElement {
    const status = figureAttachStatus[figureId];
    // A 'create' entry's real ADO id does not exist until this
    // job's confirm() has run -- but once confirm() succeeds,
    // JobsService.confirm's post-confirm dryRunDiff refresh sets
    // existingAdoId on every resolved entry regardless of its
    // original action, so this button becomes available for a
    // 'create' entry too once the job is 'succeeded', not only
    // for reuse/dedup_skip.
    const canAttach = entry.existingAdoId != null;
    const captioned = entry.figureIds ?? [];
    const shown = [...captioned, ...visibleUncaptionedFigureIds];
    const position = shown.indexOf(figureId) + 1;
    const positionAlt = `Figure ${position} of ${shown.length} for this item`;
    // A figure can be re-homed before the write: on an editable item, and on a matched one (so it can go to an item that
    // will be created). Never once written, excluded or after the job leaves review.
    const canMoveFigure =
      !!onMoveFigure && (editability.editable || (!editability.editable && editability.reason === 'matched'));
    const detached = detachedFigureIds.includes(figureId);
    // Figures only attach automatically to items that are not already in Azure DevOps.
    const canDetach = entry.action !== 'reuse' && entry.action !== 'dedup_skip' && !detached;
    const positionLabel = `figure ${position} of ${shown.length}`;
    const moveStatus = figureMoveStatus[figureId];
    const movePending = !!moveStatus?.pending;
    return (
      <li
        key={figureId}
        className="flex flex-col gap-2 rounded-sm border border-hairline bg-surface-alt p-2.5 sm:flex-row sm:items-start"
      >
        <div className={detached ? 'opacity-50' : undefined}>
          <FigureImage
            jobId={jobId}
            figureId={figureId}
            active
            alt={uncaptioned ? positionAlt : nameByFigureId?.[figureId] || positionAlt}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {captionByFigureId?.[figureId] && (
            // Final whole-branch review finding: Markdown's own
            // `p` renderer sets its own `text-sm text-ink-1`
            // classes directly on the rendered <p> -- an
            // !important class on THIS wrapper <div> never wins
            // against that (CSS specificity/importance only
            // competes between declarations on the SAME element,
            // not ancestor vs. descendant). `[&_p]:` targets the
            // rendered <p> itself so the override actually lands.
            <div className="[&_p]:!text-xs [&_p]:!text-ink-2">
              <Markdown>{captionByFigureId[figureId]}</Markdown>
            </div>
          )}
          {detached && <Chip className="self-start">Not attached</Chip>}
          {uncaptioned && !detached && (
            <>
              <Tooltip content={noDescriptionHint}>
                {/* Same warning-band treatment as the chip fallback below. */}
                <Chip className="self-start border border-warning-border bg-warning-soft text-warning-ink">No description</Chip>
              </Tooltip>
              {undescribedFigureCount === 1 && <p className="text-xs text-ink-3">{noDescriptionHint}</p>}
            </>
          )}
          {detached ? (
            <p className="text-xs text-ink-3">
              This figure will not be written to Azure DevOps unless you attach it again or move it to another item.
            </p>
          ) : (
            onAttachFigure &&
            (canAttach ? (
              <Button
                variant="outline"
                size="sm"
                className="flex-none self-start"
                disabled={status === 'done'}
                loading={status === 'attaching'}
                onClick={() => handleAttachFigureClick(figureId)}
              >
                {status === 'done' ? <Check className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />}
                {status === 'done' ? 'Uploaded' : `Upload to Azure DevOps (WI-${entry.existingAdoId})`}
              </Button>
            ) : (
              <p className="text-xs text-ink-3">
                You can upload this figure after the item is written to Azure DevOps.
              </p>
            ))
          )}
          {status === 'failed' && (
            <p role="alert" className="text-xs text-danger-ink">
              Upload failed. Try again.
            </p>
          )}
          {canMoveFigure && (
            <div className="flex flex-wrap items-center gap-1.5">
              <MoveToPicker
                triggerLabel="Move to…"
                triggerAriaLabel={`Move to…, ${positionLabel}`}
                popoverLabel="Move this figure to…"
                candidates={(figureMoveTargets ?? []).filter((c) => c.localId !== entry.localId)}
                emptyText="No other item can take this figure."
                disabled={movePending}
                onSelect={(targetLocalId) => {
                  if (targetLocalId != null) void handleMoveFigureClick(figureId, targetLocalId);
                }}
              />
              {canDetach && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Don't attach, ${positionLabel}`}
                  loading={movePending}
                  onClick={() => void handleMoveFigureClick(figureId, null)}
                >
                  Don't attach
                </Button>
              )}
              {detached && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Attach again, ${positionLabel}`}
                  loading={movePending}
                  onClick={() => void handleMoveFigureClick(figureId, entry.localId)}
                >
                  Attach again
                </Button>
              )}
            </div>
          )}
          {moveStatus?.error && (
            <p role="alert" className="text-xs text-danger-ink">
              {moveStatus.error}
            </p>
          )}
        </div>
      </li>
    );
  }

  // Task 4: same shape as handleAttachFigureClick above -- synchronous ref
  // guard before the await, in-flight/done status keyed by the failure
  // row's own id, dropped (not left stuck) on a rejected retry.
  async function handleRetryTraceLinkClick(failureId: string): Promise<void> {
    if (!onRetryTraceLink || retryingFailureIdsRef.current.has(failureId)) return;
    retryingFailureIdsRef.current.add(failureId);
    setTraceLinkRetryStatus((prev) => ({ ...prev, [failureId]: 'retrying' }));
    try {
      await onRetryTraceLink(failureId);
      setTraceLinkRetryStatus((prev) => ({ ...prev, [failureId]: 'done' }));
    } catch {
      // onRetryTraceLink's caller (JobDetail.tsx) owns surfacing the failure
      // (a toast) -- drop this failureId's status entirely so the control
      // reverts to its normal, clickable state for a retry.
      setTraceLinkRetryStatus((prev) => {
        const next = { ...prev };
        delete next[failureId];
        return next;
      });
    } finally {
      retryingFailureIdsRef.current.delete(failureId);
    }
  }

  if (editing) {
    return (
      // min-h-full + flex-col + the footer's mt-auto: Save/Cancel pin to
      // the bottom of the pane once content is short, but scroll with the
      // rest of the pane once the description grows past it -- same
      // "sticky footer inside a scrolling region" pattern Dialog's own
      // footer chrome uses.
      <div className="flex min-h-full flex-col gap-5 p-5">
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL_MICRO}>{entry.type}</span>
          <span className="rounded-full bg-surface-alt px-2 py-0.5 text-micro font-semibold uppercase tracking-wide text-ink-2">
            Editing
          </span>
        </div>
        {/* Title gets more visual weight than Description here -- it's the
            short, high-consequence field a reviewer scans first. */}
        <TextField
          label="Title"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          className="text-base font-semibold"
          fullWidth
        />
        {/* The text a reviewer is correcting comes straight after its title; the reference fields and classification follow. */}
        <TextArea
          label="Description"
          helperText="Markdown supported — **bold**, *italic*, ~~strikethrough~~, and - / 1. lists."
          value={draftDescription}
          onChange={(e) => setDraftDescription(e.target.value)}
          className="min-h-[300px] leading-relaxed"
          fullWidth
        />
        {/* Requirement-only -- Epic/Feature never carry a Customer ID (see
            WorkItemNode.customer_id's own docstring, ingestion side). */}
        {entry.type === 'Requirement' && (
          <TextField
            label="Customer ID"
            helperText="This requirement's own source reference (e.g. a clause number like 1.1.2.2) — leave blank if the source document has none."
            value={draftCustomerId}
            onChange={(e) => setDraftCustomerId(e.target.value)}
            className="font-mono text-sm"
            fullWidth
          />
        )}
        {/* Requirement-only, same gate as Customer ID above. Never
            auto-populated -- see WorkItemNode.se_coverage_ref's own
            docstring (ingestion side): this is a manual-only hook with no
            matching/linking behavior, not a resolved relation. */}
        {entry.type === 'Requirement' && (
          <TextField
            label="SE Coverage Reference"
            helperText="A manual forward reference to a Systems Engineering requirements-layer artifact this requirement is a basis for coverage of — entered by hand, never auto-detected or linked. Leave blank if not applicable."
            value={draftSeCoverageRef}
            onChange={(e) => setDraftSeCoverageRef(e.target.value)}
            className="font-mono text-sm"
            fullWidth
          />
        )}
        {entry.type === 'Requirement' && (() => {
          const editWinningTag = resolveWinningTag(draftTags, requirementClassificationField?.allowedValues);
          return (
            <div className="flex flex-col gap-1.5">
              <span className={LABEL_MICRO}>Classification</span>
              <div className="flex flex-wrap gap-1.5">
                {Object.keys(REQUIREMENT_TAG_LABELS).map((tag) => {
                  const { label } = REQUIREMENT_TAG_LABELS[tag];
                  const selected = draftTags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleDraftTag(tag)}
                      aria-pressed={selected}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                        selected ? 'border-ink-1 bg-ink-1 text-canvas' : 'border-hairline text-ink-2 hover:border-ink-3',
                      )}
                    >
                      {label}
                      {tag === editWinningTag ? ' →' : ''}
                    </button>
                  );
                })}
              </div>
              {draftTags.length > 0 && (
                <span className="text-xs text-ink-3">
                  {editWinningTag
                    ? `"${REQUIREMENT_TAG_LABELS[editWinningTag].label}" (→) is what will be written to the Requirement Type field in Azure DevOps.`
                    : "None of the selected categories map to this project's Requirement Type field — it will be left at its default."}
                </span>
              )}
            </div>
          );
        })()}
        <div className="sticky bottom-0 -mx-5 mt-auto flex items-center gap-2.5 border-t border-hairline bg-canvas px-5 py-3">
          <Button onClick={save} disabled={!draftTitle.trim()}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }


  // The Quality panel in pieces, so the dialog can fold its read-only body into "How this was scored" (DESIGN.md §11.4) and keep the line that
  // changes state (stale notice + Re-check quality, Not scored yet + Score this item, Rescored.) outside it, in view and in tab order.
  // An item that maps to one that already exists is not created, so "Not scored yet" would invite a score for nothing.
  const foldQuality = typeof evidenceSlot === 'function';
  const showQualityPanel = entry.type === 'Requirement' && !(entry.qualityScore == null && (entry.action === 'reuse' || entry.action === 'dedup_skip'));
  // Stale (edited since last scored): dimmed, never zeroed -- the last-known numbers stay on screen, only their freshness is in question.
  // See DryRunDiffEntry.qualityStale's own doc comment. The key forces a remount on node switch: QualityGauge owns its own
  // expandedCategories state, which would otherwise bleed from entry A into entry B's identical-looking row.
  const qualityGauge =
    showQualityPanel && entry.qualityScore != null ? (
      <div className={cn(entry.qualityStale && 'opacity-50')}>
        <QualityGauge
          key={entry.localId}
          score={entry.qualityScore}
          categoryScores={entry.qualityCategoryScores}
          categoryChecklist={entry.qualityCategoryChecklist}
          qualityIssues={entry.qualityIssues}
          previousScore={preRescoreSnapshot?.score}
          previousCategoryScores={preRescoreSnapshot?.categoryScores}
          previousIssues={preRescoreSnapshot?.issues}
          flat={foldQuality}
        />
      </div>
    ) : null;
  // Why each low category got its score, on demand: only for a score that still describes the current text.
  const qualityExplanation =
    showQualityPanel && entry.qualityScore != null && jobId && !entry.qualityStale && entry.qualityCategoryScores && Object.keys(entry.qualityCategoryScores).length > 0 ? (
      <ScoreExplanationPanel
        load={() => explainScore(jobId, entry.localId)}
        resetKey={`${jobId}:${entry.localId}:${entry.qualityScore}:${JSON.stringify(entry.qualityCategoryScores)}`}
      />
    ) : null;
  const qualityActions = !showQualityPanel ? null : entry.qualityScore != null ? (
    entry.qualityStale ? (
      <div className="flex items-center justify-between gap-2">
        {/* In the dialog the issues list already says the score is out of date, so only the progress of a re-check is said here. */}
        {(rescoring || !foldQuality) && (
          <p className="text-xs text-ink-3">
            {rescoring
              ? 'Re-scoring against the current wording. This takes a few seconds.'
              : 'Edited since this was scored. The numbers above are from before your change.'}
          </p>
        )}
        {onRescore && (
          <Button variant="outline" size="sm" onClick={handleRescoreClick} loading={rescoring} className="ms-auto flex-none">
            {!rescoring && <RefreshCw className="h-3 w-3" />}
            {rescoring ? 'Re-checking…' : 'Re-check quality'}
          </Button>
        )}
      </div>
    ) : (
      preRescoreSnapshot && <p className="text-xs font-medium text-ok">Rescored.</p>
    )
  ) : (
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm text-ink-3">Not scored yet.</p>
      {/* Reuses the exact same rescore action/backend route as the Stale state -- addDiffEntry hardcodes qualityScore: null for a
          manually-added item (jobs.service.ts), and rescoreDiffEntry's own guards (diff_ready, action === 'create', type ===
          'Requirement') never required a PRIOR score to exist, so a first-time score is additive, not a new backend capability. */}
      {onRescore && canEdit && (
        <Button variant="outline" size="sm" onClick={handleRescoreClick} loading={rescoring} className="flex-none">
          {!rescoring && <RefreshCw className="h-3 w-3" />}
          {rescoring ? 'Scoring…' : 'Score this item'}
        </Button>
      )}
    </div>
  );
  const groundingLine =
    entry.groundingScore != null && !isParentEntry ? (
      <div className={cn('flex items-center gap-1.5 text-sm', !foldQuality && 'rounded-sm border border-hairline bg-surface-alt p-2.5')}>
        <Tooltip content="How closely this item's wording follows the original document text.">
          <span className="text-ink-3">Matches source wording:</span>
        </Tooltip>
        <span className={cn('font-semibold', isLowGrounding ? 'text-warning' : 'text-ink-1')}>
          {isLowGrounding ? 'Loosely' : entry.groundingScore >= 0.7 ? 'Closely' : 'Partly'}
        </span>
        {isLowGrounding && <span className="text-ink-3">— worth checking against the source</span>}
      </div>
    ) : null;
  const qualityBody =
    qualityGauge || qualityExplanation || groundingLine ? (
      <>
        {qualityGauge}
        {qualityExplanation}
        {groundingLine}
      </>
    ) : null;

  const proposedBody = (
    <>
      {/* An Epic or Feature takes the file's own text, else nothing (owner decision, 2026-11-25): say so rather than show a blank. */}
      {isParentEntry && !entry.description.trim() ? (
        <p className="text-sm text-ink-3" data-testid="empty-description">
          Empty. The file has no text of its own for this {entry.type}, so no description is written.
        </p>
      ) : (
        !echoesTitle && (
          <div className="w-full text-read text-ink-2 [&>*]:max-w-[68ch] [&>*:dir(rtl)]:me-auto">
            <DescriptionMarkdown markedTokens={missingTokens}>{entry.description}</DescriptionMarkdown>
          </div>
        )
      )}
        <ProposalCard
          key={entry.localId}
          entry={entry}
          canAccept={canEdit && !!onSetProposalAccepted}
          lockedNote={
            editability.editable
              ? undefined
              : editability.reason === 'written'
                ? WRITTEN_NOTE
                : editability.reason === 'matched'
                ? 'This item already exists in Azure DevOps, so its description is not written.'
                : editability.reason === 'excluded'
                  ? 'This item is excluded, so nothing is written for it.'
                  : 'This job is no longer in review, so the choice cannot be changed.'
          }
          onSetAccepted={onSetProposalAccepted}
        />
    </>
  );

  const figuresBlock = (
    <>
      {/* This entry's OWN referenced figure(s) -- distinct from the
            document-wide FigureDescriptions panel (JobDetail.tsx), which
            lists every figure in the source file regardless of which
            requirement(s) cited it. Gives the reviewer the actual image next
            to a description that only names it in text (e.g. "Figure: This
            diagram illustrates..."), plus a manual retry/backfill for ADO
            attachment -- confirm()'s own automatic attach only ever runs
            once, at confirm() time, so a 'reuse'/'dedup_skip' entry (which
            never goes through that create/writeback path) or a job already
            'succeeded' before this figure's attachment succeeded has no
            other way to get it attached. See JobsService.attachFigureToAdo's
            own doc comment. */}
        {((jobId && entry.figureIds && entry.figureIds.length > 0) || visibleUncaptionedFigureIds.length > 0) && (
          <div className="mt-1">
            <span ref={figuresHeadingRef} tabIndex={-1} className="text-xs font-semibold text-ink-2 outline-none">
              Figures
            </span>
            {jobId && entry.figureIds && entry.figureIds.length > 0 && (
              <ul className="mt-1 flex flex-col gap-2">
                {entry.figureIds.map((figureId) => renderFigureCard(entry, figureId, jobId, false))}
              </ul>
            )}
            {/* Uncaptioned figures -- disjoint from figureIds above (a figure
                id is in exactly one of the two lists). These sit immediately
                below the captioned figures' full image cards, not in a
                separate/collapsed section, because the whole point is making a
                silently-dropped figure visible to a reviewer without them
                needing to go looking for it. With a jobId each gets the same
                image card as above, since it is still attached to this item
                at write time and placement is positional; without one, only
                the chip is possible.
                insignificantFigureIds are filtered out of
                visibleUncaptionedFigureIds entirely -- those are the vision
                model CORRECTLY judging a figure decorative/non-technical, not
                a failure, so every id left here is a genuine vision_failed
                case (or, when the whole run had vision disabled, already
                explained once at the tree level by the
                vision_captioning_disabled warning -- see JobDetail's warnings
                panel). */}
            {visibleUncaptionedFigureIds.length > 0 &&
              (jobId ? (
                <>
                  {undescribedFigureCount > 1 && <p className="mt-2 text-xs text-ink-3">{noDescriptionHint}</p>}
                  <ul className="mt-2 flex flex-col gap-2">
                    {visibleUncaptionedFigureIds.map((figureId) => renderFigureCard(entry, figureId, jobId, true))}
                  </ul>
                </>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {visibleUncaptionedFigureIds.map((figureId) => (
                    <Tooltip key={figureId} content={noDescriptionHint}>
                      {/* Same warning-band treatment QualityGauge's "Needs
                          review" chip uses (bg-warning-soft + border-warning-
                          border + text-warning-ink) -- reused, not a new color,
                          so "amber" means the same thing everywhere in this
                          app. */}
                      <Chip className="border border-warning-border bg-warning-soft text-warning-ink">
                        Figure {figureId}: no description
                      </Chip>
                    </Tooltip>
                  ))}
                </div>
              ))}
          </div>
        )}
    </>
  );

  return (
    <div ref={panelRootRef} tabIndex={-1} data-node-detail-panel className="@container flex flex-col gap-3 px-5 pb-5 pt-1 outline-none">
      {/* Edit sits right next to the title it edits -- it used to be a lone
          button at the very bottom of the pane, past description/quality/
          trace-links/sources, disconnected from what it acts on. */}
      {canEdit && !hideEditButton && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={startEditing} className="flex-none">
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        </div>
      )}
      <IssuesList issues={issues} onAsk={onAskAssistant} onReview={onReviewSuggestion} showWhenClean={!isParentEntry && canEdit && entry.qualityScore != null} />
      {duplicateSlot}
      {/* 'excluded' has no message of its own here -- the dialog header
          already shows a dedicated "Excluded from this run" badge right
          next to the title (NodeDetailDialog.tsx), so a second copy in
          this pane would be pure duplication. 'matched'/'job_locked' have
          no such coverage anywhere else, so they get one here. */}
      {!editability.editable && editability.reason !== 'excluded' && (
        <p className="text-xs text-ink-3">
          {/* The duplicate card already says a near-duplicate exists (and links it), so it is not repeated here. */}
          {editability.reason === 'matched' &&
            !(duplicateSlot && entry.action === 'dedup_skip') &&
            (entry.existingAdoId != null
              ? <>Read-only: this maps to an item that already exists in Azure DevOps (<span className="font-mono">WI-{entry.existingAdoId}</span>). Edit it in Azure DevOps.</>
              : 'Read-only: this item maps to an existing Azure DevOps work item, not a new one.')}
          {/* Real gap this closes: fields being read-only says nothing about
              POSITION -- a reviewer dragging this row to a new parent in
              DiffTree.tsx (DESIGN.md §11.5) sees the move persist and
              survive reload, with nothing telling them it's cosmetic. See
              jobs.service.ts's confirm() toLink filter, which unconditionally
              excludes reuse/dedup_skip from linkParentChild -- ADO enforces
              at most one Parent relation per work item (confirmed live:
              re-adding one 400s with TF401349), so a matched item's real
              position is not this job's to re-assert. */}
          {editability.reason === 'matched' &&
            `${duplicateSlot && entry.action === 'dedup_skip' ? '' : ' '}Its position in this tree is also read-only in Azure DevOps — moving it here only reorganizes your review, it never re-parents the real item.`}
          {editability.reason === 'written' && !entry.proposal && WRITTEN_NOTE}
          {editability.reason === 'job_locked' && `This job is no longer editable${jobStatus ? ` (status: ${jobStatus})` : ''}.`}
        </p>
      )}
      {entry.action === 'create' &&
        parentEntry &&
        (parentEntry.action === 'reuse' || parentEntry.action === 'dedup_skip') &&
        parentEntry.existingAdoId != null && (
          // The backend already links a 'create' child under its parent's
          // REAL ado id at confirm time when the parent resolved to
          // reuse/dedup_skip (see jobs.service.ts's adoIdByLocalId, which is
          // populated from both actions) -- this only makes that
          // already-correct behavior visible to the reviewer, who'd
          // otherwise have no way to tell from this child's own row that
          // its parent isn't actually going to be created fresh.
          <div className="flex items-start gap-2 rounded-sm border border-hairline bg-surface-alt p-2.5 text-xs text-ink-2">
            <Link2 className="mt-0.5 h-3.5 w-3.5 flex-none text-ink-3" />
            <span>
              A similar parent item already exists in Azure DevOps as{' '}
              <span className="font-mono">WI-{parentEntry.existingAdoId}</span> ({parentEntry.action === 'reuse' ? 'exact match' : 'near-duplicate'}
              ) — this item will be linked under it automatically when you write.
            </span>
          </div>
        )}
      {/* Real markdown, not whitespace-pre-line plain text -- descriptions
          are now authored (via Edit/chat) as markdown (**bold**, lists,
          ~~strikethrough~~) and written to Azure DevOps as real HTML via the same
          conversion (see orchestrator's description-html.ts) -- this
          preview should show a reviewer the same structure that lands in
          ADO, not the raw ** and - characters. Max-width measure preserved
          for readability on a dense multi-sentence requirement. */}
      {/* The 68ch measure sits on each block, not the wrapper, so a right-to-left
          block (:dir(rtl), resolved from dir="auto") can anchor to the pane's
          right edge instead of the right edge of a 68ch box. */}
      {sourceSlot ? (
        <div className="grid min-w-0 gap-4 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @4xl:gap-6">
          <section aria-labelledby={reviewSlot ? undefined : `proposed-${entry.localId}`} className="flex min-w-0 flex-col gap-3">
            {reviewSlot ?? (
              <h3 id={`proposed-${entry.localId}`} className={cn(LABEL_MICRO, 'text-ink-2')}>
                Proposed
              </h3>
            )}
            {reviewSlot ? null : proposedBody}
            {figuresBlock}
          </section>
          {sourceSlot}
        </div>
      ) : (
        (reviewSlot ?? proposedBody)
      )}
      {(canDiscuss || (entry.discussion?.length ?? 0) > 0) && (
        <section aria-labelledby={`discussion-${entry.localId}`} className="flex flex-col gap-1.5 rounded-sm border border-hairline bg-surface-alt p-2.5">
          <h3 id={`discussion-${entry.localId}`} className={LABEL_MICRO}>
            To be discussed{(entry.discussion?.length ?? 0) > 0 ? ` (${entry.discussion!.length})` : ''}
          </h3>
          <p className="text-xs text-ink-3">Posted to this item's Discussion in Azure DevOps when it is created; the text above is unchanged.</p>
          {(entry.discussion ?? []).map((d) => (
            <div key={d.id} className="flex items-start gap-2 border-t border-hairline pt-1.5 text-sm text-ink-2">
              <div className="min-w-0 flex-1 wrap-anywhere">
                {d.proposedTitle && (
                  <p>
                    <strong>Title:</strong> {d.proposedTitle}
                  </p>
                )}
                {d.proposedDescription && <DescriptionMarkdown>{d.proposedDescription}</DescriptionMarkdown>}
                <p className="text-xs text-ink-3">{formatDateTime(d.createdAt)}</p>
              </div>
              {canEdit && onRemoveDiscussion && (
                <Button size="sm" variant="ghost" aria-label="Remove from discussion" onClick={() => void onRemoveDiscussion(entry.localId, d.id)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
          {(entry.discussion?.length ?? 0) === 0 && <p className="text-sm text-ink-2">Nothing parked for this item yet.</p>}
          {canDiscuss && (
            <form
              className="flex flex-col gap-1.5 border-t border-hairline pt-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                const text = noteDraft.trim();
                if (!text || notePending || !onAddDiscussion) return;
                setNotePending(true);
                const forEntry = entry.localId;
                void Promise.resolve(onAddDiscussion(forEntry, { proposedDescription: text }))
                  .then(() => {
                    if (noteEntryRef.current === forEntry) setNoteDraft('');
                  })
                  .catch(() => undefined) // the caller already shows the failure; the note stays in the box
                  .finally(() => setNotePending(false));
              }}
            >
              <TextArea
                label="Add a question or note for the author"
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                rows={2}
                fullWidth
              />
              <Button type="submit" size="sm" variant="outline" className="w-fit" aria-busy={notePending} aria-disabled={!noteDraft.trim() || notePending}>
                Add to discussion
              </Button>
            </form>
          )}
        </section>
      )}
      {foldQuality ? (
        <>
          {(evidenceSlot as (quality: React.ReactNode) => React.ReactNode)(qualityBody)}
          {qualityActions}
        </>
      ) : (
        evidenceSlot
      )}
      {/* Real bug fixed here (confirmed against the agreed mockup, which has
          no "Active Flags" block at all): this used to pair Classification
          with a second "Active Flags" chip cloud showing the SAME issue
          codes QualityGauge's own per-category rows (and its "Other flags"
          catch-all) already render below, in fuller form -- QualityGauge
          includes the fix-oriented remedy text, this chip cloud showed only
          the bare label. Every code shown here was already guaranteed to
          reappear there (QualityGauge partitions 100% of qualityIssues into
          either a mapped category or "Other flags", never dropping one), so
          this whole block was pure duplication, not a second, independent
          fact. Classification alone is real content the gauge doesn't
          cover, so it stays -- as its own full-width block now that it no
          longer needs to share a 2-column row with something else. */}
      {entry.tags && entry.tags.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={LABEL_MICRO}>Classification</span>
          <TagChips tags={entry.tags} winningTag={resolveWinningTag(entry.tags, requirementClassificationField?.allowedValues)} />
        </div>
      )}
      {/* What the file itself states (the approved mockup, 2026-11-25): a Requirement's type, the file's tags (both written), and the words
          found in the text (TBD, Should...), which are for filtering only and never written. */}
      {(entry.type === 'Requirement' || entry.fileTags?.length || entry.derivedMarks?.length) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm" data-testid="file-details">
          {entry.type === 'Requirement' && (
            <>
              <dt className="text-ink-3">Requirement type</dt>
              <dd className={entry.requirementType ? 'text-ink-1' : 'text-ink-3'}>{entry.requirementType || 'Not stated in the file'}</dd>
            </>
          )}
          {entry.fileTags && entry.fileTags.length > 0 && (
            <>
              <dt className="text-ink-3">Tags from the file</dt>
              <dd dir="auto" className="text-ink-1">
                {entry.fileTags.join(', ')}
              </dd>
            </>
          )}
          {entry.derivedMarks && entry.derivedMarks.length > 0 && (
            <>
              <dt className="text-ink-3">Marked in the text</dt>
              <dd className="text-ink-1">
                {entry.derivedMarks.join(' · ')} <span className="text-xs text-ink-3">(for filtering, not written)</span>
              </dd>
            </>
          )}
        </dl>
      )}
      {!foldQuality && showQualityPanel && (
        <div className="flex flex-col gap-1.5 rounded-sm border border-hairline bg-surface-alt p-2.5">
          {entry.qualityScore != null ? (
            <>
              {qualityGauge}
              {qualityExplanation}
            </>
          ) : null}
          {qualityActions}
        </div>
      )}
      {!foldQuality && groundingLine}
      {/* DESIGN.md §11.4.1 -- in place of the absent gauge, an Epic/Feature
          shows what it covers (real descendant counts from the diff tree,
          computed by the caller) and states plainly why there is no score,
          rather than leaving this slot silently empty. */}
      {isParentEntry && (parentSlot ?? <p className="text-sm text-ink-2">{coverageLine(entry.type, descendantCounts)}</p>)}
      {moveSlot}
      {entry.traceLinks && entry.traceLinks.length > 0 && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Trace links</span>
          <TraceLinkChips
            links={entry.traceLinks}
            titles={traceTargetTitles}
            failures={traceLinkFailures?.filter((f) => f.sourceLocalId === entry.localId)}
            retryStatus={traceLinkRetryStatus}
            onRetry={onRetryTraceLink ? handleRetryTraceLinkClick : undefined}
          />
        </div>
      )}
      {!hideSources &&
        (entry.sourceRef ||
        (jobMode === 'survey' && entry.action === 'create' && (entry.type === 'Requirement' || (kbCitations && kbCitations.length > 0)))) && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Sources</span>
          {/* DESIGN.md §11.4.3 -- gauge/section gating rationale is unchanged
              from before this component was extracted; see SourceProvenance
              for the row-by-row rendering rules (2026-08-12 redesign spec). */}
          <SourceProvenance sourceRef={entry.sourceRef} showScoringNote={entry.type === 'Requirement'} kbCitations={kbCitations} />
        </div>
      )}
      {!sourceSlot && figuresBlock}
      {/* Tables folded into this node -- sibling of Figures above, but with
          no image/upload treatment: a table's content already renders as a
          real HTML <table> via DescriptionMarkdown elsewhere in this same
          description, so this is purely "here's which table(s) fed this
          item", not a second table viewer. */}
      {entry.tableIds && entry.tableIds.length > 0 && !(sourceSlot && entry.tableIds.every((tableId) => !captionByTableId?.[tableId])) && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Tables</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {entry.tableIds.map((tableId) => (
              <Chip key={tableId} className="border border-hairline-strong bg-surface-alt text-ink-2">
                {tableChipLabel(tableId, captionByTableId?.[tableId])}
              </Chip>
            ))}
          </div>
        </div>
      )}
      {/* Add Child sits LAST, after everything the reviewer might read
          about this node -- it used to sit right below the title, ahead of
          the description/classification/quality/trace-link/sources stack
          it has nothing to do with. */}
      {addChildSlot}
    </div>
  );
}
