import { useEffect, useState } from 'react';
import { getAreaPaths, type AreaPathNode } from '../api/ado';
import { useToast } from './ToastProvider';
import { Combobox } from '../ui/Combobox';

function flatten(node: AreaPathNode): string[] {
  return [node.path, ...node.children.flatMap(flatten)];
}

export function AreaPathPicker({
  value,
  onChange,
  project,
  labelExtra,
}: {
  value: string;
  onChange: (path: string) => void;
  // Optional: when set, scopes the area-path fetch to this team project
  // instead of the backend's configured default. When unset (no project
  // picker in use yet), behaves byte-identically to before this prop
  // existed.
  project?: string;
  labelExtra?: React.ReactNode;
}): React.ReactElement {
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAreaPaths(5, project)
      .then((tree) => {
        if (!cancelled) setOptions(flatten(tree));
      })
      .catch(() => {
        if (!cancelled) showToast('Failed to load area paths — you can still type one manually.', 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, showToast]);

  return (
    <Combobox
      label="Area Path"
      labelExtra={labelExtra}
      value={value}
      onChange={onChange}
      options={options}
      loading={loading}
      fullWidth
    />
  );
}
