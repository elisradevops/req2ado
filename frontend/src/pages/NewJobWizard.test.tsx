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
// BASELINE starts the job from step 2 ("Check and start"), once the file's conventions have been read there; SURVEY from step 3.
async function startBaselineJob(): Promise<void> {
  expect(screen.queryByRole('button', { name: /^continue$/i })).not.toBeInTheDocument();
  const start = await screen.findByRole('button', { name: /looks right/i });
  await waitFor(() => expect(start).not.toBeDisabled());
  await userEvent.click(start);
}

beforeEach(() => {
  localStorage.clear();
  useNewJobDraftStore.getState().reset();
  vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
  vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 });
  // By default the job reads no Study (as for a user with no model connection), so Start behaves as it did before the Study step.
  vi.spyOn(jobsApi, 'previewStudy').mockResolvedValue({ kind: 'skipped' });
  // By default the file study answers with rules but no reading (as for a spreadsheet, or a rulebook stored before readings were kept), so a
  // test about something else starts from a finished study: a failed study holds Start (owner decision, 2026-11-25).
  vi.spyOn(jobsApi, 'previewRules').mockResolvedValue({
    id: 'rb-default', source: 'model', hash: 'h-default', rules: [], warnings: [], rulebook: {}, reused: false, skipped: null, details: null,
  } as never);
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
    // BASELINE (the default) has two steps.
    expect(document.title).toBe('Step 1 of 2: Upload document - New job');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New job, step 1 of 2');
    expect(document.activeElement).toBe(document.body);
    unmount();
    expect(document.title).toBe('req2ado');
  });

  it('counts two steps for a With AI review draft too: one page after the upload in both modes', () => {
    useNewJobDraftStore.getState().patch({ mode: 'survey' });
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: [], recommended: null, details: [] });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(document.title).toBe('Step 1 of 2: Upload document - New job');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New job, step 1 of 2');
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

  it('shows the document identity card (filename + size) and the Figures/Heading levels stat tiles', async () => {
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
    expect(screen.getByText('Heading levels')).toBeInTheDocument();
    expect(screen.getByText('Text blocks')).toBeInTheDocument();
    expect(screen.queryByText('Depth')).not.toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    // exact text: the stepper's "SURVEY only" chip also matches /survey/i
    await userEvent.click(screen.getByText('With AI review'));
    // Team Project is a Radix combobox+listbox now -- open then click the
    // option, same reasoning as ProjectPicker.test.tsx. Area path is still
    // a datalist-backed text input, so typing into it is correct.
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));
    await userEvent.type(await screen.findByLabelText(/area path/i), 'Project');
    // One page in both modes (owner decision, 2026-11-25): Start is on step 2.
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
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
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
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
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
    expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled();

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
    expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled();
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
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
  }

  it('SURVEY configure step shows the knowledge-base readiness strip; BASELINE does not', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([
      { id: 'a', userId: 'u', driveItemId: 'a', name: 'a.pdf', sizeBytes: 1, mimeType: null, docType: null, retrievalMode: null, ingestedAt: '2026-11-02T00:00:00Z', chunkCount: 32 },
    ]);
    await uploadAndConfigureAsSurvey();
    expect(await screen.findByText('1 file · 32 chunks')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /Standard/i }));
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
      await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    }

    it('searches the area path and everything under it by default, and does not send a scope', async () => {
      await toStepTwo();

      expect(screen.getByLabelText(/search for duplicates in/i)).toHaveTextContent(/this area path and everything under it/i);
      await startBaselineJob();

      expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ dedupScope: undefined }));
    });

    it('can be widened to the whole project, and the job is submitted that way', async () => {
      await toStepTwo();

      await userEvent.click(screen.getByLabelText(/search for duplicates in/i));
      await userEvent.click(await screen.findByRole('option', { name: /the whole project/i }));
      await startBaselineJob();

      expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ dedupScope: 'project' }));
    });

    it('explains what each choice means', async () => {
      await toStepTwo();

      expect(screen.getByLabelText(/search for duplicates in/i)).toBeInTheDocument();
      expect(screen.getByText(/items of the same kind \(epic, feature or requirement\) that already exist/i)).toBeInTheDocument();
    });
  });

  it('BASELINE starts from step 2 ("Check and start"), with the overview and the file\'s reading but no AI summary or knowledge-base strip', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 1, figureCount: 0, depth: 1, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
      overview: { ...OVERVIEW, profile: { summaryInput: 'Sections: 1 Scope' } },
    } as any);
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue('A summary.');
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    const file = new File(['x'], 'req.docx');
    await userEvent.upload(screen.getByLabelText(/upload/i), file);
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    // BASELINE is the default mode -- no mode selection needed.
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    expect(screen.queryByRole('button', { name: /^continue$/i })).not.toBeInTheDocument(); // one page: nothing to continue to
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New job, step 2 of 2');
    expect(screen.getByText(/this file and how it will be read/i)).toBeInTheDocument();
    expect(screen.getByTestId('file-reading-card')).toBeInTheDocument();
    expect(screen.getByText(/About a backplane/)).toBeInTheDocument();
    expect(screen.queryByText(/your knowledge base/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /write it again/i })).not.toBeInTheDocument();
    expect(jobsApi.previewSummary).not.toHaveBeenCalled();
    const start = await screen.findByRole('button', { name: /looks right/i });
    await waitFor(() => expect(start).not.toBeDisabled());
    await userEvent.click(start);

    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline', documentOverview: undefined, model: undefined }));
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
      await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
      await userEvent.click(screen.getByRole('radio', { name: /^With AI review/ }));

      await goAwayAndBack();

      expect(screen.getByRole('radio', { name: /^With AI review/ })).toBeChecked();
      expect(screen.queryByLabelText(/upload/i)).not.toBeInTheDocument(); // still on the configure step, not back at the dropzone
      expect(previewJob).toHaveBeenCalledTimes(1);
    });

    it('keeps the area path the user typed (the project-change reset must not wipe a restored value)', async () => {
      vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');

      await goAwayAndBack();

      expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
    });

    it('starts fresh after a job was started, so the next visit is not a stale draft', async () => {
      vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
      vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
      await startBaselineJob();
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
      await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
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

    it('cancels the request when the user leaves the page for the upload', async () => {
      let signal: AbortSignal | undefined;
      vi.spyOn(jobsApi, 'previewSummary').mockImplementation((_params, s) => { signal = s; return new Promise(() => {}); });
      await openStep3(withInput);
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
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

  it('shows two steps in both modes, with no mode tag; switching mode on step 2 keeps the same page (owner decision, 2026-11-25)', async () => {
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
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
    const states = () => Array.from(document.querySelectorAll('ol [data-state]')).map((node) => node.getAttribute('data-state'));
    const stepList = () => document.querySelector('ol') as HTMLElement;
    expect(states()).toEqual(['awaiting', 'pending']);
    expect(stepList()).toHaveTextContent('Check and start');
    expect(screen.queryByText('SURVEY only')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    expect(states()).toEqual(['done', 'awaiting']);
    expect(screen.queryByText('SURVEY only')).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    expect(states()).toEqual(['done', 'awaiting']);
    expect(stepList()).toHaveTextContent('Check and start');
    expect(screen.queryByText('SURVEY only')).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: /Standard/i }));
    expect(states()).toEqual(['done', 'awaiting']);
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

    const step3Root = screen.getByTestId('wizard-step');
    expect(step3Root).toBe(step2Root);
    expect(step3Root.className).toContain('fadeIn');
  });

  it('moves focus to the new step heading, which reads the step, and updates the page title', async () => {
    document.title = 'req2ado';
    useNewJobDraftStore.getState().patch({ mode: 'survey' });
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(previewWith(OVERVIEW));
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: [], recommended: null, details: [] });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('New job, step 2 of 2');
    expect(heading).toHaveFocus();
    expect(document.title).toBe('Step 2 of 2: Check and start - New job');
  });

  it('does not replay the fade when the person goes back to a step they have already seen', async () => {
    await openStep3();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    const root = screen.getByTestId('wizard-step');
    const remove = vi.spyOn(root.classList, 'remove');

    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));

    expect(remove).not.toHaveBeenCalled();
  });

  it('"Back" returns to the upload, and coming back keeps the area path', async () => {
    await openStep3();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));

    expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
  });

  describe('BASELINE: configuration and the check of what was read are one page, "Check and start"', () => {
    async function openCheckAndStart(): Promise<void> {
      vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(previewWith(OVERVIEW));
      vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: [], recommended: null, details: [] });
      render(
        <ToastProvider>
          <MemoryRouter>
            <NewJobWizard />
          </MemoryRouter>
        </ToastProvider>,
      );
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    }

    it('moves focus to the heading of step 2 of 2 and names it in the page title', async () => {
      document.title = 'req2ado';
      await openCheckAndStart();
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toHaveTextContent('New job, step 2 of 2');
      expect(heading).toHaveFocus();
      expect(document.title).toBe('Step 2 of 2: Check and start - New job');
    });

    it('shows the mode cards, the destination, the overview and the reading of the file, with Start in the sticky bar and not in the rail', async () => {
      await openCheckAndStart();
      expect(screen.getByRole('radiogroup', { name: 'Analysis mode' })).toBeInTheDocument();
      expect(screen.getByText(/About a backplane/)).toBeInTheDocument();
      expect(screen.getByTestId('file-reading-card')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /back to configure/i })).not.toBeInTheDocument();
      const start = screen.getByRole('button', { name: /start job|reading the file/i });
      const bar = start.parentElement as HTMLElement;
      expect(bar.className).toMatch(/sticky/);
      expect(bar).toHaveTextContent('Nothing reaches Azure DevOps until you approve the proposed diff.');
      expect(within(bar).getByRole('button', { name: 'Back' })).toBeInTheDocument();
      const rail = screen.getByRole('complementary', { name: 'This run' });
      expect(within(rail).queryByRole('button', { name: /start job|reading the file|continue/i })).not.toBeInTheDocument();
    });

    it('puts what was read from the file first, then the modes, then the destination: the approved order, for the keyboard and a screen reader too', async () => {
      await openCheckAndStart();
      const read = screen.queryByTestId('file-study-panel') ?? screen.getByTestId('file-reading-card');
      const destination = screen.getByRole('heading', { name: 'Where do the items land?' });
      const modes = screen.getByRole('radiogroup', { name: 'Analysis mode' });
      expect(read.compareDocumentPosition(modes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(modes.compareDocumentPosition(destination) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('the upload step offers "Check and start" in BASELINE, the page it leads to', async () => {
      vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(previewWith(OVERVIEW));
      vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: [], recommended: null, details: [] });
      render(
        <ToastProvider>
          <MemoryRouter>
            <NewJobWizard />
          </MemoryRouter>
        </ToastProvider>,
      );
      await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'req.docx'));
      expect(await screen.findByRole('button', { name: 'Check and start' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    });

    it('holds Start until a destination is chosen, and says so beside it', async () => {
      await openCheckAndStart();
      const start = await screen.findByRole('button', { name: /looks right/i });
      expect(start).toBeDisabled();
      expect(start.parentElement).toHaveTextContent('Choose an area path to start.');
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
      expect(start).toBeEnabled();
      expect(screen.queryByText(/to start\./i)).not.toBeInTheDocument();
    });

    it('switching to With AI review keeps this one page: what was read, the destination and Start, with no Continue', async () => {
      await openCheckAndStart();
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
      const heading = screen.getByRole('heading', { level: 1 });
      await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));

      expect(screen.getByRole('heading', { level: 1 })).toBe(heading);
      expect(heading).toHaveTextContent('New job, step 2 of 2');
      expect(document.title).toBe('Step 2 of 2: Check and start - New job');
      expect(screen.queryByRole('button', { name: /^continue$/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /looks right|reading the/i })).toBeInTheDocument();
      expect(screen.queryByTestId('file-study-panel') ?? screen.queryByTestId('file-reading-card')).toBeInTheDocument();
    });

    it('a With AI review user who picks Standard stays on "Check and start", and starts from there', async () => {
      vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
      await openStep3();
      await userEvent.click(screen.getByRole('radio', { name: /Standard/i }));

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New job, step 2 of 2');
      expect(screen.queryByRole('button', { name: /^continue$/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId('file-study-panel') ?? screen.queryByTestId('file-reading-card')).toBeInTheDocument();
      await startBaselineJob();
      expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline', areaPath: 'Project\\Area1' }));
    });

    it('a BASELINE draft kept on step 3 comes back on "Check and start"', async () => {
      vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: [], recommended: null, details: [] });
      useNewJobDraftStore.getState().patch({ step: 3, file: new File(['x'], 'req.docx'), preview: previewWith(OVERVIEW), parseStatus: 'parsed', mode: 'baseline', areaPath: 'Project\\Area1' });
      render(
        <ToastProvider>
          <MemoryRouter>
            <NewJobWizard />
          </MemoryRouter>
        </ToastProvider>,
      );
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New job, step 2 of 2');
      expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
      expect(screen.queryByTestId('file-study-panel') ?? screen.queryByTestId('file-reading-card')).toBeInTheDocument();
    });
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
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await waitFor(() => expect(screen.getByText(/About document A/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['y'], 'doc-b.docx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));

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
    await userEvent.click(await screen.findByRole('button', { name: /configure|check and start/i }));
    await screen.findByText(/typically, once it starts/i);
  }

  it('does not tell a BASELINE user that its estimate is still learning: BASELINE is a flat figure that never changes', async () => {
    await reachStep2();
    await userEvent.click(screen.getByRole('radio', { name: /Standard/i }));
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(rail).toHaveTextContent('Standard');
    expect(rail).not.toHaveTextContent(/no completed runs yet/i);
    expect(rail).not.toHaveTextContent(/feeds the fit|sharpens on its own|conservative default/i);
  });

  it('says so when no finished SURVEY run is near the document\'s size', async () => {
    await reachStep2(0);
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    expect(screen.getByText(/no finished with ai review run is near this document's size/i)).toBeInTheDocument();
  });

  it('does not say it when a finished SURVEY run is near the document\'s size', async () => {
    await reachStep2(3);
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    expect(screen.queryByText(/no finished with ai review run is near this document's size/i)).not.toBeInTheDocument();
  });

  it('shows the uploaded document once, in the strip under the title with its counts, not again in the rail', async () => {
    await reachStep2();
    const strip = screen.getByTestId('file-strip');
    expect(strip).toHaveTextContent('AirPro_ICD.docx');
    expect(strip).toHaveTextContent('682 blocks');
    expect(strip).toHaveTextContent('24 sections');
    expect(strip).toHaveTextContent('39 figures');
    expect(screen.getByRole('complementary', { name: 'This run' })).not.toHaveTextContent('AirPro_ICD.docx');
  });

  it('puts the question on the canvas, so the mode cards are the only cards (DESIGN.md §16.15, §11.2.5)', async () => {
    await reachStep2();
    expect(screen.getByRole('heading', { level: 2, name: 'How should it read the document?' })).toBeInTheDocument();
    const modes = screen.getByRole('radiogroup', { name: 'Analysis mode' });
    // no card around the mode cards: neither a Card ancestor nor a card-shaped wrapper
    expect(modes.closest('.shadow-card')).toBeNull();
  });

  it('lets you change the document from the file strip, which goes back to step 1', async () => {
    await reachStep2();
    await userEvent.click(screen.getByRole('button', { name: /change document/i }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('New job, step 1 of 2');
  });

  it('keeps the primary action and the safety line together in the sticky bar, in both modes (one page)', async () => {
    await reachStep2();
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    const bar = screen.getByRole('button', { name: /looks right|reading the/i }).parentElement as HTMLElement;
    expect(bar.className).toMatch(/sticky/);
    expect(bar).toHaveTextContent('Nothing reaches Azure DevOps until you approve the proposed diff.');
    expect(within(screen.getByRole('complementary', { name: 'This run' })).queryByRole('button', { name: /continue|looks right/i })).toBeNull();
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
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    expect(screen.queryByText('What will it cost you?')).not.toBeInTheDocument();
    expect(screen.queryByText(/SURVEY mode scales with document size/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/typically, once it starts/i)).toHaveLength(1);
  });

  it('says beside Start why it is disabled while no destination is chosen, in both modes', async () => {
    await reachStep2();
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    const start = screen.getByRole('button', { name: /looks right|reading the/i });
    expect(start).toBeDisabled();
    expect(start.parentElement).toHaveTextContent('Choose an area path to start.');
  });

  it('drops that reason once the destination is filled in', async () => {
    await reachStep2();
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area');
    expect(screen.queryByText(/to start\./i)).not.toBeInTheDocument();
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


describe('NewJobWizard: remembers the last job\'s destination, and labels its mode without selecting it (J2, D1)', () => {
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
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
  }

  it('saves the mode, project and area path once a job has started, under the signed-in user', async () => {
    mockApis();
    renderWizard();
    await uploadAndConfigure();
    await userEvent.click(screen.getByText('With AI review'));
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));
    await userEvent.type(await screen.findByLabelText(/area path/i), 'Project');
    await waitFor(() => expect(screen.getByRole('button', { name: /looks right/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    await waitFor(() => expect(jobsApi.submitJob).toHaveBeenCalled());

    expect(JSON.parse(localStorage.getItem('req2ado-last-job:user-descriptor-1') ?? 'null')).toEqual({
      mode: 'survey', project: 'Project', areaPath: 'Project',
    });
  });

  it('starts the next job with the destination filled, BASELINE selected, and "Last used" on the last job\'s SURVEY card', async () => {
    mockApis();
    localStorage.setItem('req2ado-last-job:user-descriptor-1', JSON.stringify({ mode: 'survey', project: 'Project', areaPath: 'Project\\Customer Requirements' }));
    renderWizard();
    await uploadAndConfigure();
    expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /With AI review/ })).not.toBeChecked();
    expect(within(screen.getByRole('radio', { name: /With AI review/ })).getByText('Last used')).toBeInTheDocument();
    expect(within(screen.getByRole('radio', { name: /Standard/ })).queryByText('Last used')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/team project/i)).toHaveValue('Project');
    expect(await screen.findByLabelText(/area path/i)).toHaveValue('Project\\Customer Requirements');
  });

  it('picking a team project fills that project\'s own last area path (B6) but never its mode, whichever mode is selected', async () => {
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
    expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();

    // Now the user chooses SURVEY; another project's remembered BASELINE does not replace it, but its area path is offered.
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/ }));
    await userEvent.clear(screen.getByLabelText(/team project/i));
    await userEvent.type(screen.getByLabelText(/team project/i), 'Other');
    await waitFor(() => expect(screen.getByLabelText(/area path/i)).toHaveValue('Other\\Imports'));
    expect(screen.getByRole('radio', { name: /With AI review/ })).toBeChecked();
  });

  it('does not start from another user\'s choices', async () => {
    mockApis();
    localStorage.setItem('req2ado-last-job:someone-else', JSON.stringify({ mode: 'survey', project: 'Project', areaPath: 'Project\\X' }));
    renderWizard();
    await uploadAndConfigure();
    expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();
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
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));

    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(within(rail).getByText('Not chosen yet')).toBeInTheDocument();
    expect(screen.getByText(/choose an area path to start/i)).toBeInTheDocument();

    await userEvent.type(await screen.findByLabelText(/area path/i), 'Project');
    expect(within(rail).queryByText('Not chosen yet')).not.toBeInTheDocument();
  });
});

describe('NewJobWizard keeps the "This run" rail beside Start (J4, owner decision 2026-11-12)', () => {
  it('shows the mode and where it lands next to the start button, and the file in the strip', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await userEvent.click(screen.getByText('With AI review'));
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Project' }));
    await userEvent.type(await screen.findByLabelText(/area path/i), 'Project');
    await waitFor(() => expect(screen.getByRole('button', { name: /looks right/i })).toBeInTheDocument());

    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(within(screen.getByTestId('file-strip')).getByText('req.docx')).toBeInTheDocument(); // the file is said once, in the strip
    expect(within(rail).getByText(/With AI review/)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /configure|check and start/i })).toBeEnabled();
  });

  it('says nothing for a new file name', async () => {
    await uploadNamed('fresh.docx', [earlier('4270e8be-1', 'spec.docx', '2026-11-12T00:00:00Z')]);
    await screen.findByText(/straightforward parse|detected|found/i);
    expect(screen.queryByText(/already ran a file with this name/i)).not.toBeInTheDocument();
  });

  it('carries on without the note when the job list cannot be read', async () => {
    await uploadNamed('spec.docx', undefined);
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).toBeEnabled());
    expect(screen.queryByText(/already ran a file with this name/i)).not.toBeInTheDocument();
  });
});

describe('NewJobWizard re-run of a file (P5)', () => {
  const HASH = 'f'.repeat(64);
  const earlier = { id: '4270e8be-1979-4cd3-94ea-a0a0d5ef6ed0', mode: 'survey', status: 'diff_ready', areaPath: 'P\\A', originalFilename: 'spec.docx', itemCount: 5, createdItemCount: 0, createdAt: new Date(Date.now() - 3600 * 1000).toISOString() };
  async function toStep2(cached: boolean, summary: string | null = null): Promise<void> {
    useAuthStore.getState().logout(); // free-text area path: no ADO pickers to drive
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 20, sectionCount: 3, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [], fileHash: HASH,
      overview: { synopsis: 'A spec.', caveat: null, profile: { summaryInput: 'Sections: 1 Scope' } },
    } as any);
    vi.spyOn(jobsApi, 'listJobs').mockResolvedValue([earlier] as any);
    vi.spyOn(jobsApi, 'getEstimate').mockResolvedValue({ mode: 'survey', lowerMinutes: 20, upperMinutes: 35, basis: 'blended', sampleCount: 4 } as any);
    vi.spyOn(jobsApi, 'getCachedResult').mockResolvedValue(cached);
    vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue(summary);
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
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await userEvent.click(screen.getByText('With AI review'));
  }

  it('keeps the "already ran a file with this name" note on steps 2 and 3 as one compact line', async () => {
    await toStep2(false);
    const rail = screen.getByRole('complementary', { name: 'This run' });
    expect(within(rail).getByText(/already ran a file with this name/i)).toBeInTheDocument();
    expect(within(rail).getByRole('link', { name: /4270e8be/ })).toHaveAttribute('href', '/jobs/4270e8be-1979-4cd3-94ea-a0a0d5ef6ed0');
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project');
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
    const card = screen.getByRole('radio', { name: /With AI review/ });
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
    // One page: the summary is asked as soon as With AI review is chosen.
    await toStep2(false, 'A summary of the file.');
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

  async function toStep3(tokens: unknown, cached = false, pickModel?: string): Promise<void> {
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
    await userEvent.click(await screen.findByRole('button', { name: /configure|check and start/i }));
    await userEvent.click(screen.getByText('With AI review'));
    if (pickModel) {
      await waitFor(() => expect(jobsApi.listModels).toHaveBeenCalled());
      screen.getByRole('combobox', { name: 'AI model' }).focus();
      await userEvent.keyboard('{Enter}');
      await userEvent.click(await screen.findByRole('option', { name: pickModel }));
    }
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project');
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
    expect(screen.queryByText('Start a large With AI review run?')).not.toBeInTheDocument();
  });

  it('asks first when the forecast is above the threshold, starts only on confirmation, and not at all on cancel', async () => {
    await toStep3(forecast({ requiresConfirmation: true, costUsd: { low: 4.2, high: 18 } }));

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Start a large With AI review run?')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('690k – 2.1M model tokens (input and output), about $4.20 – $18');
    expect(dialog).toHaveTextContent('With your default model, this run');
    expect(dialog).toHaveTextContent('Plus a short pre-study read of the file’s layout, not counted here.');
    expect(jobsApi.submitJob).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jobsApi.submitJob).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start the run' }));
    await waitFor(() => expect(jobsApi.submitJob).toHaveBeenCalledTimes(1));
  });

  it('names the chosen model, and says no price is set when the server has none for it', async () => {
    await toStep3(forecast({ requiresConfirmation: true }), false, 'm1');
    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('With m1, this run');
    expect(dialog).toHaveTextContent('690k – 2.1M model tokens (input and output), no price is set for this model.');
    expect(dialog).not.toHaveTextContent('$');
  });

  it('shows no forecast and never asks for a file the result cache would serve, which spends no tokens', async () => {
    await toStep3(forecast({ requiresConfirmation: true }), true);
    const rail = screen.getByRole('complementary', { name: 'This run' });
    await within(rail).findByText('A few seconds');
    expect(within(rail).queryByText(/tokens/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));
    await waitFor(() => expect(jobsApi.submitJob).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Start a large With AI review run?')).not.toBeInTheDocument();
  });
});


describe('NewJobWizard: how the file is read (the pre-study)', () => {
  const PREVIEW = {
    blockCount: 1,
    sectionCount: 6,
    figureCount: 0,
    depth: 2,
    fileType: 'xlsx',
    tableCount: 1,
    openTbdCount: 0,
    documentMap: [],
    estimate: { mode: 'baseline', estimateMinutes: 1 },
    fileHash: 'f'.repeat(64),
    documentTokens: 10,
    overview: { synopsis: 'A sheet.', caveat: null, lines: ['Structure: 1 table.'], profile: { summaryInput: 'x' } },
  } as never;
  const VIEW = {
    id: 'rb1',
    source: 'model',
    hash: '0123456789abcdef',
    rules: ["Sheet: Types are stated in column 'Kind' (4 Epics, 39 Features, 235 Requirements); nesting from 'Key' and 'Parent'. (read by the model)"],
    warnings: [],
    rulebook: { version: 1, tables: { t0: { nesting: 'id_parent', type_map: { area: 'Epic', check: null } } }, document: null },
    reused: false,
  } as never;

  const SKIPPED = { ...(VIEW as object), id: null, source: 'none', rules: [], hash: '', skipped: 'No model connection is configured for your account, so the file is read by its recognised headings and its shape.' } as never;

  async function toStepTwo(): Promise<void> {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['m1'], recommended: null, details: [] });
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'sheet.xlsx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
  }
  // BASELINE (the default) shows the reading on step 2, "Check and start", beside Start: nothing to continue to.
  async function toCheckAndStart(): Promise<void> {
    await toStepTwo();
  }
  async function startJob(): Promise<void> {
    const start = await screen.findByRole('button', { name: /looks right/i });
    await waitFor(() => expect(start).not.toBeDisabled());
    await userEvent.click(start);
  }

  it('is asked once, right after the file is parsed while still on step 1; the reading shows on step 2 in both modes', async () => {
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['m1'], recommended: null, details: [] });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'sheet.xlsx'));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /configure|check and start/i })).toBeInTheDocument(); // still on step 1
    expect(screen.queryByTestId('file-reading-card')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    expect(await screen.findByText(/types are stated in column 'Kind'/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    expect(await screen.findByText(/types are stated in column 'Kind'/i)).toBeInTheDocument();
    expect(learn).toHaveBeenCalledTimes(1); // not again on returning to step 2
  });

  it('BASELINE reads the file\'s conventions at parse, with the default model, and the job is built from that rulebook', async () => {
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    await toCheckAndStart();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(await screen.findByText(/types are stated in column 'Kind'/i)).toBeInTheDocument();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(learn.mock.calls[0][0]).toBeInstanceOf(File);
    expect(learn.mock.calls[0][1]).toBeUndefined(); // no model sent: the deployment's default reads it
    expect(screen.getByText('Model: Default')).toBeInTheDocument();
    await startJob();
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline', rulebookId: 'rb1' }));
  });

  it('a switch to BASELINE after a SURVEY model read the file does not read again by itself: the card says so, and reading again sends no model', async () => {
    useNewJobDraftStore.getState().patch({ mode: 'survey', model: 'm1' });
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    await toStepTwo();
    expect(learn.mock.calls[0][1]).toBe('m1'); // read at parse with the mode and model of that moment
    await userEvent.click(screen.getByRole('radio', { name: /Standard/i })); // the same page now shows the reading
    expect(await screen.findByTestId('file-rules-model-hint')).toHaveTextContent('Read with m1. This job will use the default model.');
    expect(learn).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Read again with the default model' }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(learn.mock.calls[1][1]).toBeUndefined();
    expect(learn.mock.calls[1][2]).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('file-rules-model-hint')).not.toBeInTheDocument());
  });

  it('a SURVEY draft with a model reads the file with it at parse, and names it', async () => {
    useNewJobDraftStore.getState().patch({ mode: 'survey', model: 'm1' });
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    await toStepTwo();
    expect(learn).toHaveBeenCalledTimes(1);
    expect(learn.mock.calls[0][1]).toBe('m1');
    expect(await screen.findByText(/types are stated in column 'Kind'/i)).toBeInTheDocument();
    expect(screen.getByText('Model: m1')).toBeInTheDocument();
    expect(screen.queryByTestId('file-rules-model-hint')).not.toBeInTheDocument(); // the same model: nothing to say
  });

  it('a SURVEY model picked after the file was read: the card names both and offers to read again with the job\'s model', async () => {
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    await toStepTwo();
    expect(learn.mock.calls[0][1]).toBeUndefined(); // BASELINE at parse: the default model
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    screen.getByRole('combobox', { name: 'AI model' }).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await screen.findByRole('option', { name: 'm1' }));
    expect(await screen.findByTestId('file-rules-model-hint')).toHaveTextContent('Read with the default model. This job will use m1.');
    expect(learn).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Read again with m1' }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(learn.mock.calls[1][1]).toBe('m1');
    await waitFor(() => expect(screen.getByText('Model: m1')).toBeInTheDocument());
    expect(screen.queryByTestId('file-rules-model-hint')).not.toBeInTheDocument();
  });

  it('SURVEY with the Default model sends none', async () => {
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    await toStepTwo();
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(1));
    expect(learn.mock.calls[0][1]).toBeUndefined();
  });

  it('is asked once per file: going back to step 1 and returning does not ask again, "Read again" does', async () => {
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    await toCheckAndStart();
    await screen.findByText(/types are stated in column 'Kind'/i);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    expect(await screen.findByText(/types are stated in column 'Kind'/i)).toBeInTheDocument();
    expect(learn).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /read again/i }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(learn.mock.calls[1][2]).toBe(true);
  });

  it('keeps an answer that arrives after the user went back to step 1: it is for the same file', async () => {
    let finish: (view: never) => void = () => {};
    const learn = vi.spyOn(jobsApi, 'previewRules').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await toCheckAndStart();
    await screen.findByRole('button', { name: /reading the file/i });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await act(async () => finish(VIEW));
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    expect(await screen.findByText(/types are stated in column 'Kind'/i)).toBeInTheDocument();
    expect(learn).toHaveBeenCalledTimes(1);
    await startJob();
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ rulebookId: 'rb1' }));
  });

  it('a new file starts over: its own study is asked when it is parsed, the earlier file\'s rulebook is not used', async () => {
    const learn = vi
      .spyOn(jobsApi, 'previewRules')
      .mockResolvedValueOnce(VIEW)
      .mockResolvedValueOnce({ ...(VIEW as object), id: 'rb-new', rules: ['New file rule.'] } as never);
    await toCheckAndStart();
    await screen.findByText(/types are stated in column 'Kind'/i);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['y'], 'other.xlsx'));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2)); // at parse, still on step 1
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    expect(await screen.findByText('New file rule.')).toBeInTheDocument();
    expect(learn).toHaveBeenCalledTimes(2);
    expect((learn.mock.calls[1][0] as File).name).toBe('other.xlsx');
    await startJob();
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ rulebookId: 'rb-new' }));
  });

  it('"Change document" drops an answer still in flight; the same file is asked again only once the user goes on from step 1', async () => {
    const answers: ((view: never) => void)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const learn = vi.spyOn(jobsApi, 'previewRules').mockImplementation((_file, _model, _relearn, signal) => {
      signals.push(signal);
      return new Promise((resolve) => answers.push(resolve));
    });
    await toCheckAndStart();
    await screen.findByRole('button', { name: /reading the file/i });
    await userEvent.click(screen.getByRole('button', { name: /change document/i }));
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => answers[0](VIEW)); // the stale answer comes back anyway
    expect(learn).toHaveBeenCalledTimes(1); // not while the user may still replace the file
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /reading the file/i })).toBeDisabled();
    expect(screen.queryByText(/types are stated in column 'Kind'/i)).not.toBeInTheDocument();
    await act(async () => answers[1]({ ...(VIEW as object), id: 'rb2', rules: ['Second reading.'] } as never));
    expect(await screen.findByText('Second reading.')).toBeInTheDocument();
    await startJob();
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ rulebookId: 'rb2' }));
  });

  it('a draft restored on step 3 asks for the study on arrival, once', async () => {
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    useNewJobDraftStore.getState().patch({ step: 3, file: new File(['x'], 'sheet.xlsx'), preview: PREVIEW, parseStatus: 'parsed', mode: 'baseline', areaPath: 'Project\\Area1' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByText(/types are stated in column 'Kind'/i)).toBeInTheDocument();
    expect(learn).toHaveBeenCalledTimes(1);
    await startJob();
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline', rulebookId: 'rb1' }));
  });

  it('with no model connection Start is blocked in both modes, says why, and offers to read the file again (owner decision, 2026-11-25)', async () => {
    const learn = vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(SKIPPED);
    await toCheckAndStart();
    expect(await screen.findByTestId('file-rules-skipped')).toBeInTheDocument();
    const start = screen.getByRole('button', { name: /looks right/i });
    expect(start).toBeDisabled();
    expect(screen.getByTestId('start-needs-model')).toHaveTextContent('An AI model is needed to read the file, in both modes.');
    await userEvent.click(screen.getByRole('radio', { name: /With AI review/i }));
    expect(screen.getByRole('button', { name: /looks right/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Read the file again' }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(2));
    expect(learn.mock.calls[1][2]).toBe(true);
    expect(jobsApi.submitJob).not.toHaveBeenCalled();
  });

  it('holds the start button on "Check and start" while the file is being read, says why, and releases it after', async () => {
    let finish: (view: never) => void = () => {};
    vi.spyOn(jobsApi, 'previewRules').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await toCheckAndStart();
    const start = await screen.findByRole('button', { name: /reading the file/i });
    expect(start).toBeDisabled();
    await act(async () => finish(VIEW));
    await waitFor(() => expect(screen.getByRole('button', { name: /looks right/i })).not.toBeDisabled());
  });

  it('a failed study holds Start and says why, with no bare server error; Try again asks again and a success frees Start (owner decision, 2026-11-25)', async () => {
    const learn = vi
      .spyOn(jobsApi, 'previewRules')
      .mockRejectedValueOnce({ response: { status: 500, data: { statusCode: 500, message: 'Internal server error' } } })
      .mockResolvedValue(VIEW);
    await toCheckAndStart();
    const failed = await screen.findByTestId('file-study-failed');
    expect(screen.getByRole('heading', { name: 'The file could not be studied' })).toBeInTheDocument();
    expect(failed).toHaveTextContent('The model did not finish reading the file. Start waits until the study succeeds.');
    expect(failed).not.toHaveTextContent(/internal server error/i);
    expect(screen.getByTestId('start-study-failed')).toHaveTextContent('Start waits for the file study.');
    expect(screen.getByRole('button', { name: /looks right/i })).toBeDisabled();
    await userEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
    expect(learn).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId('file-study-failed')).not.toBeInTheDocument());
    await startJob();
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ rulebookId: 'rb1' }));
  });

  it('shows the server\'s own reason when it gives one', async () => {
    vi.spyOn(jobsApi, 'previewRules').mockRejectedValue({ response: { status: 504, data: { message: 'The model took longer than 10 minutes to answer.' } } });
    await toCheckAndStart();
    expect(await screen.findByTestId('file-study-failed')).toHaveTextContent('The model took longer than 10 minutes to answer.');
  });

  it('an edit that fits replaces the rulebook the job is built from; one that does not is refused with the reason', async () => {
    vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    const edit = vi
      .spyOn(jobsApi, 'editRules')
      .mockRejectedValueOnce({ response: { data: { message: 'the title is empty on too many rows' } } })
      .mockResolvedValueOnce({ ...(VIEW as object), id: 'rb2', source: 'user', hash: 'fedcba9876543210' } as never);
    await toCheckAndStart();
    await userEvent.click(await screen.findByRole('button', { name: /edit types/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/title is empty on too many rows/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByText(/your edit, checked against the file/i)).toBeInTheDocument());
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[0][2]).toBeUndefined(); // checked with the model that read it (BASELINE: the default)
    await startJob();
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ rulebookId: 'rb2' }));
  });

  it('shows what the rules make of the file, and the new counts once an edit is saved', async () => {
    const table = (requirements: number, skipped: number) => ({
      name: 'Sheet',
      totalRows: 346,
      typeCounts: { Epic: 4, Feature: 39, Requirement: requirements },
      samples: {},
      skipped: { count: skipped, byReason: skipped ? { 'type:check': skipped } : {}, rows: [], more: 0 },
    });
    vi.spyOn(jobsApi, 'previewRules').mockResolvedValue({ ...(VIEW as object), details: { approximate: false, tables: [table(235, 68)], document: null } } as never);
    vi.spyOn(jobsApi, 'editRules').mockResolvedValue({ ...(VIEW as object), id: 'rb2', source: 'user', details: { approximate: false, tables: [table(303, 0)], document: null } } as never);
    await toCheckAndStart();
    expect(await screen.findByTestId('file-rules-counts')).toHaveTextContent('Epic 4 · Feature 39 · Requirement 235 · Not imported 68 rows');
    await userEvent.click(screen.getByRole('button', { name: /edit types/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByTestId('file-rules-counts')).toHaveTextContent(/^Epic 4 · Feature 39 · Requirement 303$/));
  });

  it('shows how long the reading has run', async () => {
    vi.spyOn(jobsApi, 'previewRules').mockReturnValue(new Promise(() => {}));
    await toCheckAndStart();
    expect(await screen.findByTestId('file-study-elapsed')).toHaveTextContent(/^\d\d:\d\d so far · Start waits for it$/);
  });

  it('has no "Stop waiting": Start waits for the study, which the job needs, and is released when it answers (owner decision, 2026-11-25)', async () => {
    let finish: (view: never) => void = () => {};
    vi.spyOn(jobsApi, 'previewRules').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await toCheckAndStart();
    expect(await screen.findByRole('button', { name: /reading the file/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(screen.getByTestId('file-study-panel')).toHaveTextContent('Studying the file');
    await act(async () => finish(VIEW));
    await startJob();
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ rulebookId: 'rb1' }));
  });

  it('too many readings in a minute says so plainly', async () => {
    vi.spyOn(jobsApi, 'previewRules').mockRejectedValue({ response: { status: 429, data: { message: 'ThrottlerException: Too Many Requests' } } });
    await toCheckAndStart();
    expect(await screen.findByText(/too many reads in a minute\. try again shortly\./i)).toBeInTheDocument();
  });
});

describe('NewJobWizard: reading and analyzing the document (the Study)', () => {
  const PREVIEW = {
    blockCount: 1,
    sectionCount: 6,
    figureCount: 0,
    depth: 2,
    fileType: 'xlsx',
    tableCount: 1,
    openTbdCount: 0,
    documentMap: [],
    estimate: { mode: 'baseline', estimateMinutes: 1 },
    fileHash: 'f'.repeat(64),
    documentTokens: 10,
    overview: { synopsis: 'A sheet.', caveat: null, lines: ['Structure: 1 table.'], profile: { summaryInput: 'x' } },
  } as never;
  const VIEW = { id: 'rb1', source: 'model', hash: '0123456789abcdef', rules: [], warnings: [], rulebook: { version: 1, tables: {}, document: null }, reused: false } as never;
  const STUDY = {
    orientation: { document_type: 'A system requirements specification', purpose: 'States what the radio does', system: 'The radio', conventions: '' },
    glossary: [{ term: 'BIT', definition: 'Built-in test' }],
    placeholder_tokens: ['TBD'],
    verification_statements: ['Verified by test TP-1', 'Measured at ambient'],
    standards_cited: [],
    table_roles: [],
    vocabulary: [{ table: 'Sheet', column: 'Priority', values: ['High', 'Low'], more: 0 }],
    stats: { windows_studied: 4, windows_total: 4, budget_stopped: false, orientation_failed: false, from_cache: false },
    warnings: [],
  };

  async function toCheckAndStart(): Promise<void> {
    vi.spyOn(jobsApi, 'previewRules').mockResolvedValue(VIEW);
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue(PREVIEW);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['m1'], recommended: null, details: [] });
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.upload(screen.getByLabelText(/upload/i), new File(['x'], 'sheet.xlsx'));
    await waitFor(() => expect(screen.getByRole('button', { name: /configure|check and start/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure|check and start/i }));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
  }

  it('reads with the rulebook shown and the job\'s model, and Start waits for it, showing the parts read', async () => {
    let progress: (done: number, total: number) => void = () => undefined;
    let finish: (value: { kind: 'study'; study: typeof STUDY }) => void = () => undefined;
    const read = vi.spyOn(jobsApi, 'previewStudy').mockImplementation((_input, onProgress) => {
      progress = onProgress;
      return new Promise((resolve) => (finish = resolve as never));
    });
    await toCheckAndStart();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read.mock.calls[0][0]).toMatchObject({ mode: 'baseline', model: undefined, rulebookId: 'rb1' });
    const start = screen.getByRole('button', { name: /reading the document/i });
    expect(start).toBeDisabled();
    act(() => progress(2, 4));
    expect(await within(screen.getByTestId('file-reading-card')).findByText(/part 3 of 4/)).toBeInTheDocument();
    act(() => finish({ kind: 'study', study: STUDY }));
    await userEvent.click(await screen.findByRole('button', { name: /what the model learned from reading the document/i }));
    expect(await screen.findByText('The radio')).toBeInTheDocument();
    expect(screen.getByText(/found 2 verification statements · 1 defined term · 1 open-value marker/i)).toBeInTheDocument();
    const ready = screen.getByRole('button', { name: /looks right/i });
    await waitFor(() => expect(ready).toBeEnabled());
    await userEvent.click(ready);
    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ rulebookId: 'rb1' }));
  });

  it('a reading that fails frees Start and says the job will say so', async () => {
    vi.spyOn(jobsApi, 'previewStudy').mockRejectedValue(new Error('The model route did not answer.'));
    await toCheckAndStart();
    expect(await screen.findByText(/the model route did not answer\. the job can start without it/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /looks right/i })).toBeEnabled());
  });

  it('shows nothing and holds nothing when the job reads no Study', async () => {
    vi.spyOn(jobsApi, 'previewStudy').mockResolvedValue({ kind: 'skipped' });
    await toCheckAndStart();
    await waitFor(() => expect(screen.getByRole('button', { name: /looks right/i })).toBeEnabled());
    expect(screen.queryByTestId('document-study-card')).not.toBeInTheDocument();
  });
});
