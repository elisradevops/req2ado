import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StatePicker } from './StatePicker';
import { ToastProvider } from './ToastProvider';
import * as adoApi from '../api/ado';

vi.mock('../api/ado');

function renderPicker() {
  render(
    <ToastProvider>
      <StatePicker value="" onChange={vi.fn()} workItemType="Requirement" project="P" />
    </ToastProvider>,
  );
}

describe('StatePicker', () => {
  it('shows a loading dropdown (not a text box) while states are being fetched', () => {
    vi.spyOn(adoApi, 'getStates').mockReturnValue(new Promise(() => undefined));
    renderPicker();
    expect(screen.getByRole('combobox', { name: /initial state/i })).toHaveTextContent('Loading…');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('falls back to free text once the fetch settles with no states', async () => {
    vi.spyOn(adoApi, 'getStates').mockResolvedValue([]);
    renderPicker();
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
  });
});
