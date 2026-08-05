import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NewJobWizard } from './NewJobWizard';
import { ToastProvider } from '../components/ToastProvider';
import * as jobsApi from '../api/jobs';
import * as adoApi from '../api/ado';
import { useAuthStore } from '../store/authStore';

vi.mock('../api/jobs');
vi.mock('../api/ado');

describe('NewJobWizard Step 1', () => {
  it('uploads a file and fills in the stat tiles in place, without leaving step 1', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({ blockCount: 42, sectionCount: 5, figureCount: 3, depth: 4, fileType: 'docx' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    const file = new File(['x'], 'req.docx');
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    await userEvent.upload(input, file);
    await waitFor(() => expect(screen.getByText(/42/)).toBeInTheDocument());
    // Destination in Azure DevOps only exists on step 2 -- its absence
    // confirms parsing finished WITHOUT auto-navigating away from step 1.
    expect(screen.queryByText(/destination in azure devops/i)).not.toBeInTheDocument();
  });

  it('shows the document identity card (filename + size) and the Figures/Depth stat tiles', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({ blockCount: 42, sectionCount: 5, figureCount: 7, depth: 3, fileType: 'docx' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    const file = new File(['x'.repeat(2048)], 'SRD-EW-2100.docx');
    await userEvent.upload(screen.getByLabelText(/upload/i), file);

    // The filename now also appears in the parsed dropzone's own status
    // label (DESIGN.md Track B phase B14) -- getAllByText tolerates that
    // expected duplication.
    await waitFor(() => expect(screen.getAllByText('SRD-EW-2100.docx').length).toBeGreaterThan(0));
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('Figures')).toBeInTheDocument();
    expect(screen.getByText('Depth')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    expect(screen.getByLabelText(/upload/i)).toBeInTheDocument();
    // Replace resets in place (no navigation needed -- we never left step
    // 1) and the tiles/document card must be gone until a new file lands.
    expect(screen.queryByText('Figures')).not.toBeInTheDocument();
  });

  it('Step 2 submits with mode, area path, and optional state/iteration', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({ blockCount: 20, sectionCount: 3, fileType: 'docx' });
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-99' });
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue(['qwen2.5:1.5b']);
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([{ id: '1', name: 'Project' }]);
    vi.spyOn(adoApi, 'getAreaPaths').mockResolvedValue({ path: 'Project', children: [] });
    vi.spyOn(adoApi, 'getIterationPaths').mockResolvedValue({ path: 'Project', children: [] });
    vi.spyOn(adoApi, 'getStates').mockResolvedValue(['Proposed', 'Active']);
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');

    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() => expect(screen.getByText(/20/)).toBeInTheDocument());
    // Step 1 no longer auto-advances once parsing finishes (DESIGN.md Track
    // B phase B14) -- the stat tiles fill in on the SAME screen, and moving
    // to step 2 is now an explicit click.
    await userEvent.click(screen.getByRole('button', { name: /next step/i }));
    await userEvent.click(screen.getByText(/survey/i));
    // Team Project is a Radix combobox+listbox now -- open then click the
    // option, same reasoning as ProjectPicker.test.tsx. Area path is still
    // a datalist-backed text input, so typing into it is correct.
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));
    await userEvent.type(await screen.findByLabelText(/area path/i), 'Project');
    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    await waitFor(() =>
      expect(jobsApi.submitJob).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'survey', areaPath: 'Project' }),
      ),
    );
  });

  it('does not render a "follow-up document" checkbox -- the near-duplicate check is now always performed, not opt-in', async () => {
    useAuthStore.getState().logout();
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({ blockCount: 20, sectionCount: 3, fileType: 'docx' });

    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() => expect(screen.getByText(/20/)).toBeInTheDocument());

    expect(screen.queryByLabelText(/follow-up document/i)).not.toBeInTheDocument();
  });

  it('shows an error toast instead of silently failing when previewJob rejects', async () => {
    // Regression: a transient backend failure (a redeploy mid-request, a
    // network blip) previously left the user stuck on step 1 with ZERO
    // feedback -- the promise rejected with no try/catch and no visible
    // signal, indistinguishable from the app simply refusing the upload.
    vi.spyOn(jobsApi, 'previewJob').mockRejectedValue(new Error('network error'));
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    // The same message now also appears in the dropzone's own error state
    // (DESIGN.md Track B phase B14), not only the toast -- getAllByText
    // tolerates that expected duplication.
    await waitFor(() => expect(screen.getAllByText(/failed to parse the uploaded file/i).length).toBeGreaterThan(0));
  });
});
