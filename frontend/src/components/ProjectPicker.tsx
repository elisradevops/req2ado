import { useEffect, useState } from 'react';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import { getProjects, type AdoProject } from '../api/ado';
import type { AdoRequestCredential } from '../api/jobs';
import { useToast } from './ToastProvider';

export function ProjectPicker({
  value,
  onChange,
  credential,
}: {
  value: string;
  onChange: (name: string) => void;
  credential: AdoRequestCredential;
}): React.ReactElement {
  const [projects, setProjects] = useState<AdoProject[]>([]);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    getProjects(credential)
      .then((result) => {
        if (!cancelled) setProjects(result);
      })
      .catch(() => {
        if (!cancelled) showToast('Failed to load team projects.', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [credential, showToast]);

  return (
    <TextField select label="Team Project" value={value} onChange={(event) => onChange(event.target.value)}>
      {projects.map((project) => (
        <MenuItem key={project.id} value={project.name}>
          {project.name}
        </MenuItem>
      ))}
    </TextField>
  );
}
