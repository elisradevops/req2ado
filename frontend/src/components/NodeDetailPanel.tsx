import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { TagChips } from './TagChips';
import { IssueChips } from './IssueChips';
import type { DryRunDiffEntry } from './DiffTree';

export function NodeDetailPanel({
  entry,
  onSave,
}: {
  entry: DryRunDiffEntry | null;
  onSave?: (localId: string, patch: { title: string; description: string }) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');

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
      {canEdit && <Button onClick={startEditing}>Edit</Button>}
    </Box>
  );
}
