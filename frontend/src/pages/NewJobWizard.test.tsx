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
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 42, sectionCount: 5, figureCount: 3, depth: 4, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
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
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 42, sectionCount: 5, figureCount: 7, depth: 3, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
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
    // Size and section count now share one line -- DESIGN.md §11.1's file
    // identity row.
    expect(screen.getByText('2.0 KB · 5 sections')).toBeInTheDocument();
    expect(screen.getByText('Figures')).toBeInTheDocument();
    expect(screen.getByText('Depth')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    expect(screen.getByLabelText(/upload/i)).toBeInTheDocument();
    // Replace resets in place (no navigation needed -- we never left step
    // 1) and the document card is gone until a new file lands -- but the
    // stat tiles stay visible showing '--' placeholders (DESIGN.md §11.1:
    // "placeholders read as --, never as 0 or as absent"), not hidden.
    expect(screen.getByText('Figures')).toBeInTheDocument();
    expect(screen.queryByText('7')).not.toBeInTheDocument();
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });

  // DESIGN.md §11.1 -- the document map is the "honest answer to what did
  // it read," real per-section counts, not just the 4 aggregate tiles.
  it('renders one row per section in the document map, with real block/figure counts', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 42,
      sectionCount: 2,
      figureCount: 1,
      depth: 2,
      fileType: 'docx',
      tableCount: 0,
      openTbdCount: 0,
      documentMap: [
        { number: '1', title: 'Introduction', blockCount: 5, figureCount: 0 },
        { number: '1.1', title: 'Scope', blockCount: 12, figureCount: 1 },
      ],
    } as any);
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() => expect(screen.getByText('Introduction')).toBeInTheDocument());

    expect(screen.getByText('1.1')).toBeInTheDocument();
    expect(screen.getByText('Scope')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('shows the empty-state hint for "Worth knowing" before a file lands, never a blank card', () => {
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(screen.getByText('Drop a document and this fills with what the parser found in it.')).toBeInTheDocument();
  });

  it('shows real, derived "Worth knowing" notes for tables/figures/open TBDs -- never invented ones', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 42,
      sectionCount: 2,
      figureCount: 3,
      depth: 2,
      fileType: 'docx',
      tableCount: 2,
      openTbdCount: 1,
      documentMap: [],
    } as any);
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() => expect(screen.getByText(/2 tables detected/i)).toBeInTheDocument());
    expect(screen.getByText(/3 figures found/i)).toBeInTheDocument();
    expect(screen.getByText(/1 open TBD placeholder found/i)).toBeInTheDocument();
  });

  it('Step 2 submits with mode, area path, and optional state/iteration', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
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
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
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

  it('does not render a Customer ID field -- it is now a per-Requirement, document-derived attribute, never a job-level input', async () => {
    useAuthStore.getState().logout();
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);

    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() => expect(screen.getByText(/20/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await screen.findByLabelText(/area path/i);
    expect(screen.queryByLabelText(/customer id/i)).not.toBeInTheDocument();
  });

  it('does not render a "follow-up document" checkbox -- the near-duplicate check is now always performed, not opt-in', async () => {
    useAuthStore.getState().logout();
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);

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

  it('fetches both mode estimates once the document is parsed, and renders the server-provided range', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 682,
      sectionCount: 24,
      figureCount: 39,
      depth: 4,
      fileType: 'docx',
      tableCount: 0,
      openTbdCount: 0,
      documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'getEstimate').mockImplementation(async ({ mode }) =>
      mode === 'baseline'
        ? { mode: 'baseline', estimateMinutes: 1, lowerMinutes: 1, upperMinutes: 1, basis: 'bootstrap', sampleCount: 0, modelSampleCount: 0, modelAdjustment: 1, windowDays: 90 }
        : { mode: 'survey', estimateMinutes: 25, lowerMinutes: 20, upperMinutes: 30, basis: 'blended', sampleCount: 5, modelSampleCount: 5, modelAdjustment: 1, windowDays: 90 },
    );

    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() =>
      expect(jobsApi.getEstimate).toHaveBeenCalledWith(
        expect.objectContaining({ blockCount: 682, figureCount: 39, mode: 'baseline' }),
      ),
    );
    expect(jobsApi.getEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ blockCount: 682, figureCount: 39, mode: 'survey' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    // BASELINE is selected by default -- its flat 1-minute estimate (not a
    // range, since lower===upper) shows in the cost card, computed
    // server-side, not from a deleted local formula. "1 min" legitimately
    // appears twice now -- once inline on the mode card itself (so both
    // modes are comparable at a glance without switching selection), once
    // as the cost card's own big figure for whichever mode is selected.
    await waitFor(() => expect(screen.getAllByText('1 min').length).toBeGreaterThan(0));
    expect(screen.getByText(/typically, once it starts/i)).toBeInTheDocument();
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
