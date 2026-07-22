import { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { getAreaPaths, type AreaPathNode } from '../api/ado';
import type { AdoRequestCredential } from '../api/jobs';
import { useToast } from './ToastProvider';

function flatten(node: AreaPathNode): string[] {
  return [node.path, ...node.children.flatMap(flatten)];
}

export function AreaPathPicker({
  value,
  onChange,
  credential,
  project,
}: {
  value: string;
  onChange: (path: string) => void;
  credential: AdoRequestCredential;
  // Optional: when set, scopes the area-path fetch to this team project
  // instead of the backend's configured default. When unset (no project
  // picker in use yet), behaves byte-identically to before this prop
  // existed.
  project?: string;
}): React.ReactElement {
  const [options, setOptions] = useState<string[]>([]);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    getAreaPaths(5, credential, project)
      .then((tree) => {
        if (!cancelled) setOptions(flatten(tree));
      })
      .catch(() => {
        if (!cancelled) showToast('Failed to load area paths — you can still type one manually.', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [credential, project, showToast]);

  return (
    <Autocomplete
      freeSolo
      options={options}
      value={value || null}
      onChange={(_event, newValue) => onChange(newValue ?? '')}
      onInputChange={(_event, newInputValue) => onChange(newInputValue)}
      renderInput={(params) => <TextField {...params} label="Area Path" />}
    />
  );
}
