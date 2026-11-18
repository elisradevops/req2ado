import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { NewJobWizard } from './NewJobWizard';
import { ToastProvider } from '../components/ToastProvider';
import * as jobsApi from '../api/jobs';
import * as adoApi from '../api/ado';
import * as kbApi from '../api/kb';
import { useAuthStore } from '../store/authStore';
import { useNewJobDraftStore } from '../store/newJobDraftStore';

vi.mock('../api/jobs');
vi.mock('../api/ado');
vi.mock('../api/kb');

// The SURVEY configure step shows a KB readiness strip; give it a healthy KB
// by default so unrelated tests never hit the network or an undefined mock.
beforeEach(() => {
  localStorage.clear();
  useNewJobDraftStore.getState().reset();
  vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
  vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 });
});

describe('NewJobWizard Step 1', () => {
  it('does not fade the first step in on load (the route enter already covers it)', () => {
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(screen.getByTestId('wizard-step').className).not.toContain('fadeIn');
  });

  it('names the step in the page title and heading on load without taking focus', () => {
    document.title = 'req2ado';
    const { unmount } = render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(document.title).toBe('Step 1 of 3: Upload document - New job');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New job, step 1 of 3');
    expect(document.activeElement).toBe(document.body);
    unmount();
    expect(document.title).toBe('req2ado');
  });

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
    // the stepper's third circle also reads "3"; the stat tile value is the paragraph
    expect(screen.getByText('3', { selector: 'p' })).toBeInTheDocument();

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

  // P4: a deep section number ("1.2.1.1.1") ran into its title in the fixed-width column.
  it('gives a deep section number its own room instead of a fixed width, and keeps the full number and title on hover', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 3, sectionCount: 1, figureCount: 0, depth: 5, fileType: 'docx', tableCount: 0, openTbdCount: 0,
      documentMap: [{ number: '1.2.1.1.1', title: 'Ripple shall stay below 50 mV.', blockCount: 1, figureCount: 0 }],
    } as any);
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    const number = await screen.findByText('1.2.1.1.1');
    expect(number).not.toHaveClass('w-10');
    expect(number).toHaveClass('min-w-10', 'truncate');
    expect(number).toHaveAttribute('title', '1.2.1.1.1');
    expect(screen.getByText('Ripple shall stay below 50 mV.')).toHaveAttribute('title', 'Ripple shall stay below 50 mV.');
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
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['qwen2.5:1.5b'], recommended: null, details: [] });
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
    // exact text: the stepper's "SURVEY only" chip also matches /survey/i
    await userEvent.click(screen.getByText('SURVEY'));
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
    // The §0 line sits beside the primary action on step 1...
    expect(screen.getByText('Nothing reaches Azure DevOps until you approve the proposed diff.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    // ...and on step 2.
    expect(await screen.findByText('Nothing reaches Azure DevOps until you approve the proposed diff.')).toBeInTheDocument();
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

  it('shows the dropzone parsing state (not just empty tiles) while the file is being parsed, and the error state if it fails', async () => {
    let rejectParse!: (error: Error) => void;
    vi.spyOn(jobsApi, 'previewJob').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectParse = reject;
        }),
    );
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));

    expect(await screen.findByText(/parsing req\.docx/i)).toBeInTheDocument();
    expect(screen.getByText(/this fills in when it finishes/i)).toBeInTheDocument();

    await act(async () => {
      rejectParse(new Error('boom'));
      await Promise.resolve();
    });
    expect(await screen.findByText(/drop it again, or try a different file/i)).toBeInTheDocument();
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
    expect(await screen.findByText(/parsing doc-a\.docx/i)).toBeInTheDocument();

    // Before A resolves, re-select with file B through the still-active
    // dropzone -- fires a second, faster request that resolves and paints
    // B's preview first.
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

  it('SURVEY configure step shows the knowledge-base readiness strip; BASELINE does not', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([
      { id: 'a', userId: 'u', driveItemId: 'a', name: 'a.pdf', sizeBytes: 1, mimeType: null, docType: null, retrievalMode: null, ingestedAt: '2026-11-02T00:00:00Z', chunkCount: 32 },
    ]);
    await uploadAndConfigureAsSurvey();
    expect(await screen.findByText('1 file · 32 chunks')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /baseline/i }));
    expect(screen.queryByText('1 file · 32 chunks')).toBeNull();
  });

  describe('where duplicates are looked for', () => {
    async function toStepTwo(): Promise<void> {
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
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure/i }));
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    }

    it('searches the area path and everything under it by default, and does not send a scope', async () => {
      await toStepTwo();

      expect(screen.getByLabelText(/search for duplicates in/i)).toHaveTextContent(/this area path and everything under it/i);
      await userEvent.click(screen.getByRole('button', { name: /start job/i }));

      expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ dedupScope: undefined }));
    });

    it('can be widened to the whole project, and the job is submitted that way', async () => {
      await toStepTwo();

      await userEvent.click(screen.getByLabelText(/search for duplicates in/i));
      await userEvent.click(await screen.findByRole('option', { name: /the whole project/i }));
      await userEvent.click(screen.getByRole('button', { name: /start job/i }));

      expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ dedupScope: 'project' }));
    });

    it('explains what each choice means', async () => {
      await toStepTwo();

      expect(screen.getByLabelText(/search for duplicates in/i)).toBeInTheDocument();
      expect(screen.getByText(/items of the same kind \(epic, feature or requirement\) that already exist/i)).toBeInTheDocument();
    });
  });

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

  describe('keeps the draft when the user leaves for another page and comes back', () => {
    const PREVIEW = { blockCount: 3, sectionCount: 1, figureCount: 0, depth: 1, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [] } as any;
    function renderWithAwayRoute() {
      return render(
        <ToastProvider>
          <MemoryRouter initialEntries={['/jobs/new']}>
            <Routes>
              <Route path="/jobs/new" element={<><NewJobWizard /><Link to="/away">go away</Link></>} />
              <Route path="/away" element={<Link to="/jobs/new">come back</Link>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      );
    }
    const goAwayAndBack = async () => {
      await userEvent.click(screen.getByRole('link', { name: 'go away' }));
      await userEvent.click(screen.getByRole('link', { name: 'come back' }));
    };

    it('returns to the same step with the same mode, typed area path and parsed file, without parsing again', async () => {
      const previewJob = vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure/i }));
      await userEvent.click(screen.getByRole('radio', { name: /^SURVEY/ }));

      await goAwayAndBack();

      expect(screen.getByRole('radio', { name: /^SURVEY/ })).toBeChecked();
      expect(screen.queryByLabelText(/upload/i)).not.toBeInTheDocument(); // still on the configure step, not back at the dropzone
      expect(previewJob).toHaveBeenCalledTimes(1);
    });

    it('keeps the area path the user typed (the project-change reset must not wipe a restored value)', async () => {
      vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure/i }));
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');

      await goAwayAndBack();

      expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
    });

    it('starts fresh after a job was started, so the next visit is not a stale draft', async () => {
      vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
      vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure/i }));
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
      await userEvent.click(screen.getByRole('button', { name: /start job/i }));
      await waitFor(() => expect(jobsApi.submitJob).toHaveBeenCalled());

      await waitFor(() => expect(useNewJobDraftStore.getState().draft.file).toBeNull());
      expect(useNewJobDraftStore.getState().draft.step).toBe(1);
    });

    it('falls back to Default when the restored model is no longer offered', async () => {
      useNewJobDraftStore.getState().patch({ mode: 'survey', model: 'gone-model' });
      vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['still-here'], recommended: null, details: [] });
      renderWithAwayRoute();
      await waitFor(() => expect(jobsApi.listModels).toHaveBeenCalled());
      await waitFor(() => expect(useNewJobDraftStore.getState().draft.model).toBe(''));
    });

    it('keeps a restored model that is still offered', async () => {
      useNewJobDraftStore.getState().patch({ mode: 'survey', model: 'still-here' });
      vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['still-here'], recommended: null, details: [] });
      renderWithAwayRoute();
      await waitFor(() => expect(jobsApi.listModels).toHaveBeenCalled());
      await act(async () => {}); // let the listing resolve and its state updates apply
      expect(useNewJobDraftStore.getState().draft.model).toBe('still-here');
    });

    it('drops the file and the parse result when the user replaces the file', async () => {
      vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /replace/i }));

      expect(useNewJobDraftStore.getState().draft.file).toBeNull();
      expect(useNewJobDraftStore.getState().draft.preview).toBeNull();
    });

    it('does not restore a parse that was still running when the user left (its result can no longer arrive)', async () => {
      vi.spyOn(jobsApi, 'previewJob').mockReturnValue(new Promise(() => {}));
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));

      await goAwayAndBack();

      expect(screen.getByLabelText(/upload/i)).toBeInTheDocument(); // back at the dropzone, not stuck on "parsing"
      expect(screen.queryByText(/parsing/i)).not.toBeInTheDocument();
    });
  });

  // Step 3 shows the overview the preview already returned: made from the parsed text and structure, so it is there at once and nothing
  // is studied by a model while the user waits.
  const OVERVIEW = {
    synopsis: 'Purpose, quoted from §1.1 Scope: “About a backplane.” All of the above is taken from the document’s text and structure; no AI was used.',
    caveat: null,
    lines: ['Purpose, quoted from §1.1 Scope: “About a backplane.”', 'Unresolved values: TBD ×2 (3 Power).', 'All of the above is taken from the document’s text and structure; no AI was used.'],
    structureHint: 'How this document is built (context only): 6 sections.',
    profile: {},
  };
  describe('the knowledge-base statement on step 3', () => {
    it('says whether the run will be grounded, before the user starts a SURVEY job', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue(null);
      await openStep3({ ...OVERVIEW, profile: {} });
      await waitFor(() => expect(screen.getByText(/knowledge base is empty/i)).toBeInTheDocument());
    });
  });

  describe('the optional AI summary', () => {
    const withInput = { ...OVERVIEW, profile: { summaryInput: 'Sections: 1 Scope' } };

    it('shows the summary, labelled as written by a model from the headings and opening text, once it is ready, without blocking Start', async () => {
      let resolve!: (value: string | null) => void;
      vi.spyOn(jobsApi, 'previewSummary').mockReturnValue(new Promise((r) => { resolve = r; }));
      await openStep3(withInput);

      expect(screen.getByRole('button', { name: /looks right/i })).not.toBeDisabled(); // not waiting on it
      expect(screen.getByRole('status')).toHaveTextContent(/writing an ai summary/i);
      resolve('A backplane ICD covering power and thermal limits.');

      await waitFor(() => expect(screen.getByText('A backplane ICD covering power and thermal limits.')).toBeInTheDocument());
      expect(screen.getByText(/ai summary/i)).toBeInTheDocument();
      expect(screen.getByText(/check it against the file/i)).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(jobsApi.previewSummary).toHaveBeenCalledWith({ summaryInput: 'Sections: 1 Scope', model: undefined }, expect.any(AbortSignal));
    });

    it('takes the waiting note away when there is no summary and says so in one line, instead of just vanishing', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue(null);
      await openStep3(withInput);
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(screen.getByText('No AI summary this time. You can continue.')).toBeInTheDocument();
      expect(screen.queryByText(/written by a model/i)).not.toBeInTheDocument();
      expect(screen.getByText(/About a backplane/)).toBeInTheDocument();
    });

    it('says how long the wait can be and what starting now means, while it waits', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockReturnValue(new Promise(() => {}));
      await openStep3(withInput);
      expect(screen.getByRole('status')).toHaveTextContent(/up to about 90 seconds/i);
      expect(screen.getByRole('status')).toHaveTextContent(/start now.*without/i);
    });

    it('asks for no summary when the preview carries no input for one', async () => {
      const spy = vi.spyOn(jobsApi, 'previewSummary');
      await openStep3();
      expect(spy).not.toHaveBeenCalled();
    });

    it('cancels the request when the user leaves step 3', async () => {
      let signal: AbortSignal | undefined;
      vi.spyOn(jobsApi, 'previewSummary').mockImplementation((_params, s) => { signal = s; return new Promise(() => {}); });
      await openStep3(withInput);
      await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));
      expect(signal?.aborted).toBe(true);
    });

    it('gives up after 90 seconds and takes the waiting note away, instead of leaving it on screen for ever', async () => {
      // like the real client, a cancelled request resolves null
      vi.spyOn(jobsApi, 'previewSummary').mockImplementation((_params, signal) => new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null))));
      // the fake clock must exist before the wizard sets its give-up timer; it also runs in real time so the page stays usable
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await openStep3(withInput);
        expect(screen.getByRole('status')).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(91_000);
        });
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(screen.getByText('No AI summary this time. You can continue.')).toBeInTheDocument();
    });

    it('keeps a summary that arrived in time on screen after the 90 seconds have passed (the give-up timer must not outlive the result)', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue('A backplane ICD covering power and thermal limits.');
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await openStep3(withInput);
        await waitFor(() => expect(screen.getByText('A backplane ICD covering power and thermal limits.')).toBeInTheDocument());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
      } finally {
        vi.useRealTimers();
      }
      expect(screen.getByText('A backplane ICD covering power and thermal limits.')).toBeInTheDocument();
      expect(screen.queryByText('No AI summary this time. You can continue.')).not.toBeInTheDocument();
    });

    it('offers to write the summary again once it is ready, and asks the model a second time', async () => {
      const spy = vi.spyOn(jobsApi, 'previewSummary').mockResolvedValueOnce('First wording.').mockResolvedValueOnce('Second wording.');
      await openStep3(withInput);
      await waitFor(() => expect(screen.getByText('First wording.')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: /write it again/i }));

      await waitFor(() => expect(screen.getByText('Second wording.')).toBeInTheDocument());
      expect(screen.queryByText('First wording.')).not.toBeInTheDocument();
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('keeps the button on screen and focusable but inert while a summary is being written, so focus is not lost', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockReturnValue(new Promise(() => {}));
      await openStep3(withInput);
      const button = screen.getByRole('button', { name: /write it again/i });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(button);
      expect(jobsApi.previewSummary).toHaveBeenCalledTimes(1); // pressing it while writing asks nothing new
    });

    it('offers it after a failed attempt', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue(null);
      await openStep3(withInput);
      await waitFor(() => expect(screen.getByRole('button', { name: /write it again/i })).toBeInTheDocument());
    });

    it('submits a ready summary with the job, so the job page can show it; nothing when there is none', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue('A backplane ICD covering power and thermal limits.');
      vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
      await openStep3(withInput);
      await waitFor(() => expect(screen.getByText(/covering power and thermal/)).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
      expect(jobsApi.submitJob).toHaveBeenCalledWith(
        expect.objectContaining({ documentOverview: expect.objectContaining({ aiSummary: 'A backplane ICD covering power and thermal limits.' }) }),
      );
    });

    it('starts the job without a summary when it is not ready yet, and never waits for it', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockReturnValue(new Promise(() => {}));
      vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
      await openStep3(withInput);
      await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
      const sent = (jobsApi.submitJob as any).mock.calls[0][0].documentOverview;
      expect(sent).not.toHaveProperty('aiSummary');
    });
  });

  const previewWith = (overview: unknown) =>
    ({ blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [], ...(overview === null ? {} : { overview }) }) as any;

  async function openStep3(overview: unknown = OVERVIEW) {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(previewWith(overview));
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: [], recommended: null, details: [] });
    await uploadAndConfigureAsSurvey();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
  }

  it('SURVEY selection advances to step 3 and shows the overview lines at once, with no study of the document', async () => {
    await openStep3();

    expect(screen.getByText(/About a backplane/)).toBeInTheDocument();
    expect(screen.getByText(/Unresolved values: TBD ×2/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /looks right/i })).not.toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); // no spinner: nothing is being waited for
    expect((jobsApi as Record<string, unknown>).previewExposition).toBeUndefined();
  });

  it('says that what is shown was read from the file, not that an AI understood it, and labels the list as such', async () => {
    await openStep3();
    expect(screen.getByText(/check what was read from the file before it runs/i)).toBeInTheDocument();
    expect(screen.queryByText(/confirm the ai understood/i)).not.toBeInTheDocument();
    expect(screen.getByText('From the file’s text and structure')).toBeInTheDocument();
  });

  it('shows the first 5 overview lines and the rest on request, so Start stays near, and lines that repeat do not collide', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lines = [...Array.from({ length: 11 }, (_v, i) => `Line ${i + 1}.`), 'Line 1.'];
    await openStep3({ ...OVERVIEW, lines });
    expect(screen.getAllByText(/^Line \d+\.$/)).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: /show all 12 lines/i }));
    expect(screen.getAllByText(/^Line \d+\.$/)).toHaveLength(12);
    expect(error.mock.calls.filter((call) => String(call[0]).includes('same key'))).toEqual([]);
    error.mockRestore();
  });

  it('says on step 3, beside the Start button, that starting writes nothing', async () => {
    await openStep3();
    expect(screen.getByRole('button', { name: /looks right/i }).parentElement).toHaveTextContent(/nothing reaches azure devops until you approve the proposed diff/i);
  });

  it('shows the same three steps in BASELINE and SURVEY, with step 3 tagged SURVEY only in BASELINE', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 1, figureCount: 0, depth: 1, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    const states = () => Array.from(document.querySelectorAll('ol [data-state]')).map((node) => node.getAttribute('data-state'));
    expect(states()).toEqual(['awaiting', 'pending', 'pending']);
    expect(screen.getByText('SURVEY only')).toBeInTheDocument();
    // the chip of a step not yet reached is muted, not the accent chip
    expect(screen.getByText('SURVEY only')).toHaveClass('text-ink-3');

    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    expect(states()).toEqual(['done', 'awaiting', 'pending']);
    expect(screen.getByText('SURVEY only')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /survey/i }));
    expect(states()).toEqual(['done', 'awaiting', 'pending']);
    expect(screen.queryByText('SURVEY only')).toBeNull();
  });

  it('keeps the Start button in view: the action bar is sticky', async () => {
    await openStep3();
    const bar = screen.getByRole('button', { name: /looks right/i }).parentElement?.className ?? '';
    expect(bar).toMatch(/sticky/);
    // The same dock as the Write bar: its own surface, border and shadow above the content, so rows do not show through.
    expect(bar).toMatch(/z-10/);
    expect(bar).toMatch(/shadow-dock/);
    expect(bar).toMatch(/bg-surface/);
  });

  it('shows the structure caveat as a warning', async () => {
    await openStep3({ ...OVERVIEW, caveat: 'The heading structure is unusually deep.' });
    expect(screen.getByText(/unusually deep/)).toBeInTheDocument();
  });

  it('"Looks right -- start job" submits the overview and the structure hint for the AI stage (without the bulky profile)', async () => {
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    await openStep3();

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));

    expect(jobsApi.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'survey', documentOverview: { synopsis: OVERVIEW.synopsis, caveat: null, lines: OVERVIEW.lines, structureHint: OVERVIEW.structureHint } }),
    );
  });

  it('fades the step in when it changes, and keeps the same container so focus is not dropped', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(previewWith(OVERVIEW));
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: [], recommended: null, details: [] });
    await uploadAndConfigureAsSurvey();
    const step2Root = screen.getByTestId('wizard-step');

    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    const step3Root = screen.getByTestId('wizard-step');
    expect(step3Root).toBe(step2Root);
    expect(step3Root.className).toContain('fadeIn');
  });

  it('moves focus to the new step heading, which reads the step, and updates the page title', async () => {
    document.title = 'req2ado';
    await openStep3();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('New job, step 3 of 3');
    expect(heading).toHaveFocus();
    expect(document.title).toBe('Step 3 of 3: Confirm understanding - New job');

    await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    expect(document.title).toBe('Step 2 of 3: Configure & review - New job');
  });

  it('does not replay the fade when the person goes back to a step they have already seen', async () => {
    await openStep3();
    const root = screen.getByTestId('wizard-step');
    const remove = vi.spyOn(root.classList, 'remove');

    await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));

    expect(screen.getByTestId('wizard-step')).toBe(root);
    expect(remove).not.toHaveBeenCalled();
  });

  it('"Back to configure" returns to step 2 without losing the area path', async () => {
    await openStep3();

    await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));

    expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
  });

  it('a replaced file shows its own overview, never the previous file\'s (regression)', async () => {
    vi.spyOn(jobsApi, 'previewJob')
      .mockResolvedValueOnce(previewWith({ ...OVERVIEW, lines: ['Purpose, quoted from §1 Scope: “About document A.”', OVERVIEW.lines[2]] }))
      .mockResolvedValueOnce(previewWith({ ...OVERVIEW, lines: ['Purpose, quoted from §1 Scope: “About document B.”', OVERVIEW.lines[2]] }));
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: [], recommended: null, details: [] });
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });

    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );

    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'doc-a.docx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByRole('radio', { name: /survey/i }));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/About document A/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['y'], 'doc-b.docx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/About document B/)).toBeInTheDocument());
    expect(screen.queryByText(/About document A/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    expect(jobsApi.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ documentOverview: expect.objectContaining({ lines: [expect.stringContaining('About document B'), OVERVIEW.lines[2]] }) }),
    );
  });

  it('a server that returns no overview still lets the job be created, and says there is none', async () => {
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    await openStep3(null); // no overview in the preview

    expect(screen.getByText(/no overview available/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /start job|looks right/i }));

    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ documentOverview: null }));
  });
});

describe('NewJobWizard step 2 layout (DESIGN.md §11.2.5)', () => {
  const ESTIMATES = (nearSizeSampleCount?: number): void => {
    vi.spyOn(jobsApi, 'getEstimate').mockImplementation(async ({ mode }) =>
      mode === 'baseline'
        ? ({ mode: 'baseline', estimateMinutes: 1, lowerMinutes: 1, upperMinutes: 1, basis: 'bootstrap', sampleCount: 0, modelSampleCount: 0, modelAdjustment: 1, windowDays: 90 } as any)
        : ({ mode: 'survey', estimateMinutes: 25, lowerMinutes: 20, upperMinutes: 30, basis: 'blended', sampleCount: 5, modelSampleCount: 5, modelAdjustment: 1, windowDays: 90, ...(nearSizeSampleCount === undefined ? {} : { nearSizeSampleCount }) } as any),
    );
  };

  async function reachStep2(nearSizeSampleCount?: number): Promise<void> {
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['qwen2.5:1.5b'], recommended: null, details: [] });
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 682, sectionCount: 24, figureCount: 39, depth: 4, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    ESTIMATES(nearSizeSampleCount);
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'AirPro_ICD.docx'));
    await userEvent.click(await screen.findByRole('button', { name: /configure/i }));
    await screen.findByText(/typically, once it starts/i);
  }

  it('does not tell a BASELINE user that its estimate is still learning: BASELINE is a flat figure that never changes', async () => {
    await reachStep2();
    await userEvent.click(screen.getByRole('radio', { name: /baseline/i }));
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(rail).toHaveTextContent('BASELINE');
    expect(rail).not.toHaveTextContent(/no completed runs yet/i);
    expect(rail).not.toHaveTextContent(/feeds the fit|sharpens on its own|conservative default/i);
  });

  it('says so when no finished SURVEY run is near the document\'s size', async () => {
    await reachStep2(0);
    await userEvent.click(screen.getByRole('radio', { name: /survey/i }));
    expect(screen.getByText(/no finished survey run is near this document's size/i)).toBeInTheDocument();
  });

  it('does not say it when a finished SURVEY run is near the document\'s size', async () => {
    await reachStep2(3);
    await userEvent.click(screen.getByRole('radio', { name: /survey/i }));
    expect(screen.queryByText(/no finished survey run is near this document's size/i)).not.toBeInTheDocument();
  });

  it('shows the uploaded document in the summary rail, with its counts', async () => {
    await reachStep2();
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(rail).toHaveTextContent('AirPro_ICD.docx');
    expect(rail).toHaveTextContent('682 blocks');
    expect(rail).toHaveTextContent('24 sections');
    expect(rail).toHaveTextContent('39 figures');
  });

  it('puts the question on the canvas, so the mode cards are the only cards (DESIGN.md §16.15, §11.2.5)', async () => {
    await reachStep2();
    expect(screen.getByRole('heading', { level: 2, name: 'How should it read the document?' })).toBeInTheDocument();
    const modes = screen.getByRole('radiogroup', { name: 'Analysis mode' });
    // no card around the mode cards: neither a Card ancestor nor a card-shaped wrapper
    expect(modes.closest('.shadow-card')).toBeNull();
  });

  it('lets you change the document from the rail, which goes back to step 1', async () => {
    await reachStep2();
    await userEvent.click(screen.getByRole('button', { name: /change document/i }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('New job, step 1 of 3');
  });

  it('keeps the primary action and the safety line together in the rail', async () => {
    await reachStep2();
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(rail).toContainElement(screen.getByRole('button', { name: /^start job$/i }));
    expect(rail).toHaveTextContent('Nothing reaches Azure DevOps until you approve the proposed diff.');
  });

  it('folds iteration, state and duplicate scope under a closed "More options" that reads their values back', async () => {
    await reachStep2();
    const summary = screen.getByText('More options').closest('summary') as HTMLElement;
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(summary).toHaveTextContent('Iteration: project default');
    expect(summary).toHaveTextContent('State: default');
    expect(summary).toHaveTextContent('Duplicates: this area path and below');
    expect(details).toHaveTextContent('Search for duplicates in');
  });

  it('gives the estimate one home beside the mode cards: no separate cost card and no warning alert for SURVEY', async () => {
    await reachStep2();
    await userEvent.click(screen.getByRole('radio', { name: /survey/i }));
    expect(screen.queryByText('What will it cost you?')).not.toBeInTheDocument();
    expect(screen.queryByText(/SURVEY mode scales with document size/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/typically, once it starts/i)).toHaveLength(1);
  });

  it('says in the rail why the primary action is disabled, because the destination it needs can be below the fold', async () => {
    await reachStep2();
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(screen.getByRole('button', { name: /^start job$/i })).toBeDisabled();
    expect(rail).toHaveTextContent('Choose an area path to continue.');
  });

  it('drops that reason once the destination is filled in', async () => {
    await reachStep2();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area');
    expect(screen.getByRole('button', { name: /^start job$/i })).toBeEnabled();
    expect(screen.queryByText(/to continue\./i)).not.toBeInTheDocument();
  });
});

describe('NewJobWizard step 1: a document with no headings (DESIGN.md §11.1)', () => {
  async function uploadWith(preview: Record<string, unknown>): Promise<void> {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 2, sectionCount: 0, figureCount: 0, depth: 0, fileType: 'txt', tableCount: 0, openTbdCount: 0, documentMap: [], ...preview,
    } as any);
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'notes.txt'));
  }

  it('says so, instead of "nothing unusual", and what BASELINE does with it', async () => {
    await uploadWith({});
    expect(await screen.findByText(/no headings found/i)).toBeInTheDocument();
    // What the leveler does: clause numbering gives structure where the text has it; only with none is everything one Epic and one Feature.
    expect(screen.getByText(/uses clause numbering/i)).toBeInTheDocument();
    expect(screen.getByText(/with none, it groups everything under one Epic and one Feature/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing unusual found/i)).not.toBeInTheDocument();
  });

  it('says nothing about headings when the document has them', async () => {
    await uploadWith({ sectionCount: 4, blockCount: 30 });
    expect(await screen.findByText(/nothing unusual found/i)).toBeInTheDocument();
    expect(screen.queryByText(/no headings found/i)).not.toBeInTheDocument();
  });
});


describe('NewJobWizard: remembers the last job\'s mode and destination (J2)', () => {
  function mockApis() {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-77' });
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['qwen2.5:1.5b'], recommended: null, details: [] });
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([{ id: '1', name: 'Project' }]);
    vi.spyOn(adoApi, 'getAreaPaths').mockResolvedValue({ path: 'Project', children: [] });
    vi.spyOn(adoApi, 'getIterationPaths').mockResolvedValue({ path: 'Project', children: [] });
    vi.spyOn(adoApi, 'getStates').mockResolvedValue(['Proposed', 'Active']);
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
  }
  const renderWizard = () =>
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
  async function uploadAndConfigure() {
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() => expect(screen.getByText(/20/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
  }

  it('saves the mode, project and area path once a job has started, under the signed-in user', async () => {
    mockApis();
    renderWizard();
    await uploadAndConfigure();
    await userEvent.click(screen.getByText('SURVEY'));
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));
    await userEvent.type(await screen.findByLabelText(/area path/i), 'Project');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /looks right/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    await waitFor(() => expect(jobsApi.submitJob).toHaveBeenCalled());

    expect(JSON.parse(localStorage.getItem('req2ado-last-job:user-descriptor-1') ?? 'null')).toEqual({
      mode: 'survey', project: 'Project', areaPath: 'Project',
    });
  });

  it('starts the next job from them: mode selected and destination filled, nothing re-picked', async () => {
    mockApis();
    localStorage.setItem('req2ado-last-job:user-descriptor-1', JSON.stringify({ mode: 'survey', project: 'Project', areaPath: 'Project\\Customer Requirements' }));
    renderWizard();
    await uploadAndConfigure();
    expect(screen.getByRole('radio', { name: /SURVEY/ })).toBeChecked();
    expect(screen.getByLabelText(/team project/i)).toHaveValue('Project');
    expect(await screen.findByLabelText(/area path/i)).toHaveValue('Project\\Customer Requirements');
  });

  it('picking a team project fills that project\'s own last area path and mode (B6), and keeps a mode the user chose', async () => {
    mockApis();
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([{ id: '1', name: 'Project' }, { id: '2', name: 'Other' }]);
    localStorage.setItem('req2ado-last-job-by-project:user-descriptor-1', JSON.stringify({
      Project: { mode: 'survey', areaPath: 'Project\\Customer Requirements' },
      Other: { mode: 'baseline', areaPath: 'Other\\Imports' },
    }));
    renderWizard();
    await uploadAndConfigure();

    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));
    expect(await screen.findByLabelText(/area path/i)).toHaveValue('Project\\Customer Requirements');
    expect(screen.getByRole('radio', { name: /SURVEY/ })).toBeChecked();

    // Now the user chooses the mode; another project's remembered mode does not replace it, but its area path is offered.
    await userEvent.click(screen.getByRole('radio', { name: /BASELINE/ }));
    await userEvent.click(screen.getByRole('radio', { name: /SURVEY/ }));
    await userEvent.clear(screen.getByLabelText(/team project/i));
    await userEvent.type(screen.getByLabelText(/team project/i), 'Other');
    await waitFor(() => expect(screen.getByLabelText(/area path/i)).toHaveValue('Other\\Imports'));
    expect(screen.getByRole('radio', { name: /SURVEY/ })).toBeChecked();
  });

  it('does not start from another user\'s choices', async () => {
    mockApis();
    localStorage.setItem('req2ado-last-job:someone-else', JSON.stringify({ mode: 'survey', project: 'Project', areaPath: 'Project\\X' }));
    renderWizard();
    await uploadAndConfigure();
    expect(screen.getByRole('radio', { name: /BASELINE/ })).toBeChecked();
  });
});

describe('NewJobWizard step 2: the rail does not claim a destination the form has not got (review #8)', () => {
  it('says the destination is not chosen yet while only the project is picked, and shows it once the area path is set', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, figureCount: 0, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['qwen2.5:1.5b'], recommended: null, details: [] });
    vi.spyOn(adoApi, 'getProjects').mockResolvedValue([{ id: '1', name: 'Project' }]);
    vi.spyOn(adoApi, 'getAreaPaths').mockResolvedValue({ path: 'Project', children: [] });
    vi.spyOn(adoApi, 'getIterationPaths').mockResolvedValue({ path: 'Project', children: [] });
    vi.spyOn(adoApi, 'getStates').mockResolvedValue(['Proposed']);
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
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));

    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(within(rail).getByText('Not chosen yet')).toBeInTheDocument();
    expect(screen.getByText(/choose an area path to continue/i)).toBeInTheDocument();

    await userEvent.type(await screen.findByLabelText(/area path/i), 'Project');
    expect(within(rail).queryByText('Not chosen yet')).not.toBeInTheDocument();
  });
});

describe('NewJobWizard step 3 keeps the "This run" rail beside Start (J4, owner decision 2026-11-12)', () => {
  it('shows the file, the mode and where it lands next to the start button', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, figureCount: 0, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-5' });
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['qwen2.5:1.5b'], recommended: null, details: [] });
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
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByText('SURVEY'));
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));
    await userEvent.type(await screen.findByLabelText(/area path/i), 'Project');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /looks right/i })).toBeInTheDocument());

    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(within(rail).getByText('req.docx')).toBeInTheDocument();
    expect(within(rail).getByText(/SURVEY/)).toBeInTheDocument();
    expect(within(rail).getByText(/Project/)).toBeInTheDocument();
    // The step's own actions stay in the main column, not the rail.
    expect(within(rail).queryByRole('button', { name: /looks right/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /looks right/i })).toBeInTheDocument();
    // On a phone the rail comes after the action bar, so the bar says where it lands itself (hidden from lg up, where the rail is beside it).
    const start = screen.getByRole('button', { name: /looks right/i });
    const bar = start.parentElement as HTMLElement;
    expect(within(bar).getByText(/^Lands in /)).toHaveClass('lg:hidden');
    expect(within(bar).getByText(/^Lands in /)).toHaveTextContent('Project');
  });
});

describe('NewJobWizard step 1: a file with a name that was processed before (J3)', () => {
  async function uploadNamed(name: string, jobs: unknown): Promise<void> {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 12, sectionCount: 3, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue(jobs as any);
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], name));
  }
  const earlier = (id: string, name: string, createdAt: string, status = 'diff_ready') => ({
    id, mode: 'survey', status, areaPath: 'P\\A', originalFilename: name, itemCount: 5, createdItemCount: 0, createdAt,
  });

  it('says a file with this name was already run, with the job, its state and when, and does not block anything', async () => {
    const recent = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    await uploadNamed('spec.docx', [earlier('4270e8be-1979-4cd3-94ea-a0a0d5ef6ed0', 'spec.docx', recent), earlier('zzzzzzzz-2', 'spec.docx', '2026-10-01T00:00:00Z')]);
    const note = await screen.findByText(/already ran a file with this name/i);
    expect(note.closest('div')).toHaveTextContent('4270e8be');
    expect(note.closest('div')).toHaveTextContent('Diff ready');
    expect(note.closest('div')).toHaveTextContent('1 other time');
    expect(screen.getByRole('link', { name: /4270e8be/ })).toHaveAttribute('href', '/jobs/4270e8be-1979-4cd3-94ea-a0a0d5ef6ed0');
    expect(screen.getByRole('button', { name: /configure/i })).toBeEnabled();
  });

  it('says nothing for a new file name', async () => {
    await uploadNamed('fresh.docx', [earlier('4270e8be-1', 'spec.docx', '2026-11-12T00:00:00Z')]);
    await screen.findByText(/straightforward parse|detected|found/i);
    expect(screen.queryByText(/already ran a file with this name/i)).not.toBeInTheDocument();
  });

  it('carries on without the note when the job list cannot be read', async () => {
    await uploadNamed('spec.docx', undefined);
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).toBeEnabled());
    expect(screen.queryByText(/already ran a file with this name/i)).not.toBeInTheDocument();
  });
});

describe('NewJobWizard re-run of a file (P5)', () => {
  const HASH = 'f'.repeat(64);
  const earlier = { id: '4270e8be-1979-4cd3-94ea-a0a0d5ef6ed0', mode: 'survey', status: 'diff_ready', areaPath: 'P\\A', originalFilename: 'spec.docx', itemCount: 5, createdItemCount: 0, createdAt: new Date(Date.now() - 3600 * 1000).toISOString() };
  async function toStep2(cached: boolean): Promise<void> {
    useAuthStore.getState().logout(); // free-text area path: no ADO pickers to drive
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [], fileHash: HASH,
      overview: { synopsis: 'A spec.', caveat: null, profile: { summaryInput: 'Sections: 1 Scope' } },
    } as any);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([earlier] as any);
    vi.spyOn(jobsApi, 'getEstimate').mockResolvedValue({ mode: 'survey', lowerMinutes: 20, upperMinutes: 35, basis: 'blended', sampleCount: 4 } as any);
    vi.spyOn(jobsApi, 'getCachedResult').mockResolvedValue(cached);
    vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue(null);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['m1'], recommended: null, details: [] });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'spec.docx'));
    await screen.findByText(/already ran a file with this name/i);
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByText('SURVEY'));
  }

  it('keeps the "already ran a file with this name" note on steps 2 and 3 as one compact line', async () => {
    await toStep2(false);
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(within(rail).getByText(/already ran a file with this name/i)).toBeInTheDocument();
    expect(within(rail).getByRole('link', { name: /4270e8be/ })).toHaveAttribute('href', '/jobs/4270e8be-1979-4cd3-94ea-a0a0d5ef6ed0');
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByRole('button', { name: /looks right/i });
    const rail3 = screen.getByRole('complementary', { name: 'This run' });
    expect(within(rail3).getByText(/already ran a file with this name/i)).toBeInTheDocument();
  });

  it('says a few seconds when a SURVEY job of this file would come from the result cache', async () => {
    await toStep2(true);
    await waitFor(() => expect(jobsApi.getCachedResult).toHaveBeenCalledWith({ fileHash: HASH, mode: 'survey', model: undefined }, expect.anything()));
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(await within(rail).findByText('A few seconds')).toBeInTheDocument();
    expect(within(rail).getByText('this file was already processed')).toBeInTheDocument();
    expect(within(rail).queryByText('typically, once it starts')).not.toBeInTheDocument();
  });

  it('shows one estimate for a cached file: the card and the side panel agree, and no sample size is quoted', async () => {
    await toStep2(true);
    const rail = screen.getByRole('complementary', { name: 'This run' });
    await within(rail).findByText('A few seconds');
    const card = screen.getByRole('radio', { name: /SURVEY/ });
    expect(card).toHaveTextContent('A few seconds');
    expect(card).not.toHaveTextContent('20 min');
    expect(within(rail).queryByText(/n=\d/)).not.toBeInTheDocument();
  });

  it('keeps the measured range when the file is not in the cache', async () => {
    await toStep2(false);
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(await within(rail).findByText('20 min – 35 min')).toBeInTheDocument();
    expect(within(rail).queryByText('A few seconds')).not.toBeInTheDocument();
  });

  it('asks the model afresh on "Write it again", and lets the server answer from its cache the first time', async () => {
    await toStep2(false);
    vi.mocked(jobsApi.previewSummary).mockResolvedValue('A summary of the file.');
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText('A summary of the file.');
    expect(vi.mocked(jobsApi.previewSummary).mock.calls[0][0]).not.toHaveProperty('fresh');
    await userEvent.click(screen.getByRole('button', { name: /write it again/i }));
    await waitFor(() => expect(vi.mocked(jobsApi.previewSummary).mock.calls.length).toBe(2));
    expect(vi.mocked(jobsApi.previewSummary).mock.calls[1][0]).toMatchObject({ fresh: true });
  });
});

describe('NewJobWizard token forecast', () => {
  const HASH = 'a'.repeat(64);
  const forecast = (over: Record<string, unknown> = {}) => ({
    documentTokens: 100_000,
    inputTokens: { low: 600_000, likely: 1_100_000, high: 1_500_000 },
    outputTokens: { low: 90_000, likely: 297_000, high: 600_000 },
    requiresConfirmation: false,
    ...over,
  });

  async function toStep3(tokens: unknown, cached = false): Promise<void> {
    useAuthStore.getState().logout(); // free-text area path: no ADO pickers to drive
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [], fileHash: HASH,
      documentTokens: 100_000, overview: { synopsis: 'A spec.', caveat: null, profile: { summaryInput: 'Sections: 1 Scope' } },
    } as any);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getEstimate').mockImplementation(
      async ({ mode }) => ({ mode, lowerMinutes: 20, upperMinutes: 35, basis: 'blended', sampleCount: 4, ...(mode === 'survey' && tokens ? { tokens } : {}) }) as any,
    );
    vi.spyOn(jobsApi, 'getCachedResult').mockResolvedValue(cached);
    vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue(null);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['m1'], recommended: null, details: [] });
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' } as any);
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'spec.docx'));
    await userEvent.click(await screen.findByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByText('SURVEY'));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByRole('button', { name: /looks right/i });
  }

  it('asks the server for the forecast with the document size', async () => {
    await toStep3(forecast());
    expect(jobsApi.getEstimate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'survey', documentTokens: 100_000 }));
  });

  it('shows the token range beside the time estimate, with no money unless the server priced it', async () => {
    await toStep3(forecast());
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(await within(rail).findByText('690k – 2.1M tokens')).toBeInTheDocument();
    expect(within(rail).getByText('rough forecast of model use')).toBeInTheDocument();
  });

  it('shows the cost range when the server priced it', async () => {
    await toStep3(forecast({ costUsd: { low: 4.2, high: 18 } }));
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(await within(rail).findByText('690k – 2.1M tokens · $4.20 – $18')).toBeInTheDocument();
  });

  it('starts at once when the forecast is below the threshold', async () => {
    await toStep3(forecast({ requiresConfirmation: false }));
    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    await waitFor(() => expect(jobsApi.submitJob).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Start a large run?')).not.toBeInTheDocument();
  });

  it('asks first when the forecast is above the threshold, starts only on confirmation, and not at all on cancel', async () => {
    await toStep3(forecast({ requiresConfirmation: true, costUsd: { low: 4.2, high: 18 } }));

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Start a large run?')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('690k – 2.1M model tokens ($4.20 – $18)');
    expect(jobsApi.submitJob).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jobsApi.submitJob).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start job' }));
    await waitFor(() => expect(jobsApi.submitJob).toHaveBeenCalledTimes(1));
  });

  it('shows no forecast and never asks for a file the result cache would serve, which spends no tokens', async () => {
    await toStep3(forecast({ requiresConfirmation: true }), true);
    const rail = screen.getByRole('complementary', { name: 'This run' });
    await within(rail).findByText('A few seconds');
    expect(within(rail).queryByText(/tokens/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    await waitFor(() => expect(jobsApi.submitJob).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Start a large run?')).not.toBeInTheDocument();
  });
});

