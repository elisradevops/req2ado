import { useEffect, useRef, useState } from 'react';
import { Pencil, Link2, RefreshCw, Upload, Check } from 'lucide-react';
import { TagChips } from './TagChips';
import { QualityGauge, type QualityCategoryScores } from './QualityGauge';
import { TraceLinkChips } from './TraceLinkChips';
import { KbCitationChips, type KbCitation } from './KbCitationChips';
import { FigureImage } from './FigureImage';
import type { DryRunDiffEntry } from './DiffTree';
import { TextField, TextArea } from '../ui/TextField';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';
import { DescriptionMarkdown } from '../ui/Markdown';
import { cn } from '../lib/cn';
import { formatSourceRef } from '../utils/sourceRef';

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
  | { editable: false; reason: 'matched' | 'excluded' | 'job_locked' };

// Discriminates WHY an entry isn't editable, not just whether it is --
// canEditEntry's boolean alone collapsed 4 distinct reasons (not a create,
// excluded, job past diff_ready) into one, so the Edit button's absence was
// indistinguishable from a broken UI to a reviewer looking at a
// reuse/dedup_skip entry. canEditEntry stays a thin wrapper (unchanged
// signature/behavior) so NodeDetailDialog's ChatPanel gating needs no change.
export function editabilityOf(entry: DryRunDiffEntry, jobStatus?: string | null): EntryEditability {
  if (jobStatus != null && jobStatus !== 'diff_ready') return { editable: false, reason: 'job_locked' };
  if (entry.excluded) return { editable: false, reason: 'excluded' };
  if (entry.action !== 'create') return { editable: false, reason: 'matched' };
  return { editable: true };
}

export function canEditEntry(entry: DryRunDiffEntry, jobStatus?: string | null): boolean {
  return editabilityOf(entry, jobStatus).editable;
}

export function NodeDetailPanel({
  jobId,
  entry,
  jobMode,
  jobStatus,
  kbCitations,
  traceTargetTitles,
  parentEntry,
  addChildSlot,
  captionByFigureId,
  onSave,
  onRescore,
  onAttachFigure,
  descendantCounts,
}: {
  // Needed only by the Figures section below (FigureImage's fetch route is
  // job-scoped) -- optional so every existing caller/test that has no
  // reason to touch figures keeps working unchanged.
  jobId?: string;
  entry: DryRunDiffEntry | null;
  jobMode?: 'baseline' | 'survey' | null;
  jobStatus?: string | null;
  kbCitations?: KbCitation[];
  // localId -> title lookup across the WHOLE job's diff, not just this
  // entry -- lets TraceLinkChips resolve an intraJob link's target to a
  // real title instead of showing its raw internal id. See
  // TraceLinkChips.tsx's own doc comment.
  traceTargetTitles?: Record<string, string>;
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
  onSave?: (localId: string, patch: { title: string; description: string }) => void;
  // CR-7d rescore: owned by the caller (JobDetail.tsx), which persists the
  // fresh score/issues/categoryScores and shows a toast, mirroring onSave's
  // own contract. Rejecting leaves the stored entry (and its qualityStale
  // flag) untouched -- this component never fabricates a fresh number on
  // failure, it just reflects whatever the server actually persisted.
  onRescore?: (localId: string) => Promise<void>;
  // figureId -> vision-model caption, same figureId scheme entry.figureIds
  // references (computed by the caller, JobDetail.tsx, from the SAME
  // figureIndex-based array FigureDescriptions renders). Absent figures
  // (e.g. a caption event that never fired, or a job reopened whose live
  // narration history hasn't loaded yet) just render without caption text.
  captionByFigureId?: Record<string, string>;
  // Manual "Upload to ADO" action for one of entry.figureIds -- see the
  // Figures section below and JobsService.attachFigureToAdo's own doc
  // comment for why this exists alongside confirm()'s automatic
  // attachment. Same re-throw-on-failure contract as onRescore.
  onAttachFigure?: (localId: string, figureId: string) => Promise<void>;
  // DESIGN.md §11.4.1 -- an Epic/Feature has no quality rubric (it's judged
  // on scope coherence, a review note, not a number), so its Scope group
  // shows what it covers instead: how many Feature/Requirement descendants
  // sit under it in the diff tree. Computed by the caller (JobDetail.tsx)
  // over the WHOLE diff array, not here -- this component only ever sees
  // one entry at a time. Absent (not zeroed) for a Requirement, which
  // never renders this group at all.
  descendantCounts?: { epics: number; features: number; requirements: number };
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
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
  const [figureAttachStatus, setFigureAttachStatus] = useState<Record<string, 'attaching' | 'done'>>({});
  const attachingFigureIdsRef = useRef<Set<string>>(new Set());

  // Exit edit mode whenever the selected node changes so a stale draft from
  // the previously-edited node can never be saved onto a different node.
  // Depend on entry?.localId (not entry itself) — JobDetail.tsx passes a new
  // entry object reference on every parent re-render even for the same node.
  useEffect(() => {
    selectedLocalIdRef.current = entry?.localId;
    setEditing(false);
    setDraftTitle('');
    setDraftDescription('');
    setRescoring(false);
    isRescoringRef.current = false;
    setPreRescoreSnapshot(null);
    setFigureAttachStatus({});
    attachingFigureIdsRef.current = new Set();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.localId]);

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
  const editability = editabilityOf(entry, jobStatus);
  const canEdit = editability.editable;

  function startEditing(): void {
    setDraftTitle(entry!.title);
    setDraftDescription(entry!.description);
    setEditing(true);
  }

  function save(): void {
    onSave?.(entry!.localId, { title: draftTitle, description: draftDescription });
    setEditing(false);
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
      // getting stuck showing "Uploading...".
      setFigureAttachStatus((prev) => {
        const next = { ...prev };
        delete next[figureId];
        return next;
      });
    } finally {
      attachingFigureIdsRef.current.delete(figureId);
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
          <span className="text-micro font-semibold uppercase tracking-wide text-ink-3">{entry.type}</span>
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
        <TextArea
          label="Description"
          helperText="Markdown supported -- **bold**, *italic*, ~~strikethrough~~, and - / 1. lists."
          value={draftDescription}
          onChange={(e) => setDraftDescription(e.target.value)}
          className="min-h-[300px] flex-1 leading-relaxed"
          fullWidth
        />
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

  return (
    <div className="flex flex-col gap-3 p-5">
      {/* Edit sits right next to the title it edits -- it used to be a lone
          button at the very bottom of the pane, past description/quality/
          trace-links/sources, disconnected from what it acts on. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-micro font-semibold uppercase tracking-wide text-ink-3">{entry.type}</span>
          <h3 className="text-title leading-snug">{entry.title}</h3>
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" onClick={startEditing} className="flex-none">
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      </div>
      {/* 'excluded' has no message of its own here -- the dialog header
          already shows a dedicated "Excluded from this run" badge right
          next to the title (NodeDetailDialog.tsx), so a second copy in
          this pane would be pure duplication. 'matched'/'job_locked' have
          no such coverage anywhere else, so they get one here. */}
      {!editability.editable && editability.reason !== 'excluded' && (
        <p className="text-xs text-ink-3">
          {editability.reason === 'matched' &&
            (entry.existingAdoId != null
              ? <>Read-only: this maps to an item that already exists in ADO (<span className="font-mono">WI-{entry.existingAdoId}</span>). Edit it in Azure DevOps.</>
              : 'Read-only: this item maps to an existing ADO work item, not a new one.')}
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
              A similar parent item already exists in ADO as{' '}
              <span className="font-mono">WI-{parentEntry.existingAdoId}</span> ({parentEntry.action === 'reuse' ? 'exact match' : 'near-duplicate'}
              ) -- this item will be linked under it automatically on Confirm.
            </span>
          </div>
        )}
      {/* Real markdown, not whitespace-pre-line plain text -- descriptions
          are now authored (via Edit/chat) as markdown (**bold**, lists,
          ~~strikethrough~~) and written to ADO as real HTML via the same
          conversion (see orchestrator's description-html.ts) -- this
          preview should show a reviewer the same structure that lands in
          ADO, not the raw ** and - characters. Max-width measure preserved
          for readability on a dense multi-sentence requirement. */}
      <div className="max-w-[68ch] text-sm leading-relaxed text-ink-2">
        <DescriptionMarkdown>{entry.description}</DescriptionMarkdown>
      </div>
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
          <span className="text-micro font-semibold uppercase tracking-wide text-ink-3">Classification</span>
          <TagChips tags={entry.tags} />
        </div>
      )}
      {/* DESIGN.md §11.4.1 -- gated on the item's real ADO work-item type,
          explicitly, not on qualityScore presence. The two are NOT the same
          check: scoring is server-side-scoped to Requirement nodes today
          (so they happen to agree), but qualityScore==null on a
          Requirement is a DIFFERENT case (a scoring pass that failed) from
          an Epic/Feature never having a rubric to begin with -- the former
          must show the gauge's own empty/failed state, not silently
          disappear like the latter. */}
      {entry.type === 'Requirement' && (
        <div className="flex flex-col gap-1.5 rounded-sm border border-hairline bg-surface-alt p-2.5">
          {entry.qualityScore != null ? (
            <>
              {/* Stale (edited since last scored): dimmed, never zeroed --
                  the last-known numbers stay on screen, only their
                  freshness is in question. See DryRunDiffEntry.qualityStale's
                  own doc comment. */}
              <div className={cn(entry.qualityStale && 'opacity-50')}>
                {/* key forces a remount on node switch -- QualityGauge owns
                    its own expandedCategories state internally (which
                    category disclosures are open); without a key, React
                    reuses the same instance across different selected
                    nodes and a category left expanded on entry A bleeds
                    into entry B's identical-looking row. */}
                <QualityGauge
                  key={entry.localId}
                  score={entry.qualityScore}
                  categoryScores={entry.qualityCategoryScores}
                  categoryChecklist={entry.qualityCategoryChecklist}
                  qualityIssues={entry.qualityIssues}
                  previousScore={preRescoreSnapshot?.score}
                  previousCategoryScores={preRescoreSnapshot?.categoryScores}
                  previousIssues={preRescoreSnapshot?.issues}
                />
              </div>
              {entry.qualityStale ? (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-ink-3">
                    {rescoring
                      ? 'Re-scoring against the current wording. This takes a few seconds.'
                      : 'Edited since this was scored. The numbers above are from before your change.'}
                  </p>
                  {onRescore && (
                    <Button variant="outline" size="sm" onClick={handleRescoreClick} loading={rescoring} className="flex-none">
                      {!rescoring && <RefreshCw className="h-3 w-3" />}
                      {rescoring ? 'Re-checking…' : 'Re-check quality'}
                    </Button>
                  )}
                </div>
              ) : (
                preRescoreSnapshot && <p className="text-xs font-medium text-ok">Rescored.</p>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-ink-3">Not scored yet.</p>
              {/* Reuses the exact same rescore action/backend route as the
                  Stale state -- addDiffEntry hardcodes qualityScore: null
                  for a manually-added item (jobs.service.ts), and
                  rescoreDiffEntry's own guards (diff_ready, action ===
                  'create', type === 'Requirement') never required a PRIOR
                  score to exist, so a first-time score is additive, not a
                  new backend capability. */}
              {onRescore && canEdit && (
                <Button variant="outline" size="sm" onClick={handleRescoreClick} loading={rescoring} className="flex-none">
                  {!rescoring && <RefreshCw className="h-3 w-3" />}
                  {rescoring ? 'Scoring…' : 'Score this item'}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {/* DESIGN.md §11.4.1 -- in place of the absent gauge, an Epic/Feature
          shows what it covers (real descendant counts from the diff tree,
          computed by the caller) and states plainly why there is no score,
          rather than leaving this slot silently empty. */}
      {(entry.type === 'Epic' || entry.type === 'Feature') && (
        <div className="flex flex-col gap-1.5 rounded-sm border border-hairline bg-surface-alt p-2.5">
          <span className="text-xs font-semibold text-ink-2">Scope</span>
          <p className="text-sm text-ink-2">
            {descendantCounts &&
            (descendantCounts.epics > 0 || descendantCounts.features > 0 || descendantCounts.requirements > 0) ? (
              <>
                Covers{' '}
                {descendantCounts.epics > 0 && (
                  <>
                    {descendantCounts.epics} epic{descendantCounts.epics === 1 ? '' : 's'},{' '}
                  </>
                )}
                {descendantCounts.features} feature{descendantCounts.features === 1 ? '' : 's'}, {descendantCounts.requirements}{' '}
                requirement{descendantCounts.requirements === 1 ? '' : 's'}.
              </>
            ) : (
              `No child items under this ${entry.type} yet.`
            )}
          </p>
          <p className="text-xs text-ink-3">
            {entry.type === 'Epic' ? 'Epics' : 'Features'} aren't scored — quality scoring judges how a requirement is worded, not what it covers.
          </p>
        </div>
      )}
      {entry.traceLinks && entry.traceLinks.length > 0 && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Trace links</span>
          <TraceLinkChips links={entry.traceLinks} titles={traceTargetTitles} />
        </div>
      )}
      {(entry.sourceRef ||
        (jobMode === 'survey' && entry.action === 'create' && (entry.type === 'Requirement' || (kbCitations && kbCitations.length > 0)))) && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Sources</span>
          {/* Document provenance -- computed server-side and shipped on
              every entry, previously never rendered anywhere. Available
              regardless of mode/action (unlike the judged-against lines
              below, which are SURVEY/create-scoped); null for manually-added
              entries, which have no source document position. */}
          {entry.sourceRef && (
            <p className="font-mono text-xs text-ink-3">{formatSourceRef(entry.sourceRef)}</p>
          )}
          {/* DESIGN.md §11.4.3 -- gated on the item's real ADO work-item
              type (matching the gauge above), not on qualityScore presence
              (see that block's own comment for why they're not the same
              check). Copy is a REVERSAL, not a tune-up: an earlier version
              of this line named EARS/INCOSE/ISO/IEC/IEEE 29148 with a
              glossed InfoTip explaining each acronym -- customer feedback
              was that the acronyms themselves, independent of whether they
              came with an explanation, were the problem. No standard's
              name appears anywhere below, glossed or not; do not
              reintroduce one. */}
          {entry.type === 'Requirement' && (
            <>
              <p className="text-sm text-ink-2">Scored on how the requirement is written — its wording, not its engineering content.</p>
              <p className="text-xs text-ink-3">
                The checklist follows established requirements-writing practice — the same checks a systems engineer would run by
                hand.
                {kbCitations && kbCitations.length > 0
                  ? ` Your knowledge base contributed ${kbCitations.length} document${kbCitations.length === 1 ? '' : 's'}.`
                  : ''}
              </p>
            </>
          )}
          {kbCitations && kbCitations.length > 0 && (
            <div className="mt-1">
              <p className="text-sm text-ink-2">KB references:</p>
              <KbCitationChips citations={kbCitations} />
            </div>
          )}
        </div>
      )}
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
      {((jobId && entry.figureIds && entry.figureIds.length > 0) ||
        (entry.uncaptionedFigureIds && entry.uncaptionedFigureIds.length > 0)) && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Figures</span>
          {jobId && entry.figureIds && entry.figureIds.length > 0 && (
            <ul className="mt-1 flex flex-col gap-2">
              {entry.figureIds.map((figureId) => {
                const status = figureAttachStatus[figureId];
                // Mirrors the backend's own resolution order (see
                // JobsService.attachFigureToAdo): existingAdoId is known
                // immediately for reuse/dedup_skip, while a 'create' entry's
                // real ADO id only exists AFTER this job's confirm() has run
                // and isn't exposed to the frontend today (CreatedItemMapping
                // is never returned on any job-read route) -- so this button
                // is only ever offered for the reuse/dedup_skip case, exactly
                // the case that never gets confirm()'s automatic attachment.
                const canAttach = entry.action !== 'create' && entry.existingAdoId != null;
                return (
                  <li
                    key={figureId}
                    className="flex flex-col gap-2 rounded-sm border border-hairline bg-surface-alt p-2.5 sm:flex-row sm:items-start"
                  >
                    <FigureImage jobId={jobId} figureId={figureId} active alt={`Figure referenced by ${entry.title}`} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      {captionByFigureId?.[figureId] && <p className="text-xs text-ink-2">{captionByFigureId[figureId]}</p>}
                      {onAttachFigure &&
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
                            {status === 'done' ? 'Uploaded' : `Upload to ADO (WI-${entry.existingAdoId})`}
                          </Button>
                        ) : (
                          <p className="text-xs text-ink-3">
                            {entry.action === 'create'
                              ? 'Uploading requires a resolved ADO work item id -- not available for a new item in this view.'
                              : 'No resolved ADO work item id yet.'}
                          </p>
                        ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {/* Uncaptioned figures -- disjoint from figureIds above (a figure
              id is in exactly one of the two lists). These sit immediately
              below the captioned figures' full image cards, not in a
              separate/collapsed section, because the whole point is making a
              silently-dropped figure visible to a reviewer without them
              needing to go looking for it. No image fetch here (unlike
              above) -- there is nothing about this figure in the pipeline's
              output worth rendering beyond "this exists and got nothing". */}
          {entry.uncaptionedFigureIds && entry.uncaptionedFigureIds.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.uncaptionedFigureIds.map((figureId) => (
                <Tooltip
                  key={figureId}
                  content="This figure's image was captured, but no description was produced (vision disabled, or the description call failed) -- nothing about this figure reached this item's description."
                >
                  {/* Same warning-band treatment QualityGauge's "Needs
                      review" chip uses (bg-warning-soft + border-warning-
                      border + text-warning-ink) -- reused, not a new color,
                      so "amber" means the same thing everywhere in this
                      app. */}
                  <Chip className="border border-warning-border bg-warning-soft text-warning-ink">
                    Figure {figureId} · no description
                  </Chip>
                </Tooltip>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Tables folded into this node -- sibling of Figures above, but with
          no image/upload treatment: a table's content already renders as a
          real HTML <table> via DescriptionMarkdown elsewhere in this same
          description, so this is purely "here's which table(s) fed this
          item", not a second table viewer. */}
      {entry.tableIds && entry.tableIds.length > 0 && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Tables</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {entry.tableIds.map((tableId) => (
              <Chip key={tableId} className="border border-hairline-strong bg-surface-alt text-ink-2">
                Table {tableId}
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
