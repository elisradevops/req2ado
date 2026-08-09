import { useEffect, useState } from 'react';
import { Pencil, Link2 } from 'lucide-react';
import { TagChips } from './TagChips';
import { IssueChips } from './IssueChips';
import { QualityGauge } from './QualityGauge';
import { TraceLinkChips } from './TraceLinkChips';
import { KbCitationChips, type KbCitation } from './KbCitationChips';
import type { DryRunDiffEntry } from './DiffTree';
import { TextField, TextArea } from '../ui/TextField';
import { Button } from '../ui/Button';
import { DescriptionMarkdown } from '../ui/Markdown';
import { InfoTip } from '../ui/Tooltip';
import { formatSourceRef } from '../utils/sourceRef';

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
  entry,
  jobMode,
  jobStatus,
  kbCitations,
  traceTargetTitles,
  parentEntry,
  addChildSlot,
  onSave,
}: {
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
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');

  // Exit edit mode whenever the selected node changes so a stale draft from
  // the previously-edited node can never be saved onto a different node.
  // Depend on entry?.localId (not entry itself) — JobDetail.tsx passes a new
  // entry object reference on every parent re-render even for the same node.
  useEffect(() => {
    setEditing(false);
    setDraftTitle('');
    setDraftDescription('');
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
      {/* Classification (tags) and active flags (quality issues) side by
          side -- both are short chip lists, matching the reference detail
          layout's two-column summary row, rather than each stacked as its
          own full-width block with no label of its own. */}
      {(entry.tags && entry.tags.length > 0) || (entry.qualityIssues && entry.qualityIssues.length > 0) ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-micro font-semibold uppercase tracking-wide text-ink-3">Classification</span>
            <TagChips tags={entry.tags} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-micro font-semibold uppercase tracking-wide text-ink-3">Active Flags</span>
            <IssueChips issues={entry.qualityIssues} />
          </div>
        </div>
      ) : null}
      {entry.qualityScore != null && (
        <div className="flex flex-col gap-1.5 rounded-sm border border-hairline bg-surface-alt p-2.5">
          <QualityGauge score={entry.qualityScore} categoryScores={entry.qualityCategoryScores} />
        </div>
      )}
      {entry.traceLinks && entry.traceLinks.length > 0 && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Trace links</span>
          <TraceLinkChips links={entry.traceLinks} titles={traceTargetTitles} />
        </div>
      )}
      {(entry.sourceRef ||
        (jobMode === 'survey' && entry.action === 'create' && (entry.qualityScore != null || (kbCitations && kbCitations.length > 0)))) && (
        <div className="mt-1">
          <span className="text-xs font-semibold text-ink-2">Sources</span>
          {/* Document provenance -- computed server-side and shipped on
              every entry, previously never rendered anywhere. Available
              regardless of mode/action (unlike the judged-against line
              below, which is SURVEY/create-scoped); null for manually-added
              entries, which have no source document position. */}
          {entry.sourceRef && (
            <p className="font-mono text-xs text-ink-3">{formatSourceRef(entry.sourceRef)}</p>
          )}
          {/* Only claims a judgment actually happened for THIS node --
              quality scoring is scoped to Requirement-type nodes (see
              llm_leveling.py's own comment on this), so an Epic/Feature
              node has qualityScore == null and gets no gauge above; this
              line used to render unconditionally and claimed a rubric was
              applied even when it wasn't. Also names the knowledge base
              when it actually contributed, instead of always citing only
              the three fixed public standards regardless of whether KB
              grounding was used. */}
          {entry.qualityScore != null && (
            <p className="flex items-center gap-1 text-sm text-ink-2">
              <span>
                Judged against EARS, INCOSE, ISO/IEC/IEEE 29148
                {kbCitations && kbCitations.length > 0 ? ', and your knowledge base' : ''}
              </span>
              {/* These three acronyms were previously unexplained anywhere
                  in the app -- a Systems Engineer reviewing this tool may
                  know their own domain standards (SOSA/VITA/MIL-STD) without
                  knowing THESE requirement-writing/quality standards, which
                  are internal to how req2ado itself judges quality. */}
              <InfoTip content="EARS: a standard sentence pattern for writing unambiguous requirements. INCOSE: the systems-engineering professional body that publishes requirement-writing best practices. ISO/IEC/IEEE 29148: the international standard for requirements engineering this rubric is based on." />
            </p>
          )}
          {kbCitations && kbCitations.length > 0 && (
            <div className="mt-1">
              <p className="text-sm text-ink-2">KB references:</p>
              <KbCitationChips citations={kbCitations} />
            </div>
          )}
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
