import { useEffect, useState } from 'react';
import { getStates } from '../api/ado';
import { useToast } from './ToastProvider';
import { Select } from '../ui/Select';
import { TextField } from '../ui/TextField';

// The three kinds of item a job writes, each with its OWN workflow in the project's process (Agile's Epic and Feature start at "New", CMMI's at
// "Proposed", a custom process can differ between them): the states offered are the ones the project really has for these types.
const WRITTEN_TYPES = ['Epic', 'Feature', 'Requirement'];

/** The states every list has, in the first list's order. */
function sharedStates(lists: string[][]): string[] {
  const [first, ...rest] = lists;
  return (first ?? []).filter((state) => rest.every((other) => other.includes(state)));
}

export function StatePicker({
  value,
  onChange,
  workItemTypes = WRITTEN_TYPES,
  project,
  labelExtra,
}: {
  value: string;
  onChange: (state: string) => void;
  // The types whose workflows must all have a state for it to be offered.
  workItemTypes?: string[];
  // Optional: scopes the states fetch to this team project instead of the
  // backend's configured default -- same rationale as AreaPathPicker's own
  // `project` prop. A process template's workflow states genuinely differ
  // per project (e.g. Agile vs CMMI), so omitting this silently showed the
  // backend's single default project's states regardless of which project
  // the user actually picked (confirmed live).
  project?: string;
  labelExtra?: React.ReactNode;
}): React.ReactElement {
  const [lists, setLists] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast, showErrorToast } = useToast();
  const typesKey = workItemTypes.join('|');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled(workItemTypes.map((type) => getStates(type, project)))
      .then((results) => {
        if (cancelled) return;
        const loaded = results.flatMap((result) => (result.status === 'fulfilled' && result.value.length > 0 ? [result.value] : []));
        setLists(loaded);
        // Only when nothing could be read at all: a single type that failed still leaves the others to offer states from.
        if (loaded.length === 0 && results.some((result) => result.status === 'rejected')) {
          const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          showErrorToast('Failed to load work-item states — you can still type one manually.', failed?.reason);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- typesKey stands for workItemTypes
  }, [typesKey, project, showToast]);

  const options = sharedStates(lists);
  const everyState = [...new Set(lists.flat())];
  const typesDiffer = everyState.length > options.length;

  // Only fall back to free text once the fetch has settled empty/failed --
  // not while it is in flight, which swapped a text box for a dropdown. A typed state a type does not have starts that type in its default
  // state when the job is written, so free text is safe.
  if (!loading && lists.length === 0) {
    return (
      <TextField
        label="Initial state (optional)"
        labelExtra={labelExtra}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        fullWidth
      />
    );
  }

  return (
    <Select
      label="Initial state (optional)"
      labelExtra={labelExtra}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      loading={loading}
      helperText={
        typesDiffer
          ? options.length === 0
            ? "These work item types have no state in common in this project, so each starts in its own default state."
            : 'Only states every work item type has are listed. Default starts each type in its own default state.'
          : "Default starts each work item type in its own default state."
      }
      fullWidth
    >
      <option value="">Default (each type's own)</option>
      {options.map((state) => (
        <option key={state} value={state}>
          {state}
        </option>
      ))}
    </Select>
  );
}
