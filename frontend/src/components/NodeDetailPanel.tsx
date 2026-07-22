import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { TagChips } from './TagChips';
import { IssueChips } from './IssueChips';
import { TraceLinkChips } from './TraceLinkChips';
import { ChatPanel } from './ChatPanel';
import { KbCitationChips, type KbCitation } from './KbCitationChips';
import type { DryRunDiffEntry } from './DiffTree';

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
