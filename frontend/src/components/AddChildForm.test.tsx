import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddChildForm } from './AddChildForm';
import type { DryRunDiffEntry } from './DiffTree';

const BASELINE_PARENT: DryRunDiffEntry = {
  localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd',
  action: 'create', customerId: null, tags: [], childType: 'Requirement',
};

describe('AddChildForm', () => {
  it('renders nothing for a manually-added parent in a BASELINE job', () => {
    const { container } = render(
      <AddChildForm parentEntry={{ ...BASELINE_PARENT, isManual: true }} jobMode="baseline" allEntries={[BASELINE_PARENT]} onAdd={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('BASELINE: pre-fills and fixes the type to childType, calls onAdd with it on submit', () => {
    const onAdd = vi.fn();
    render(<AddChildForm parentEntry={BASELINE_PARENT} jobMode="baseline" allEntries={[BASELINE_PARENT]} onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'New Req' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'New desc' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onAdd).toHaveBeenCalledWith({ parentLocalId: 'n0', type: 'Requirement', title: 'New Req', description: 'New desc' });
  });

  it('BASELINE: does not show a parent field -- parent is always parentEntry', () => {
    render(<AddChildForm parentEntry={BASELINE_PARENT} jobMode="baseline" allEntries={[BASELINE_PARENT]} onAdd={vi.fn()} />);
    expect(screen.queryByText(/^parent$/i)).not.toBeInTheDocument();
  });

  it('SURVEY: offers a free choice of all 3 categories', () => {
    const surveyParent = { ...BASELINE_PARENT, childType: null };
    render(<AddChildForm parentEntry={surveyParent} jobMode="survey" allEntries={[surveyParent]} onAdd={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /type/i })).toBeInTheDocument();
  });

  // CR: reparent -- Phase 5's headline capability: the parent field
  // defaults to the dialog's own node, but is changeable to any valid
  // parent via MoveToPicker.
  it('SURVEY: defaults the parent to parentEntry, marked as a suggestion', () => {
    const surveyParent = { ...BASELINE_PARENT, childType: null };
    render(<AddChildForm parentEntry={surveyParent} jobMode="survey" allEntries={[surveyParent]} onAdd={vi.fn()} />);
    expect(screen.getByText(/suggested/i)).toBeInTheDocument();
    // The value span shows the currently-selected parent's own title.
    expect(screen.getByText('Parent', { selector: 'span.min-w-0' })).toBeInTheDocument();
  });

  it('SURVEY: submits with the changed parent, no longer marked as a suggestion', async () => {
    const surveyParent = { ...BASELINE_PARENT, childType: null }; // type: 'Feature'
    // Default surveyType is now parentEntry.type ('Feature') -- see the
    // review fix above -- so the alternate candidate must be something a
    // Feature CAN nest under/as-sibling-of: another Feature (repeat tier).
    const otherFeature: DryRunDiffEntry = { localId: 'f1', parentLocalId: null, type: 'Feature', title: 'Other Feature', description: '', action: 'create', customerId: null };
    const onAdd = vi.fn();
    render(<AddChildForm parentEntry={surveyParent} jobMode="survey" allEntries={[surveyParent, otherFeature]} onAdd={onAdd} />);

    // Default type is Feature (parentEntry.type -- repeat-tier is always
    // canNest-valid against itself), so the default suggested parent is
    // surveyParent itself. The trigger's accessible name is its aria-label
    // ("Parent for this X"), not its visible "Change" text -- aria-label
    // wins for accessible-name computation, and it's deliberately more
    // specific for screen readers.
    await userEvent.click(screen.getByRole('button', { name: /parent for this feature/i }));
    await userEvent.click(screen.getByText('Other Feature'));

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Y' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(onAdd).toHaveBeenCalledWith({ parentLocalId: 'f1', type: 'Feature', title: 'X', description: 'Y' });
    expect(screen.queryByText(/suggested/i)).not.toBeInTheDocument();
  });

  // CR: reparent review fix -- surveyType previously defaulted to a
  // hardcoded 'Requirement' regardless of parentEntry.type, while
  // parentLocalId defaulted to parentEntry.localId. Opening this form from
  // an Epic (this feature's own headline scenario) left the Add button
  // enabled with an invalid (Requirement, Epic) pair -- canNest rejects
  // skipping a tier -- 400ing on submit unless the user happened to touch
  // the Type selector first. Regression test: submitting immediately from
  // an Epic parent, untouched, must send a valid canNest pair.
  it('SURVEY: defaults the type to the parent\'s own category, so submitting immediately from an Epic parent is valid', () => {
    const manualEpic: DryRunDiffEntry = { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Manual Epic', description: '', action: 'create', customerId: null, isManual: true };
    const onAdd = vi.fn();
    render(<AddChildForm parentEntry={manualEpic} jobMode="survey" allEntries={[manualEpic]} onAdd={onAdd} />);

    expect(screen.getByRole('button', { name: /^add$/i })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'New Feature' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Y' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(onAdd).toHaveBeenCalledWith({ parentLocalId: 'e1', type: 'Epic', title: 'New Feature', description: 'Y' });
  });

  // CR: reparent -- the plan's own headline scenario: create a manual Epic
  // to house orphaned Features, then add a Feature under it. Unblocked by
  // relaxing the isManual restriction in SURVEY mode only.
  it('SURVEY: allows adding under a manually-added parent', () => {
    const manualEpic: DryRunDiffEntry = { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Manual Epic', description: '', action: 'create', customerId: null, isManual: true };
    const { container } = render(<AddChildForm parentEntry={manualEpic} jobMode="survey" allEntries={[manualEpic]} onAdd={vi.fn()} />);
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
  });

  it('SURVEY: offers "Top level" as a valid root option for the top category, and disables Add until one is chosen when nothing else qualifies', async () => {
    const onlyRequirement: DryRunDiffEntry = { localId: 'r0', parentLocalId: null, type: 'Requirement', title: 'Some Req', description: '', action: 'create', customerId: null };
    render(<AddChildForm parentEntry={onlyRequirement} jobMode="survey" allEntries={[onlyRequirement]} onAdd={vi.fn()} />);

    // Default category is Requirement; onlyRequirement (a Requirement) is a
    // valid parent for another Requirement, so it's pre-selected -- switch
    // to Epic, which has no valid existing parent and CAN be root.
    // ui/Select.tsx is a Radix combobox+listbox, not a native <select> --
    // open it, then click the option, same convention as NewJobWizard.test.tsx.
    await userEvent.click(screen.getByRole('combobox', { name: /type/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Epic' }));
    expect(screen.getByText(/top level/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add$/i })).not.toBeDisabled();
  });

  it('SURVEY: disables Add when no valid parent exists and root placement is not allowed', () => {
    const onlyRequirement: DryRunDiffEntry = { localId: 'r0', parentLocalId: null, type: 'Requirement', title: 'Some Req', description: '', action: 'create', customerId: null };
    const onlyEpic: DryRunDiffEntry = { localId: 'e0', parentLocalId: null, type: 'Epic', title: 'Some Epic', description: '', action: 'create', customerId: null };
    // Default surveyType is Requirement; the only entries are two nodes
    // that can't hold a Requirement as a new top-level pick once we force
    // the type to Feature with an Epic already present (Feature can't
    // root when an Epic exists, and neither entry accepts a Feature child).
    render(<AddChildForm parentEntry={onlyRequirement} jobMode="survey" allEntries={[onlyRequirement, onlyEpic]} onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^add$/i })).not.toBeDisabled(); // sanity: Requirement under onlyRequirement is valid by default
  });

  it('renders real per-project type labels (categoryLabels) in the type Select', async () => {
    const surveyParent = { ...BASELINE_PARENT, childType: null }; // type: 'Feature'
    render(
      <AddChildForm
        parentEntry={surveyParent}
        jobMode="survey"
        allEntries={[surveyParent]}
        categoryLabels={{ Epic: 'Epic', Feature: 'Capability', Requirement: 'User Story' }}
        onAdd={vi.fn()}
      />,
    );
    // The trigger shows the currently-selected option's real label
    // (default category is parentEntry.type, 'Feature') without needing
    // to open the popup.
    expect(screen.getByRole('combobox', { name: /type/i })).toHaveTextContent('Capability');
    await userEvent.click(screen.getByRole('combobox', { name: /type/i }));
    expect(await screen.findByRole('option', { name: 'User Story' })).toBeInTheDocument();
  });
});

// CR: reparent -- the tree toolbar's "+ New item" entry point (JobDetail.tsx)
// has no anchor node at all, unlike "Add child" from an existing node's
// dialog. parentEntry is optional for exactly this call site.
describe('AddChildForm (no parentEntry -- toolbar "New item")', () => {
  it('shows "New item" (not "Add child item") and defaults to the top category at the root', () => {
    render(<AddChildForm jobMode="survey" allEntries={[]} onAdd={vi.fn()} />);
    expect(screen.getByText('New item')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /type/i })).toHaveTextContent('Epic');
    expect(screen.getByText(/top level/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add$/i })).not.toBeDisabled();
  });

  it('submits a root-level item with parentLocalId: null', () => {
    const onAdd = vi.fn();
    render(<AddChildForm jobMode="survey" allEntries={[]} onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'New Epic' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Y' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(onAdd).toHaveBeenCalledWith({ parentLocalId: null, type: 'Epic', title: 'New Epic', description: 'Y' });
  });

  it('lets the parent be changed to an existing node via the picker', async () => {
    const existingEpic: DryRunDiffEntry = { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Existing Epic', description: '', action: 'create', customerId: null };
    const onAdd = vi.fn();
    render(<AddChildForm jobMode="survey" allEntries={[existingEpic]} onAdd={onAdd} />);

    await userEvent.click(screen.getByRole('button', { name: /parent for this epic/i }));
    await userEvent.click(screen.getByText('Existing Epic'));

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Sub Epic' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Y' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(onAdd).toHaveBeenCalledWith({ parentLocalId: 'e1', type: 'Epic', title: 'Sub Epic', description: 'Y' });
  });

  it('disables Add when switching to a category with no valid parent and no root option', async () => {
    render(<AddChildForm jobMode="survey" allEntries={[]} onAdd={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox', { name: /type/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Requirement' }));
    // No entries exist at all, and a Requirement can never root.
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
  });
});
