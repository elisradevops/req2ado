import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectPicker } from './ProjectPicker';
import { ToastProvider } from './ToastProvider';
import * as adoApi from '../api/ado';

vi.mock('../api/ado');

function renderPicker(onChange = vi.fn()) {
  render(
    <ToastProvider>
      <ProjectPicker value="" onChange={onChange} />
    </ToastProvider>,
  );
  return onChange;
}

describe('ProjectPicker', () => {
  it('loads projects and fires onChange when one is selected', async () => {
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([
      { id: '1', name: 'Project' },
      { id: '2', name: 'OtherProject' },
    ]);
    const onChange = renderPicker();

    // Combobox: clicking the input opens the suggestion list.
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'OtherProject' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('OtherProject'));
  });

  it('lists projects A-Z regardless of case', async () => {
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([
      { id: '1', name: 'zeta' },
      { id: '2', name: 'Alpha' },
      { id: '3', name: 'beta' },
    ]);
    renderPicker();

    await userEvent.click(screen.getByLabelText(/team project/i));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('filters the list as the user types, case-insensitively', async () => {
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([
      { id: '1', name: 'Alpha' },
      { id: '2', name: 'Beta' },
      { id: '3', name: 'Gamma' },
    ]);
    renderPicker();

    await userEvent.type(screen.getByLabelText(/team project/i), 'ALP');
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Alpha']);
  });

  it('does not commit free text that matches no project', async () => {
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([{ id: '1', name: 'Alpha' }]);
    const onChange = renderPicker();

    await waitFor(() => expect(adoApi.getProjects).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText(/team project/i), 'Alp');

    expect(onChange).not.toHaveBeenCalledWith('Alpha');
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(await screen.findByText('Pick a project from the list')).toBeInTheDocument();
  });

  it('commits the canonical name when the typed text matches exactly', async () => {
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([{ id: '1', name: 'Alpha' }]);
    const onChange = renderPicker();

    await waitFor(() => expect(adoApi.getProjects).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText(/team project/i), 'alpha');

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('Alpha'));
  });

  it('shows a loading row while projects are still being fetched', async () => {
    vi.spyOn(adoApi, 'getProjects').mockReturnValue(new Promise(() => undefined));
    renderPicker();

    await userEvent.click(screen.getByLabelText(/team project/i));
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
  });
});
