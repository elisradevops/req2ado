import { useEffect, useState } from 'react';
import { getIterationPaths, type AreaPathNode } from '../api/ado';
import { useToast } from './ToastProvider';
import { Combobox } from '../ui/Combobox';

function flatten(node: AreaPathNode): string[] {
  return [node.path, ...node.children.flatMap(flatten)];
}

export function IterationPathPicker({
  value,
  onChange,
  project,
  labelExtra,
}: {
  value: string;
  onChange: (path: string) => void;
  // Optional: scopes the iteration-path fetch to this team project instead
  // of the backend's configured default -- same rationale as
  // AreaPathPicker's own `project` prop.
  project?: string;
  labelExtra?: React.ReactNode;
}): React.ReactElement {
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getIterationPaths(5, project)
      .then((tree) => {
        if (!cancelled) setOptions(flatten(tree));
      })
      .catch(() => {
        if (!cancelled) showToast('Failed to load iteration paths — you can still type one manually.', 'error');
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
      label="Iteration Path (optional)"
      labelExtra={labelExtra}
      value={value}
      onChange={onChange}
      options={options}
      loading={loading}
      fullWidth
    />
  );
}
