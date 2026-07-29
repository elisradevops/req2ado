import { useEffect, useState } from 'react';
import { getStates } from '../api/ado';
import { useToast } from './ToastProvider';
import { Select } from '../ui/Select';
import { TextField } from '../ui/TextField';

export function StatePicker({
  value,
  onChange,
  workItemType,
  project,
  labelExtra,
}: {
  value: string;
  onChange: (state: string) => void;
  workItemType: string;
  // Optional: scopes the states fetch to this team project instead of the
  // backend's configured default -- same rationale as AreaPathPicker's own
  // `project` prop. A process template's workflow states genuinely differ
  // per project (e.g. Agile vs CMMI), so omitting this silently showed the
  // backend's single default project's states regardless of which project
  // the user actually picked (confirmed live).
  project?: string;
  labelExtra?: React.ReactNode;
}): React.ReactElement {
  const [options, setOptions] = useState<string[]>([]);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    getStates(workItemType, project)
      .then((states) => {
        if (!cancelled) setOptions(states);
      })
      .catch(() => {
        if (!cancelled) showToast('Failed to load work-item states — you can still type one manually.', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [workItemType, project, showToast]);

  if (options.length === 0) {
    return (
      <TextField
        label="Initial State (optional)"
        labelExtra={labelExtra}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        fullWidth
      />
    );
  }

  return (
    <Select
      label="Initial State (optional)"
      labelExtra={labelExtra}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      helperText="Defaults to the process template's first state if left unset"
      fullWidth
    >
      <option value="">Default</option>
      {options.map((state) => (
        <option key={state} value={state}>
          {state}
        </option>
      ))}
    </Select>
  );
}
