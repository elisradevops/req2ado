import { useState } from 'react';
import { TextField, TextArea } from '../ui/TextField';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { MoveToPicker } from './MoveToPicker';
import { LABEL_MICRO } from '../utils/labelMicro';
import { canNest, canBeRoot } from '../lib/canNest';
import type { DryRunDiffEntry } from './DiffTree';
import type { WorkItemTypeCatalogEntry } from '../api/ado';

const ALL_CATEGORIES = ['Epic', 'Feature', 'Requirement'] as const;

// DESIGN.md §11.5 -- the parent field is only offered in SURVEY mode.
// BASELINE mode's type is mechanically tied to whichever parent the dialog
// was opened from (parentEntry.childType, an ingestion-computed field with
// no equivalent for an arbitrary OTHER node), so letting the parent change
// there has no coherent "what type may I add" answer -- and the server
// (jobs.service.ts's addDiffEntry) still rejects a manually-added parent in
// BASELINE mode for exactly this reason. SURVEY mode's category model
// (Epic/Feature/Requirement, canNest) has no such constraint -- any valid
// parent can be chosen, which is what unblocks this feature's own headline
// scenario: create a manual Epic to house orphaned Features, then add a
// Feature under it.
//
// parentEntry is OPTIONAL -- this same form backs two call sites: "Add
// child" from an existing node's detail dialog (AddChildCard passes a real
// entry) and the tree toolbar's "+ New item" (JobDetail.tsx passes none,
// since there's no anchor node at all). BASELINE mode is meaningless
// without an anchor (its type is inherited from the anchor's own
// childType) -- the toolbar entry point only ever mounts this in SURVEY
// mode, but the component stays defensive regardless.
export function AddChildForm({
  parentEntry,
  jobMode,
  allEntries,
  categoryLabels,
  typeCatalog,
  onAdd,
}: {
  parentEntry?: DryRunDiffEntry;
  jobMode: 'baseline' | 'survey';
  // Full diff, for the parent picker's candidate list (SURVEY only) --
  // Object.values(diffByLocalId) at the call site.
  allEntries: DryRunDiffEntry[];
  // Category -> this project's real ADO type name, for the type Select's
  // LABELS only -- the submitted value always stays the category (see
  // jobs.service.ts's own realType()-boundary comment). Undefined falls
  // back to the identity map (CMMI-shaped labels).
  categoryLabels?: Record<'Epic' | 'Feature' | 'Requirement', string>;
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
  onAdd: (input: { parentLocalId: string | null; type: string; title: string; description: string }) => void;
}): React.ReactElement | null {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // CR: reparent review fix -- was hardcoded to ALL_CATEGORIES[2]
  // ('Requirement') regardless of parentEntry.type, while parentLocalId
  // defaults to parentEntry.localId. Opening this form from an Epic (the
  // plan's own headline scenario -- a manually-created Epic housing
  // orphaned Features) left the Add button enabled with an invalid pair
  // (canNest('Requirement', 'Epic') is false), 400ing on submit unless the
  // user happened to touch the Type selector first. parentEntry.type is
  // always canNest-valid against itself (repeat-tier is always legal), so
  // this guarantees a valid initial pair with no extra reconciliation. No
  // anchor (toolbar "+ New item") defaults to the top category -- the most
  // useful starting point when there's nothing to inherit from.
  const [surveyType, setSurveyType] = useState<string>(parentEntry?.type ?? ALL_CATEGORIES[0]);
  // Defaults to the node the dialog was opened from -- changeable via
  // MoveToPicker in SURVEY mode. null means "top level," which is only a
  // legitimate final answer when allowRoot is also true -- otherwise it
  // means "no valid parent has been found/chosen yet." `parentIsSuggested`
  // distinguishes "we picked this for you" from "you chose this," rather
  // than inferring it from whether the value happens to differ from
  // parentEntry (imprecise: a user could explicitly re-select the same node).
  // No anchor -> null (root), which is exactly right for the default
  // category (Epic can always root).
  const [parentLocalId, setParentLocalId] = useState<string | null>(parentEntry?.localId ?? null);
  const [parentIsSuggested, setParentIsSuggested] = useState(parentEntry != null);

  // See this file's own top comment -- BASELINE mode never offers this
  // form under a manual parent (childType is always null there, so no
  // real type could ever match); SURVEY mode does.
  if (parentEntry?.isManual && jobMode === 'baseline') return null;

  const type = jobMode === 'baseline' ? (parentEntry?.childType ?? '') : surveyType;

  function realTypeName(category: string): string {
    return categoryLabels?.[category as 'Epic' | 'Feature' | 'Requirement'] ?? category;
  }

  // Every valid EXISTING parent for `category` -- backs both the picker's
  // candidate list and the fallback-suggestion logic below, so there is
  // one definition of "valid parent," matching the move endpoint's own
  // canNest-based validation (jobs.service.ts).
  function validParentsFor(category: string): DryRunDiffEntry[] {
    return allEntries.filter((entry) => canNest(category, entry.type));
  }

  function handleSurveyTypeChange(nextType: string): void {
    setSurveyType(nextType);
    // The previously-selected parent may no longer be valid for the new
    // category (e.g. switching from Requirement to Epic) -- recompute a
    // fallback rather than silently submitting an invalid pair. Prefers
    // the CURRENT parentEntry when it still fits, then the first existing
    // valid parent, then root (only if the category permits it).
    if (parentLocalId && canNest(nextType, allEntries.find((e) => e.localId === parentLocalId)?.type ?? '')) return;
    if (parentEntry && canNest(nextType, parentEntry.type)) {
      setParentLocalId(parentEntry.localId);
      setParentIsSuggested(true);
      return;
    }
    const candidates = validParentsFor(nextType);
    setParentLocalId(candidates[0]?.localId ?? null);
    setParentIsSuggested(true);
  }

  const anyEpicExists = allEntries.some((entry) => entry.type === 'Epic');
  const allowRoot = jobMode === 'survey' && canBeRoot(surveyType, anyEpicExists);
  const candidates = jobMode === 'survey' ? validParentsFor(surveyType) : [];
  const selectedParent = allEntries.find((entry) => entry.localId === parentLocalId);
  // A null parentLocalId is only a legitimate final answer when root
  // placement is actually allowed for this category -- otherwise it means
  // "nothing valid found/chosen yet," which must block submission rather
  // than silently posting a request the server would reject anyway.
  const hasUsableParent = jobMode === 'baseline' || parentLocalId !== null || allowRoot;

  function submit(): void {
    if (!hasUsableParent) return;
    onAdd({ parentLocalId: jobMode === 'baseline' ? (parentEntry?.localId ?? null) : parentLocalId, type, title, description });
    setTitle('');
    setDescription('');
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <p className={LABEL_MICRO}>{parentEntry ? 'Add child item' : 'New item'}</p>
        <p className="text-xs text-ink-3">Manually add another item -- it's written to ADO alongside the rest on Confirm.</p>
      </div>
      {jobMode === 'baseline' ? (
        <TextField label="Type" value={type} disabled fullWidth />
      ) : (
        <Select label="Type" aria-label="Type" value={surveyType} onChange={(e) => handleSurveyTypeChange(e.target.value)} fullWidth>
          {ALL_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {realTypeName(category)}
            </option>
          ))}
        </Select>
      )}
      {jobMode === 'survey' && (
        <div className="flex items-center gap-2 rounded-sm border border-hairline bg-surface px-2.5 py-1.5 text-xs">
          <span className="flex-none text-ink-3">
            Parent
            {parentIsSuggested && <span className="text-warning"> (suggested)</span>}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-ink-1">
            {selectedParent ? `${selectedParent.customerId ? selectedParent.customerId + ' ' : ''}${selectedParent.title}` : allowRoot ? 'Top level' : '(none available)'}
          </span>
          <MoveToPicker
            triggerLabel={candidates.length ? 'Change' : allowRoot ? 'Change' : 'No valid parent yet'}
            triggerAriaLabel={`Parent for this ${realTypeName(surveyType)}`}
            popoverLabel={`Parent for this ${realTypeName(surveyType)}…`}
            candidates={candidates.map((entry) => ({ localId: entry.localId, type: entry.type, title: entry.title, customerId: entry.customerId }))}
            allowRoot={allowRoot}
            rootLabel="Top level (no parent)"
            categoryLabels={categoryLabels}
            typeCatalog={typeCatalog}
            disabled={candidates.length === 0 && !allowRoot}
            onSelect={(localId) => {
              setParentLocalId(localId);
              setParentIsSuggested(false);
            }}
          />
        </div>
      )}
      <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth />
      <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth />
      <Button onClick={submit} className="self-start" disabled={!hasUsableParent}>
        Add
      </Button>
    </div>
  );
}
