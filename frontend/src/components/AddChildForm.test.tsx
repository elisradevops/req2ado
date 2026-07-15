import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddChildForm } from './AddChildForm';
import type { DryRunDiffEntry } from './DiffTree';

const BASELINE_PARENT: DryRunDiffEntry = {
  localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd',
  action: 'create', customerId: null, tags: [], childType: 'Requirement',
};

describe('AddChildForm', () => {
  it('renders nothing for a manually-added parent', () => {
    const { container } = render(
      <AddChildForm parentEntry={{ ...BASELINE_PARENT, isManual: true }} jobMode="baseline" onAdd={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('BASELINE: pre-fills and fixes the type to childType, calls onAdd with it on submit', () => {
    const onAdd = vi.fn();
    render(<AddChildForm parentEntry={BASELINE_PARENT} jobMode="baseline" onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'New Req' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'New desc' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onAdd).toHaveBeenCalledWith({ type: 'Requirement', title: 'New Req', description: 'New desc' });
  });

  it('SURVEY: offers a free choice of all 3 types', () => {
    const surveyParent = { ...BASELINE_PARENT, childType: null };
    render(<AddChildForm parentEntry={surveyParent} jobMode="survey" onAdd={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /type/i })).toBeInTheDocument();
  });
});
