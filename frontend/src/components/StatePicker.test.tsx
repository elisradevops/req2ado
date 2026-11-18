import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatePicker } from './StatePicker';
import { ToastProvider } from './ToastProvider';
import * as adoApi from '../api/ado';

vi.mock('../api/ado');

function renderPicker(onChange = vi.fn(), project = 'P') {
  render(
    <ToastProvider>
      <StatePicker value="" onChange={onChange} project={project} />
    </ToastProvider>,
  );
  return onChange;
}

const byType = (states: Record<string, string[] | Error>) =>
  vi.spyOn(adoApi, 'getStates').mockImplementation(async (type: string) => {
    const result = states[type];
    if (result instanceof Error) throw result;
    return result ?? [];
  });

// The dropdown is a custom combobox: its options exist only while it is open, and only once the states have loaded.
async function openPicker() {
  const combobox = screen.getByRole('combobox', { name: 'Initial state (optional)' });
  await waitFor(() => expect(combobox).not.toHaveTextContent('Loading…'));
  await userEvent.click(combobox);
  return combobox;
}
const optionNames = () => screen.getAllByRole('option').map((option) => option.textContent);

describe('StatePicker', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows a loading dropdown (not a text box) while states are being fetched', () => {
    vi.spyOn(adoApi, 'getStates').mockReturnValue(new Promise(() => undefined));
    renderPicker();
    expect(screen.getByRole('combobox', { name: 'Initial state (optional)' })).toHaveTextContent('Loading…');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('falls back to free text once the fetch settles with no states', async () => {
    vi.spyOn(adoApi, 'getStates').mockResolvedValue([]);
    renderPicker();
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
  });

  it("asks for the states of the selected project's Epic, Feature and Requirement, not one type", async () => {
    const spy = byType({ Epic: ['New'], Feature: ['New'], Requirement: ['New'] });
    renderPicker(vi.fn(), 'Elbit');
    await openPicker();

    expect(spy.mock.calls.map(([type, project]) => [type, project]).sort()).toEqual([
      ['Epic', 'Elbit'],
      ['Feature', 'Elbit'],
      ['Requirement', 'Elbit'],
    ]);
  });

  it('lists only the states every type has, after the Default choice', async () => {
    byType({ Epic: ['Proposed', 'Active', 'Closed'], Feature: ['Proposed', 'Active'], Requirement: ['New', 'Active', 'Proposed'] });
    renderPicker();
    await openPicker();

    expect(optionNames()).toEqual(["Default (each type's own)", 'Proposed', 'Active']);
    expect(screen.getByText(/only states every work item type has are listed/i)).toBeInTheDocument();
  });

  it('says so, and offers only Default, when the types have no state in common', async () => {
    byType({ Epic: ['Proposed'], Feature: ['Proposed'], Requirement: ['New'] });
    renderPicker();
    await openPicker();

    expect(optionNames()).toEqual(["Default (each type's own)"]);
    expect(screen.getByText(/no state in common/i)).toBeInTheDocument();
  });

  it('does not mention a difference when every type has the same states', async () => {
    byType({ Epic: ['New', 'Active'], Feature: ['New', 'Active'], Requirement: ['New', 'Active'] });
    renderPicker();
    await openPicker();

    expect(screen.queryByText(/only states every work item type has/i)).not.toBeInTheDocument();
  });

  it('still offers states when one type could not be read, from the types that could', async () => {
    byType({ Epic: new Error('403'), Feature: ['New', 'Active'], Requirement: ['New', 'Active'] });
    renderPicker();
    await openPicker();

    expect(optionNames()).toEqual(["Default (each type's own)", 'New', 'Active']);
  });

  it('shows Default when nothing is chosen, and reports a picked state', async () => {
    byType({ Epic: ['New'], Feature: ['New'], Requirement: ['New'] });
    const onChange = renderPicker();
    const combobox = await openPicker();

    expect(combobox).toHaveTextContent("Default (each type's own)");
    await userEvent.click(screen.getByRole('option', { name: 'New' }));
    expect(onChange).toHaveBeenCalledWith('New');
  });
});
