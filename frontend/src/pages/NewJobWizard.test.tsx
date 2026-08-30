import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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
    vi.spyOn(jobsApi, 'previewExposition').mockResolvedValue({ synopsis: 'A synopsis.', caveat: null });
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
    // SURVEY mode's step-2 button now advances to step 3 (Confirm
    // understanding) instead of submitting directly -- the actual
    // submission trigger lives there now.
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /looks right/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));

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

  it("handleFileSelected: a slower preview response for an earlier file selection cannot overwrite a faster later selection's already-shown preview", async () => {
    // Regression (SWEEP.md): handleFileSelected had no sequence guard, so
    // picking file A, then quickly replacing it with file B before A's
    // previewJob() resolved, let A's stale response overwrite B's
    // already-current preview if A resolved after B.
    let resolveA!: (result: Awaited<ReturnType<typeof jobsApi.previewJob>>) => void;
    const aPromise = new Promise<Awaited<ReturnType<typeof jobsApi.previewJob>>>((resolve) => {
      resolveA = resolve;
    });
    const bResult = {
      blockCount: 777, sectionCount: 3, figureCount: 888, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any;
    vi.spyOn(jobsApi, 'previewJob').mockImplementation((file) =>
      file.name === 'doc-a.docx' ? aPromise : Promise.resolve(bResult),
    );

    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );

    // Select file A first -- fires the slower, still-pending
    // previewJob('doc-a.docx') request.
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'doc-a.docx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /replace/i })).toBeInTheDocument());

    // Before A resolves, replace it with file B -- fires a second, faster
    // request that resolves and paints B's preview first.
    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['y'], 'doc-b.docx'));

    await waitFor(() => expect(screen.getByText('777')).toBeInTheDocument());
    expect(screen.getByText('888')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled();

    // Now let A's slower response resolve LAST -- it must not repaint B's
    // already-shown preview out from under it.
    await act(async () => {
      resolveA({
        blockCount: 111, sectionCount: 2, figureCount: 222, depth: 1, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
      } as any);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('777')).toBeInTheDocument();
    expect(screen.getByText('888')).toBeInTheDocument();
    expect(screen.queryByText('111')).not.toBeInTheDocument();
    expect(screen.queryByText('222')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled();
  });
});

describe('NewJobWizard Step 3 (Confirm understanding, SURVEY-only)', () => {
  async function uploadAndConfigureAsSurvey(): Promise<void> {
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
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByRole('radio', { name: /survey/i }));
  }

  it('BASELINE never shows step 3 -- Start job submits directly from step 2', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 1, figureCount: 0, depth: 1, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    const file = new File(['x'], 'req.docx');
    await userEvent.upload(screen.getByLabelText(/upload/i), file);
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    // BASELINE is the default mode -- no mode selection needed.
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');

    await userEvent.click(screen.getByRole('button', { name: /start job/i }));

    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline', documentOverview: undefined }));
    expect(screen.queryByText(/does this look right/i)).not.toBeInTheDocument();
  });

  it('SURVEY selection advances to step 3 and shows the generated synopsis', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition').mockResolvedValue({ synopsis: 'About a backplane.', caveat: null });
    await uploadAndConfigureAsSurvey();
    // Continue is gated the same way BASELINE's direct Start-job submit
    // always was (an area path is still required before advancing) --
    // matches the other scenarios in this block.
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText('About a backplane.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /looks right/i })).toBeInTheDocument();
  });

  it('"Looks right -- start job" submits with the generated documentOverview', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition').mockResolvedValue({ synopsis: 'About a backplane.', caveat: null });
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    await uploadAndConfigureAsSurvey();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('About a backplane.')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));

    expect(jobsApi.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'survey', documentOverview: { synopsis: 'About a backplane.', caveat: null } }),
    );
  });

  it('"Back to configure" returns to step 2 without losing the area path', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition').mockResolvedValue({ synopsis: 'About a backplane.', caveat: null });
    await uploadAndConfigureAsSurvey();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('About a backplane.')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));

    expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
  });

  it('re-fetches the exposition for a replaced file instead of submitting the previous file\'s stale synopsis (regression)', async () => {
    // Reachable sequence: reach step 3 with document A (synopsis generated,
    // expositionStatus becomes 'ready') -> Back to configure -> Back ->
    // Replace -> upload document B -> Configure -> Survey -> Continue.
    // Before the fix, handleReplace() left documentOverview/expositionStatus
    // untouched, so step 3's effect guard (`expositionStatus !== 'idle'`) saw
    // 'ready' from document A and never re-called previewExposition for
    // document B -- document A's stale synopsis rendered and got submitted
    // with document B's real job.
    vi.spyOn(jobsApi, 'previewJob')
      .mockResolvedValueOnce({
        blockCount: 10, sectionCount: 2, figureCount: 0, depth: 1, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
      } as any)
      .mockResolvedValueOnce({
        blockCount: 20, sectionCount: 4, figureCount: 0, depth: 1, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
      } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition')
      .mockResolvedValueOnce({ synopsis: 'About document A.', caveat: null })
      .mockResolvedValueOnce({ synopsis: 'About document B.', caveat: null });
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });

    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );

    // Upload document A, configure as SURVEY, advance to step 3.
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'doc-a.docx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByRole('radio', { name: /survey/i }));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('About document A.')).toBeInTheDocument());

    // Navigate back to step 1 (Back to configure -> Back), replace the
    // file, and upload document B.
    await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['y'], 'doc-b.docx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText('About document B.')).toBeInTheDocument());
    expect(screen.queryByText('About document A.')).not.toBeInTheDocument();
    expect(jobsApi.previewExposition).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    expect(jobsApi.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ documentOverview: { synopsis: 'About document B.', caveat: null } }),
    );
  });

  it('exposition failure still allows the job to be created', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition').mockRejectedValue(new Error('LLM unreachable'));
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    await uploadAndConfigureAsSurvey();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /start job|looks right/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /start job|looks right/i }));

    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ documentOverview: null }));
  });

  it('renders the fail-open error copy (not an empty card) when previewExposition resolves to null', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    // The server's own documented fail-open path: DocumentOverviewService.generate
    // returning null, which NestJS serializes to an empty body -- axios resolves
    // rather than rejects for this case, so previewExposition resolves to null here.
    vi.spyOn(jobsApi, 'previewExposition').mockResolvedValue(null);
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    await uploadAndConfigureAsSurvey();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/couldn't generate a summary/i)).toBeInTheDocument());

    const startButton = screen.getByRole('button', { name: /start job|looks right/i });
    await waitFor(() => expect(startButton).not.toBeDisabled());
    await userEvent.click(startButton);

    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ documentOverview: null }));
  });
});
