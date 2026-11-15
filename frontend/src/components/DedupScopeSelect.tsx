import { Select } from '../ui/Select';
import { InfoTip } from '../ui/Tooltip';

export type DedupScope = 'area_path' | 'project';

// "Search for duplicates in": where each proposed item is compared with existing items. One control and one wording for the single-file wizard
// and the batch page, so the two never drift.
export function DedupScopeSelect({ value, onChange }: { value: DedupScope; onChange: (scope: DedupScope) => void }): React.ReactElement {
  return (
    <Select
      label="Search for duplicates in"
      labelExtra={
        <InfoTip content="Each proposed item is compared with items of the same kind (Epic, Feature or Requirement) that already exist in Azure DevOps, and one that is almost the same as an existing item is flagged with a link to it instead of being created again. Closed items count; Removed items do not." />
      }
      value={value}
      onChange={(event) => onChange(event.target.value === 'project' ? 'project' : 'area_path')}
      helperText="Items of the same kind (Epic, Feature or Requirement) that already exist in the place you choose."
      fullWidth
    >
      <option value="area_path">This area path and everything under it</option>
      <option value="project">The whole project</option>
    </Select>
  );
}
