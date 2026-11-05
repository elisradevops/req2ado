import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NewJobWizard } from './NewJobWizard';
import { ToastProvider } from '../components/ToastProvider';
import * as jobsApi from '../api/jobs';
import * as adoApi from '../api/ado';
import * as kbApi from '../api/kb';
import { useAuthStore } from '../store/authStore';

vi.mock('../api/jobs');
vi.mock('../api/ado');
vi.mock('../api/kb');

// The SURVEY configure step shows a KB readiness strip; give it a healthy KB
// by default so unrelated tests never hit the network or an undefined mock.
beforeEach(() => {
  vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
  vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 });
});

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

  // Step 3 shows the overview the preview already returned: made from the parsed text and structure, so it is there at once and nothing
  // is studied by a model while the user waits.
  const OVERVIEW = {
    synopsis: 'Purpose, quoted from §1.1 Scope: “About a backplane.” All of the above is taken from the document’s text and structure; no AI was used.',
    caveat: null,
    lines: ['Purpose, quoted from §1.1 Scope: “About a backplane.”', 'Unresolved values: TBD ×2 (3 Power).', 'All of the above is taken from the document’s text and structure; no AI was used.'],
    structureHint: 'How this document is built (context only): 6 sections.',
    profile: {},
  };
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

    it('hides the summary, and the waiting note, when there is none', async () => {
      vi.spyOn(jobsApi, 'previewSummary').mockResolvedValue(null);
      await openStep3(withInput);
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(screen.queryByText(/ai summary/i)).not.toBeInTheDocument();
      expect(screen.getByText(/About a backplane/)).toBeInTheDocument();
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
      expect(screen.queryByText(/ai summary/i)).not.toBeInTheDocument();
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
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
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

  it('"Back to configure" returns to step 2 without losing the area path', async () => {
    await openStep3();

    await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));

    expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
  });

  it('a replaced file shows its own overview, never the previous file\'s (regression)', async () => {
    vi.spyOn(jobsApi, 'previewJob')
      .mockResolvedValueOnce(previewWith({ ...OVERVIEW, lines: ['Purpose, quoted from §1 Scope: “About document A.”', OVERVIEW.lines[2]] }))
      .mockResolvedValueOnce(previewWith({ ...OVERVIEW, lines: ['Purpose, quoted from §1 Scope: “About document B.”', OVERVIEW.lines[2]] }));
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
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
