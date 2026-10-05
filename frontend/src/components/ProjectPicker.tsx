import { useEffect, useMemo, useState } from 'react';
import { getProjects, type AdoProject } from '../api/ado';
import { useToast } from './ToastProvider';
import { Combobox } from '../ui/Combobox';

export function ProjectPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (name: string) => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<AdoProject[]>([]);
  const [loading, setLoading] = useState(true);
  // The text in the box. Distinct from `value`: a team project must be one
  // of the fetched names, so `value` only ever holds an exact match (or '')
  // while the box holds whatever the user is mid-typing.
  const [query, setQuery] = useState(value);
  const { showToast, showErrorToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    getProjects()
      .then((result) => {
        if (!cancelled) {
          setProjects([...result].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
        }
      })
      .catch((err) => {
        if (!cancelled) showErrorToast('Failed to load team projects.', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  // Keep the box in step with a value the parent sets directly; never
  // clobber what the user is typing when the parent's value is just ''.
  useEffect(() => {
    if (value) setQuery(value);
  }, [value]);

  const names = useMemo(() => projects.map((project) => project.name), [projects]);

  function handleChange(text: string): void {
    setQuery(text);
    const match = projects.find((project) => project.name.toLowerCase() === text.trim().toLowerCase());
    onChange(match ? match.name : '');
  }

  const unresolved = !loading && query.trim() !== '' && !value;

  return (
    <Combobox
      label="Team Project"
      value={query}
      onChange={handleChange}
      options={names}
      loading={loading}
      placeholder="Select or type a project"
      emptyText="No matching team project."
      helperText={unresolved ? 'Pick a project from the list' : undefined}
      fullWidth
    />
  );
}
