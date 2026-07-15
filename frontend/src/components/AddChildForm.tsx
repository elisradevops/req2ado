import { useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import type { DryRunDiffEntry } from './DiffTree';

const ALL_TYPES = ['Epic', 'Feature', 'Requirement'];

export function AddChildForm({
  parentEntry,
  jobMode,
  onAdd,
}: {
  parentEntry: DryRunDiffEntry;
  jobMode: 'baseline' | 'survey';
  onAdd: (input: { type: string; title: string; description: string }) => void;
}): React.ReactElement | null {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [surveyType, setSurveyType] = useState(ALL_TYPES[2]);

  if (parentEntry.isManual) return null;

  const type = jobMode === 'baseline' ? parentEntry.childType ?? '' : surveyType;

  function submit(): void {
    onAdd({ type, title, description });
    setTitle('');
    setDescription('');
  }

  return (
    <Box p={2}>
      {jobMode === 'baseline' ? (
        <TextField label="Type" value={type} disabled fullWidth margin="normal" />
      ) : (
        <TextField
          select
          label="Type"
          value={surveyType}
          onChange={(e) => setSurveyType(e.target.value)}
          fullWidth
          margin="normal"
          slotProps={{ select: { 'aria-label': 'Type' } as any }}
        >
          {ALL_TYPES.map((t) => (
            <MenuItem key={t} value={t}>{t}</MenuItem>
          ))}
        </TextField>
      )}
      <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth margin="normal" />
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline margin="normal" />
      <Button variant="contained" onClick={submit}>Add</Button>
    </Box>
  );
}
