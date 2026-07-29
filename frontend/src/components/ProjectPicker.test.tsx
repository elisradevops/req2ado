import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectPicker } from './ProjectPicker';
import { ToastProvider } from './ToastProvider';
import * as adoApi from '../api/ado';

vi.mock('../api/ado');

describe('ProjectPicker', () => {
  it('loads projects and fires onChange when one is selected', async () => {
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([
      { id: '1', name: 'Project' },
      { id: '2', name: 'OtherProject' },
    ]);
    const onChange = vi.fn();
    render(
      <ToastProvider>
        <ProjectPicker value="" onChange={onChange} credential={{ orgUrl: 'https://ado.example', pat: 'x' }} />
      </ToastProvider>,
    );

    // Select is a Radix combobox+listbox now (native <select> popups can
    // render detached from their trigger after the page scrolls -- a real
    // WebKit bug), so the RTL interaction is open-then-click-option, not
    // selectOptions (that API only targets a real <select> element).
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'OtherProject' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('OtherProject'));
  });
});
