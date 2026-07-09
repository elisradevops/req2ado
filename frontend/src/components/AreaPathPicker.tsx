import { useEffect, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { getAreaPaths, type AreaPathNode } from '../api/ado';
import type { AdoRequestCredential } from '../api/jobs';

function flatten(node: AreaPathNode): string[] {
  return [node.path, ...node.children.flatMap(flatten)];
}

export function AreaPathPicker({
  value,
  onChange,
  credential,
}: {
  value: string;
  onChange: (path: string) => void;
  credential: AdoRequestCredential;
}): React.ReactElement {
  const [options, setOptions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getAreaPaths(5, credential).then((tree) => {
      if (!cancelled) setOptions(flatten(tree));
    });
    return () => {
      cancelled = true;
    };
  }, [credential]);

  return (
    <Autocomplete
      options={options}
      value={value || null}
      onChange={(_event, newValue) => onChange(newValue ?? '')}
      renderInput={(params) => <TextField {...params} label="Area Path" />}
    />
  );
}
