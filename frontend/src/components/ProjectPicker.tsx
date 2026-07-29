import { useEffect, useState } from 'react';
import { getProjects, type AdoProject } from '../api/ado';
import { useToast } from './ToastProvider';
import { Select } from '../ui/Select';

export function ProjectPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (name: string) => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<AdoProject[]>([]);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    getProjects()
      .then((result) => {
        if (!cancelled) setProjects(result);
      })
      .catch(() => {
        if (!cancelled) showToast('Failed to load team projects.', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  return (
    <Select label="Team Project" value={value} onChange={(event) => onChange(event.target.value)} fullWidth>
      <option value="" disabled>
        Select a project
      </option>
      {projects.map((project) => (
        <option key={project.id} value={project.name}>
          {project.name}
        </option>
      ))}
    </Select>
  );
}
