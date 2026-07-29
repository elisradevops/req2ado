import { useState } from 'react';
import { TextField, TextArea } from '../ui/TextField';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
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
    <div className="flex flex-col gap-3 p-4">
      <div>
        <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Add child item</p>
        <p className="text-xs text-ink-3">Manually add another item under this one -- it's written to ADO alongside the rest on Confirm.</p>
      </div>
      {jobMode === 'baseline' ? (
        <TextField label="Type" value={type} disabled fullWidth />
      ) : (
        <Select label="Type" aria-label="Type" value={surveyType} onChange={(e) => setSurveyType(e.target.value)} fullWidth>
          {ALL_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      )}
      <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth />
      <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth />
      <Button onClick={submit} className="self-start">
        Add
      </Button>
    </div>
  );
}
