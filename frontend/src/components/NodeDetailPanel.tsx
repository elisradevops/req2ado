import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { TagChips } from './TagChips';
import { IssueChips } from './IssueChips';
import { TraceLinkChips } from './TraceLinkChips';
import { ChatPanel } from './ChatPanel';
import { KbCitationChips, type KbCitation } from './KbCitationChips';
import { useToast } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';
import { sendChatTurn } from '../api/chat';

// Fixed, non-editable prompt for the "Suggest a title" button below --
// title distillation beyond the first-sentence rule (a shorter label, or a
// fully custom title unrelated to the source text) can't be done
// deterministically: two independent heuristic attempts, hand-verified
// against the golden TV-Receiver/Remote-Control scenario, were rejected --
// the oracle's own title choices are provably inconsistent under any
// per-line textual signal (same shape input, different desired output).
// This reuses the propose/accept mechanism ChatPanel.tsx already
// implements (no mode gate anywhere in that path -- see its own module for
// the correction to a prior report claiming otherwise): the suggestion is
// opt-in, per-node, and never auto-applied -- nothing writes to the node
// until the reviewer clicks Accept on ChatPanel's own proposal card,
// exactly like a human manually retyping a title today.
const SUGGEST_TITLE_PROMPT = 'Suggest a more specific, concise title for this requirement based on its description.';

export function NodeDetailPanel({
  jobId,
  entry,
  jobMode,
  kbCitations,
  onSave,
}: {
  jobId: string;
  entry: DryRunDiffEntry | null;
  jobMode?: 'baseline' | 'survey' | null;
  kbCitations?: KbCitation[];
  onSave?: (localId: string, patch: { title: string; description: string }) => void;
}): React.ReactElement {
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const isSuggestingRef = useRef(false);
  const [isSuggesting, setIsSuggesting] = useState(false);

  // Exit edit mode whenever the selected node changes so a stale draft from
  // the previously-edited node can never be saved onto a different node.
  // Depend on entry?.localId (not entry itself) — JobDetail.tsx passes a new
  // entry object reference on every parent re-render even for the same node.
  useEffect(() => {
    setEditing(false);
    setDraftTitle('');
    setDraftDescription('');
    isSuggestingRef.current = false;
    setIsSuggesting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.localId]);

  if (!entry) {
    return <Box p={2}><Typography color="text.secondary">Select a node to view details.</Typography></Box>;
  }

  const canEdit = entry.action === 'create' && !entry.excluded;

  function startEditing(): void {
    setDraftTitle(entry!.title);
    setDraftDescription(entry!.description);
    setEditing(true);
  }

  function save(): void {
    onSave?.(entry!.localId, { title: draftTitle, description: draftDescription });
    setEditing(false);
  }

  // Async Mutation Handler pattern: useRef synchronous guard (checked
  // before any await, so synchronous double-clicks before the first
  // re-render can't slip past a useState-only guard) + useState to drive
  // the button's disabled UI, try/catch/finally to surface a failure and
  // always reset the guard. Matches ChatPanel.tsx's own send() (try/catch +
  // showToast) instead of the previous silent fire-and-forget.
  async function suggestTitle(): Promise<void> {
    if (isSuggestingRef.current) return;
    isSuggestingRef.current = true;
    setIsSuggesting(true);
    try {
      // The resulting proposal streams back over the WS channel ChatPanel
      // is already subscribed to (jobId/localId, rendered below) and
      // appears in its existing proposal card -- no separate proposal UI
      // needed here.
      await sendChatTurn(jobId, entry!.localId, SUGGEST_TITLE_PROMPT);
    } catch {
      showToast('Failed to request a title suggestion.', 'error');
    } finally {
      isSuggestingRef.current = false;
      setIsSuggesting(false);
    }
  }

  if (editing) {
    return (
      <Box p={2}>
        <Typography variant="overline">{entry.type}</Typography>
        <TextField
          fullWidth
          label="Title"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          margin="normal"
        />
        <TextField
          fullWidth
          multiline
          label="Description"
          value={draftDescription}
          onChange={(e) => setDraftDescription(e.target.value)}
          margin="normal"
        />
        <Button variant="contained" onClick={save}>Save</Button>
        <Button onClick={() => setEditing(false)}>Cancel</Button>
      </Box>
    );
  }

  return (
    <Box p={2}>
      <Typography variant="overline">{entry.type}</Typography>
      <Typography variant="h6">{entry.title}</Typography>
      <Typography variant="body2">{entry.description}</Typography>
      <TagChips tags={entry.tags} />
      {entry.qualityScore != null && (
        <>
          <Typography variant="body2">Quality score: {entry.qualityScore} / 100</Typography>
          <IssueChips issues={entry.qualityIssues} />
        </>
      )}
      {entry.traceLinks && entry.traceLinks.length > 0 && (
        <Box mt={1}>
          <Typography variant="subtitle2">Trace links</Typography>
          <TraceLinkChips links={entry.traceLinks} />
        </Box>
      )}
      {jobMode === 'survey' && entry.action === 'create' && (
        <Box mt={1}>
          <Typography variant="subtitle2">Sources</Typography>
          <Typography variant="body2">Judged against EARS, INCOSE, ISO/IEC/IEEE 29148</Typography>
          {kbCitations && kbCitations.length > 0 && (
            <Box mt={0.5}>
              <Typography variant="body2">KB references:</Typography>
              <KbCitationChips citations={kbCitations} />
            </Box>
          )}
        </Box>
      )}
      {canEdit && <Button onClick={startEditing}>Edit</Button>}
      {canEdit && <Button onClick={suggestTitle} disabled={isSuggesting}>Suggest a title</Button>}
      {entry && (
        <ChatPanel
          jobId={jobId}
          localId={entry.localId}
          disabled={!canEdit}
          onAcceptProposal={(patch) =>
            onSave?.(entry.localId, {
              title: patch.title ?? entry.title,
              description: patch.description ?? entry.description,
            })
          }
        />
      )}
    </Box>
  );
}
