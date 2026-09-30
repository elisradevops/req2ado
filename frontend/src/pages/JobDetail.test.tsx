import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { JobDetail } from './JobDetail';
import { ToastProvider } from '../components/ToastProvider';
import * as jobsApi from '../api/jobs';
import { useAuthStore } from '../store/authStore';

vi.mock('../api/jobs');
vi.mock('../api/chat');
vi.mock('../api/events', async () => {
  // Real isValidNarrationEvent must survive the mock -- JobDetail.tsx's
  // event-history merge (mergedNarrations) calls it directly, and a
  // previous version of this mock (subscribeToJobEvents only) silently
  // left it undefined, working only by accident because every test here
  // defaulted getEventHistory to [] and so never actually invoked it.
  const actual = await vi.importActual<typeof import('../api/events')>('../api/events');
  return { ...actual, subscribeToJobEvents: vi.fn(() => () => {}) };
});
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

function renderAt(id: string) {
  // Wrapped in ToastProvider matching App.tsx's real composition -- the
  // diff tree's NodeDetailPanel renders ChatPanel (and, since Fix D, calls
  // useToast() itself for the "Suggest a title" button's error handling),
  // both of which require a ToastProvider ancestor to be present.
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/jobs/${id}`]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetail />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('JobDetail', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({
      created: 0, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [],
    });
    // Default for every test -- fired unconditionally on mount for any
    // terminal-status job (see JobDetail.tsx's event-history effect).
    // Individual tests override this when they need to assert against a
    // specific event-history payload (e.g. a job_failed detail panel).
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    // vi.mock('../api/jobs') above auto-mocks every export as a bare
    // vi.fn() returning undefined by default -- FigureImage (mounted
    // whenever FigureDescriptions is expanded, or a selected entry has
    // figureIds) calls this and .then()s the result, which throws on a
    // bare `undefined` rather than a resolved/rejected promise. null is
    // the real "nothing stored" response shape (see getFigureFile's own
    // doc comment), so this default renders FigureImage's quiet
    // "Image no longer available" placeholder rather than crashing.
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });

  it('renders an explicit failure screen for a failed job, not a blank diff', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-1', status: 'failed', dryRunDiff: null } as any);
    renderAt('job-1');
    await waitFor(() => expect(screen.getByText(/job failed/i)).toBeInTheDocument());
    expect(screen.queryByText(/select a node/i)).not.toBeInTheDocument();
  });

  it('renders the diff tree for a diff_ready job, and opens the details dialog on row click', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-2',
      status: 'diff_ready',
      dryRunDiff: [{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Root', description: '', action: 'create', customerId: null, tags: [] }],
    } as any);
    // Opening the details dialog now mounts ChatPanel for real (previously
    // only NodeDetailPanel's inert placeholder rendered when no row was
    // selected in any of this file's other tests) -- needs its own API
    // mocks, unlike every other test here that never selects a row.
    const chatApi = await import('../api/chat');
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue([]);
    renderAt('job-2');
    await waitFor(() => expect(screen.getByText('Root')).toBeInTheDocument());
    // Details dialog is closed until a row is opened -- NodeDetailPanel's
    // "Select a node" placeholder only ever renders inside it now.
    expect(screen.queryByText(/select a node/i)).not.toBeInTheDocument();

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByText('Root'));
    expect(await screen.findAllByText('Root')).not.toHaveLength(0);
  });

  // Guard added alongside handleToggleExclude/handleBulkExclude/
  // handleMoveEntry's own isDiffMutatingRef re-entry guard (779-856 above)
  // -- handleSaveEdit had none, so a user who re-opens Edit and clicks Save
  // again before the first editDiffEntry request settles (NodeDetailPanel's
  // own save() exits edit mode immediately, regardless of the request's
  // outcome -- see NodeDetailPanel.tsx) could fire two racing saves. The
  // never-resolving mock isolates the still-in-flight window, same
  // technique JobDetail.optimisticMove.test.tsx already uses for
  // moveDiffEntry.
  it('blocks a second handleSaveEdit call while the first edit is still in flight', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-55',
      status: 'diff_ready',
      dryRunDiff: [
        { localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] },
      ],
    } as any);
    const chatApi = await import('../api/chat');
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue([]);
    // mockClear isolates the call-count assertion below from any earlier
    // test's editDiffEntry calls -- this file has no global clearAllMocks,
    // so vi.mock('../api/jobs')'s shared mock functions otherwise carry
    // call history across tests (same reasoning as DiffTree.test.tsx's own
    // scoped mockClear calls).
    vi.mocked(jobsApi.editDiffEntry).mockClear().mockReturnValue(new Promise(() => {}));

    renderAt('job-55');
    await waitFor(() => expect(screen.getByText('Req Title')).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByText('Req Title'));

    // findByRole (async), not getByRole (sync) -- same race as the second
    // Edit click below: the node-detail-panel render triggered by selecting
    // 'Req Title' may not have committed yet on a slow CI runner.
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    // Save exits edit mode immediately, so a second Edit->Save round is
    // reachable through the same UI -- the guard, not the UI, must block
    // the second underlying call. findByRole (async) rather than getByRole
    // (sync) because the view-mode re-render from exiting edit mode may not
    // have committed by the time this line runs on a slow CI runner.
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(jobsApi.editDiffEntry).toHaveBeenCalledTimes(1);
    // SWEEP.md section 9 follow-up: the guard skipping the call must not be
    // silent -- NodeDetailPanel's own save() exits edit mode regardless, so
    // without a toast the user has no idea the second save never happened.
    await waitFor(() => expect(screen.getByText(/another change is still saving/i)).toBeInTheDocument());
  });

  it('shows a "Needs review" filter chip with the flagged count, and isolates flagged rows on click', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-40',
      status: 'diff_ready',
      dryRunDiff: [
        {
          localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Flagged epic', description: '',
          action: 'create', customerId: null, tags: [], groundingScore: 0.1,
        },
        {
          localId: 'e2', parentLocalId: null, type: 'Epic', title: 'Healthy epic', description: '',
          action: 'create', customerId: null, tags: [], groundingScore: 0.9,
        },
      ],
    } as any);
    renderAt('job-40');
    await waitFor(() => expect(screen.getByText('Flagged epic')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /needs review/i })).toHaveTextContent('1');

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /needs review/i }));

    expect(screen.getByText(/flagged/i)).toBeInTheDocument();
    expect(screen.queryByText('Healthy epic')).not.toBeInTheDocument();
  });

  it('shows a retry control for a failed trace link and calls retryTraceLinkWrite(jobId, failureId) when clicked', async () => {
    const baseJob = {
      id: 'job-20',
      status: 'diff_ready',
      dryRunDiff: [{
        localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Root', description: '', action: 'create', customerId: null, tags: [],
        traceLinks: [
          { sourceLocalId: 'e1', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-1', resolutionStatus: 'resolved' },
        ],
      }],
      traceLinkFailures: [{ id: 'failure-1', sourceLocalId: 'e1', sourceAdoId: 100, targetAdoId: 200, referenceName: 'Elisra.CoveredBy-Forward' }],
      warnings: [
        {
          kind: 'trace_link_write_failed',
          severity: 'pipeline_issue',
          nodeIds: ['e1'],
          detail: {},
          raw: '1 trace link failed to write to Azure DevOps and can be retried from the node detail panel.',
        },
      ],
    };
    // First getJob call (initial load) returns the failure; the retry
    // itself resolves successfully, and JobDetail refetches the job --
    // this second mocked response has an empty traceLinkFailures/warnings,
    // simulating JobsService.retryTraceLinkWrite's server-side recompute.
    vi.spyOn(jobsApi, 'getJob')
      .mockResolvedValueOnce(baseJob as any)
      .mockResolvedValue({ ...baseJob, traceLinkFailures: [], warnings: [] } as any);
    vi.mocked(jobsApi.retryTraceLinkWrite).mockResolvedValue({ written: true, sourceAdoId: 100, targetAdoId: 200 });
    const chatApi = await import('../api/chat');
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue([]);

    renderAt('job-20');
    await waitFor(() => expect(screen.getByText('Root')).toBeInTheDocument());
    // The stale warning (Finding 1) is present before the retry -- a
    // pipeline_issue warning auto-expands by default now, so no clicks are
    // needed to reveal it.
    const { default: userEvent } = await import('@testing-library/user-event');
    expect(screen.getByText('Trace links failed to write to Azure DevOps')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Root'));

    // findByRole's own timeout, not the global asyncUtilTimeout (setup.ts,
    // 3000ms) -- same race as the toast-appear fix elsewhere in this file
    // (see 9e6a6b4): the "Root" click's own re-render (mounting the node
    // detail panel with this chip) can exceed 3000ms under real CI
    // contention even though the underlying mock resolves immediately.
    // Widening just this one call adds headroom without touching the
    // global ceiling anywhere else in the suite.
    const retryButton = await screen.findByRole('button', { name: /retry writing "covers" trace link/i }, { timeout: 8000 });
    await userEvent.click(retryButton);

    expect(jobsApi.retryTraceLinkWrite).toHaveBeenCalledWith('job-20', 'failure-1');
    // Refetch resyncs both traceLinkFailures (retry button disappears) and
    // warnings (the stale banner is cleared) from the server response.
    await waitFor(() => expect(jobsApi.getJob).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /retry writing "covers" trace link/i })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByText('Trace links failed to write to Azure DevOps')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/integrity warning/i)).not.toBeInTheDocument();
  });

  it('renders debug captures alongside the audit trail when the job has soft-failure captures', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-17', status: 'diff_ready', dryRunDiff: [] } as any);
    vi.spyOn(jobsApi, 'getAudit').mockResolvedValue([{ id: 'a1', message: 'Job submitted: x.docx', createdAt: '2026-07-09T00:00:00Z' }]);
    vi.spyOn(jobsApi, 'getDebugCaptures').mockResolvedValue([
      { kind: 'infer_trace_links', identifier: 'document', content: 'malformed JSON in LLM response content: \'Based\'' },
    ]);

    renderAt('job-17');
    const { default: userEvent } = await import('@testing-library/user-event');
    await waitFor(() => expect(screen.getByRole('tab', { name: /audit/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: /audit/i }));

    await waitFor(() => expect(screen.getByText(/raw model responses behind flagged warnings/i)).toBeInTheDocument());
    expect(screen.getByText(/infer_trace_links — document/i)).toBeInTheDocument();
  });

  it('shows a resume-safe banner for a diff_ready job with a nonzero createdItemCount (300577)', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-19',
      status: 'diff_ready',
      dryRunDiff: [],
      createdItemCount: 3,
    } as any);

    renderAt('job-19');

    await waitFor(() => expect(screen.getByText(/already written to azure devops/i)).toBeInTheDocument());
    expect(screen.getByText(/3 work items/i)).toBeInTheDocument();
  });

  it('does not render the resume-safe banner for a diff_ready job with no prior partial write', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-20',
      status: 'diff_ready',
      dryRunDiff: [],
      createdItemCount: 0,
    } as any);

    renderAt('job-20');

    await waitFor(() => expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument());
    expect(screen.queryByText(/already written to azure devops/i)).not.toBeInTheDocument();
  });

  it('shows a Validate button for a job with createdItemCount > 0, and renders a valid result on click (WID 300578)', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-21',
      status: 'diff_ready',
      dryRunDiff: [],
      createdItemCount: 2,
    } as any);
    vi.spyOn(jobsApi, 'validateCreatedTree').mockResolvedValue({ valid: true, checkedCount: 2, mismatches: [] });

    renderAt('job-21');
    const { default: userEvent } = await import('@testing-library/user-event');
    await waitFor(() => expect(screen.getByRole('button', { name: /^validate$/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^validate$/i }));

    expect(jobsApi.validateCreatedTree).toHaveBeenCalledWith('job-21');
    await waitFor(() => expect(screen.getByText(/all 2 checked work items match/i)).toBeInTheDocument());
  });

  it('renders mismatches from a failed Validate result, using the synthetic "existence" field for a missing item', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-22',
      status: 'diff_ready',
      dryRunDiff: [],
      createdItemCount: 2,
    } as any);
    vi.spyOn(jobsApi, 'validateCreatedTree').mockResolvedValue({
      valid: false,
      checkedCount: 2,
      mismatches: [
        { localId: 'n0', adoWorkItemId: 100, field: 'System.Title', expected: 'Real title', actual: 'Wrong title' },
        { localId: 'n1', adoWorkItemId: 101, field: 'existence', expected: 'work item exists in ADO', actual: 'not found' },
      ],
    });

    renderAt('job-22');
    const { default: userEvent } = await import('@testing-library/user-event');
    await waitFor(() => expect(screen.getByRole('button', { name: /^validate$/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^validate$/i }));

    await waitFor(() => expect(screen.getByText(/2 mismatches found/i)).toBeInTheDocument());
    expect(screen.getByText(/WI-100/)).toBeInTheDocument();
    expect(screen.getByText(/WI-101/)).toBeInTheDocument();
    expect(screen.getByText(/work item exists in ADO/)).toBeInTheDocument();
  });

  it('surfaces a toast and does not crash when validateCreatedTree rejects', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-23',
      status: 'diff_ready',
      dryRunDiff: [],
      createdItemCount: 1,
    } as any);
    vi.spyOn(jobsApi, 'validateCreatedTree').mockRejectedValue(new Error('network error'));

    renderAt('job-23');
    const { default: userEvent } = await import('@testing-library/user-event');
    await waitFor(() => expect(screen.getByRole('button', { name: /^validate$/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^validate$/i }));

    await waitFor(() => expect(screen.getByText(/failed to validate/i)).toBeInTheDocument());
  });

  it('does not render a Validate button for a diff_ready job with no created items yet', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-24',
      status: 'diff_ready',
      dryRunDiff: [],
      createdItemCount: 0,
    } as any);

    renderAt('job-24');

    await waitFor(() => expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^validate$/i })).not.toBeInTheDocument();
  });

  it('does not render a debug-captures section when there are none, and still shows the audit trail on fetch failure', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-18', status: 'diff_ready', dryRunDiff: [] } as any);
    vi.spyOn(jobsApi, 'getAudit').mockResolvedValue([{ id: 'a1', message: 'Job submitted: x.docx', createdAt: '2026-07-09T00:00:00Z' }]);
    vi.spyOn(jobsApi, 'getDebugCaptures').mockRejectedValue(new Error('network error'));

    renderAt('job-18');
    const { default: userEvent } = await import('@testing-library/user-event');
    await waitFor(() => expect(screen.getByRole('tab', { name: /audit/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: /audit/i }));

    await waitFor(() => expect(screen.getByText('Job submitted: x.docx')).toBeInTheDocument());
    expect(screen.queryByText(/raw model responses behind flagged warnings/i)).not.toBeInTheDocument();
  });

  it('shows the real job elapsed time from createdAt, not time-since-page-load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    // Job "created" 90s in the real past -- if startedAt used page-load/mount
    // time instead of this, the timer would read ~00:00, not ~01:30.
    const createdAt = new Date(Date.now() - 90_000).toISOString();
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-4',
      status: 'running',
      mode: 'survey',
      dryRunDiff: null,
      createdAt,
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
      onStage('parse');
      return () => {};
    });

    renderAt('job-4');

    await waitFor(() => {
      const match = screen.getByText(/^\d{2}:\d{2}$/);
      const [minutes] = match.textContent!.split(':').map(Number);
      // Allow slack for test execution time -- must NOT be 00, which is
      // what a page-load-time startedAt would produce.
      expect(minutes).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows a section_complete narration\'s nodes in the expandable section-results panel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-5', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage, onNarration) => {
      onStage('infer_hierarchy_start');
      onNarration?.({
        phase: 'section_complete',
        branchIndex: 0,
        branchCount: 1,
        blocksDone: 2,
        blocksTotal: 2,
        kbGrounded: false,
        kbCitations: [],
        sectionLabel: 'Display',
        sectionNodes: [
          { type: 'Requirement', title: 'HDR support', text: 'The display shall support HDR.', qualityScore: 87 },
        ],
        message: 'Finished analyzing section (section 1 of 1 -- Display) -- 1 item(s) drafted',
      } as any);
      return () => {};
    });

    renderAt('job-5');

    await waitFor(() => expect(screen.getByText(/section.*analyzed/i)).toBeInTheDocument());
    await import('@testing-library/user-event').then(({ default: userEvent }) =>
      userEvent.click(screen.getByText(/section.*analyzed/i)),
    );
    await import('@testing-library/user-event').then(({ default: userEvent }) =>
      userEvent.click(screen.getByText(/Section 1: Display/i)),
    );
    expect(screen.getByText('HDR support')).toBeInTheDocument();
    expect(screen.getByText('The display shall support HDR.')).toBeInTheDocument();
  });

  it('shows a section_complete narration\'s real KB citations, not the stale start-event "not grounded" state', async () => {
    // Regression: ProgressBanner's "Grounded against" chips only ever show
    // whichever narration is currently `latest` -- the agentic path's
    // analyze_section START event always fires kbGrounded:false/[] (real
    // retrieval happens mid-call), and that stays `latest` for the section's
    // entire multi-minute duration. Real citations only arrive on
    // section_complete, immediately overwritten by the next section's start
    // event -- a live viewer could never actually see them. This panel
    // accumulates section_complete's real per-section citations instead.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-6', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage, onNarration) => {
      onStage('infer_hierarchy_start');
      onNarration?.({
        phase: 'section_complete',
        branchIndex: 0,
        branchCount: 1,
        blocksDone: 2,
        blocksTotal: 2,
        kbGrounded: true,
        kbCitations: [{ sourceFile: 'spec.pdf', similarity: 0.62 }],
        sectionLabel: 'Display',
        sectionNodes: [
          { type: 'Requirement', title: 'HDR support', text: 'The display shall support HDR.', qualityScore: 87 },
        ],
        message: 'Finished analyzing section (section 1 of 1 -- Display) -- 1 item(s) drafted',
      } as any);
      return () => {};
    });

    renderAt('job-6');

    await waitFor(() => expect(screen.getByText(/section.*analyzed/i)).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    await userEvent.click(screen.getByText(/section.*analyzed/i));
    await userEvent.click(screen.getByText(/Section 1: Display/i));
    expect(screen.getAllByText('spec.pdf').length).toBeGreaterThan(0);
  });

  it('renders the FigureDescriptions panel from persisted figureDescriptions on a completed job, with no SSE activity at all', async () => {
    // Regression: previously the panel was fed ONLY by live SSE narration
    // (figureCaptionsByIndex), so reopening a completed job -- or reloading
    // the page -- showed nothing even though the captions had already
    // reached ADO. This must render from the job fetch alone.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-24',
      status: 'succeeded',
      mode: 'survey',
      dryRunDiff: [],
      createdAt: new Date().toISOString(),
      figureDescriptions: [{ figureIndex: 1, caption: 'A block diagram showing power distribution.' }],
    } as any);

    renderAt('job-24');

    await waitFor(() => expect(screen.getByText(/1 figure description/i)).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    await userEvent.click(screen.getByText(/1 figure description/i));
    expect(screen.getByText(/A block diagram showing power distribution\./i)).toBeInTheDocument();
  });

  it('does not add a figure to the live FigureDescriptions panel when figureCaptionStatus marks it insignificant/failed', async () => {
    // Real live bug this guards against: figureCaption is NEVER empty even
    // when the vision model judged the figure decorative/failed --
    // ingestion substitutes an honest placeholder ("this figure has no
    // discernible technical content") so the ProgressBanner ticker's
    // one-line status is never blank. A plain truthy check on figureCaption
    // alone can't tell that apart from a real caption -- confirmed live: a
    // document's own logo and warning-triangle icon, correctly judged
    // insignificant, still appeared as full entries in this panel during a
    // live run. figureCaptionStatus is the field that actually distinguishes
    // the two; only a null status should ever populate the panel.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-27', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage, onNarration) => {
      onStage('infer_hierarchy_start');
      onNarration?.({
        phase: 'describe_figure', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
        kbGrounded: false, kbCitations: [], message: 'Figure 1: A block diagram showing power distribution.',
        figureIndex: 1, figureCaption: 'A block diagram showing power distribution.', figureCaptionStatus: null,
      } as any);
      onNarration?.({
        phase: 'describe_figure', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
        kbGrounded: false, kbCitations: [], message: 'Figure 2: this figure has no discernible technical content',
        figureIndex: 2, figureCaption: 'this figure has no discernible technical content', figureCaptionStatus: 'insignificant',
      } as any);
      return () => {};
    });

    renderAt('job-27');

    await waitFor(() => expect(screen.getByText(/1 figure description/i)).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    const panelToggle = screen.getByText(/1 figure description/i);
    await userEvent.click(panelToggle);
    // Scoped to the panel itself (a sibling ProgressBanner ticker
    // legitimately still shows the placeholder text once, by design -- see
    // figureCaptionStatus's own docstring) -- only the panel's OWN list must
    // exclude the insignificant figure.
    const panel = panelToggle.closest('button')!.parentElement as HTMLElement;
    expect(within(panel).getByText(/A block diagram showing power distribution\./i)).toBeInTheDocument();
    expect(within(panel).queryByText(/this figure has no discernible technical content/i)).not.toBeInTheDocument();
  });

  it('does not add a figure to the FigureDescriptions panel via durable event-history backfill either, when figureCaptionStatus marks it insignificant/failed', async () => {
    // SEPARATE population site from the live SSE test above -- a first pass
    // at that fix only covered the live onNarration handler, missing this
    // history-backfill effect (JobDetail.tsx populates figureCaptionsByIndex
    // from getEventHistory too, since that fetch runs on every job page
    // mount regardless of live/reconnect state -- confirmed live: an
    // insignificant figure still leaked into the panel via exactly this
    // path even after the live-handler fix landed). Needs the same guard
    // independently, not a shared helper -- this asserts it directly.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-32', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
    } as any);
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([
      {
        id: 'evt-1', jobId: 'job-32', phase: 'describe_figure', severity: 'info', createdAt: new Date().toISOString(),
        message: 'Figure 1: A block diagram showing power distribution.',
        detail: {
          phase: 'describe_figure', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
          kbGrounded: false, kbCitations: [], message: 'Figure 1: A block diagram showing power distribution.',
          figureIndex: 1, figureCaption: 'A block diagram showing power distribution.', figureCaptionStatus: null,
        },
      },
      {
        id: 'evt-2', jobId: 'job-32', phase: 'describe_figure', severity: 'info', createdAt: new Date().toISOString(),
        message: 'Figure 2: this figure has no discernible technical content',
        detail: {
          phase: 'describe_figure', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
          kbGrounded: false, kbCitations: [], message: 'Figure 2: this figure has no discernible technical content',
          figureIndex: 2, figureCaption: 'this figure has no discernible technical content', figureCaptionStatus: 'insignificant',
        },
      },
    ] as any);

    renderAt('job-32');

    await waitFor(() => expect(screen.getByText(/1 figure description/i)).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    const panelToggle = screen.getByText(/1 figure description/i);
    await userEvent.click(panelToggle);
    const panel = panelToggle.closest('button')!.parentElement as HTMLElement;
    expect(within(panel).getByText(/A block diagram showing power distribution\./i)).toBeInTheDocument();
    expect(within(panel).queryByText(/this figure has no discernible technical content/i)).not.toBeInTheDocument();
  });

  it('shows an excluded-as-decorative summary line when excludedFigureIds/excludedTableIds are non-empty', async () => {
    // B5: first frontend consumer of B4's excludedFigureIds/excludedTableIds
    // fields. Phrased as a real count ("N excluded as decorative"), not an
    // exhaustive accounting -- see jobsStore.JobDetail's own comment.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-28',
      status: 'succeeded',
      mode: 'survey',
      dryRunDiff: [],
      createdAt: new Date().toISOString(),
      excludedFigureIds: ['f0', 'f1'],
      excludedTableIds: ['t0'],
    } as any);

    renderAt('job-28');

    await waitFor(() => expect(screen.getByText(/2 figures and 1 table excluded as decorative/i)).toBeInTheDocument());
  });

  it('renders no excluded-count line at all when excludedFigureIds/excludedTableIds are both empty', async () => {
    // Must be absent entirely, not a "0 excluded" line -- a genuinely empty
    // list is not itself a fact worth stating on every job's page.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-29',
      status: 'succeeded',
      mode: 'survey',
      dryRunDiff: [],
      createdAt: new Date().toISOString(),
      excludedFigureIds: [],
      excludedTableIds: [],
    } as any);

    renderAt('job-29');

    await waitFor(() => expect(screen.getByText('Diff (0)')).toBeInTheDocument());
    expect(screen.queryByText(/excluded as decorative/i)).not.toBeInTheDocument();
  });

  it('hydrates a still-running job\'s live surfaces from durable event-history, not just the live SSE tail', async () => {
    // Regression this guards against (ui-progress-review.md #4): the
    // event-history fetch used to be gated to terminal statuses only, so
    // reconnecting to (or refreshing) a STILL-RUNNING job's page showed
    // only whatever the live SSE tail happened to replay -- everything from
    // before the reconnect looked lost, even though it was always durably
    // stored server-side. Asserted via the ticker/ProgressBanner headline
    // (mergedNarrations.at(-1) drives both) now that the raw activity-log
    // list DESIGN.md §11.3 says to remove is gone -- the underlying
    // history+live merge this test protects is unchanged.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-30', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
    } as any);
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([
      {
        id: 'evt-1', jobId: 'job-30', phase: 'table_detected', severity: 'info', createdAt: new Date().toISOString(),
        message: 'Detected a table t0 -- a historical entry from before this reconnect',
        detail: {
          phase: 'table_detected', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
          kbGrounded: false, kbCitations: [],
          message: 'Detected a table t0 -- a historical entry from before this reconnect',
        },
      },
    ] as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
      onStage('infer_hierarchy_start');
      return () => {};
    });

    renderAt('job-30');

    await waitFor(() => expect(jobsApi.getEventHistory).toHaveBeenCalledWith('job-30'));
    expect(await screen.findByText(/a historical entry from before this reconnect/i)).toBeInTheDocument();
  });

  it('does not duplicate a narration entry that arrives both in history and live', async () => {
    // A historical entry already represented in the live tail (the common
    // case: the history fetch and an in-flight SSE connection cover
    // overlapping recent time) must be merged once, not twice. No longer
    // observable via a raw activity-log row count (DESIGN.md §11.3 removed
    // that list) -- a real duplicate in mergedNarrations would still only
    // ever surface via .at(-1) in the ticker/ProgressBanner headline, so
    // this asserts the visible occurrence count stays small (ticker +
    // ProgressBanner's own headline, never a growing count from a
    // duplicated array entry).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-31', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
    } as any);
    const sharedMessage = 'Preparing analysis -- splitting sections, retrieving context';
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([
      {
        id: 'evt-1', jobId: 'job-31', phase: 'preparing_analysis', severity: 'info', createdAt: new Date().toISOString(),
        message: sharedMessage,
        detail: {
          phase: 'preparing_analysis', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
          kbGrounded: false, kbCitations: [], message: sharedMessage,
        },
      },
    ] as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage, onNarration) => {
      onStage('infer_hierarchy_start');
      onNarration?.({
        phase: 'preparing_analysis', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
        kbGrounded: false, kbCitations: [], message: sharedMessage,
      } as any);
      return () => {};
    });

    renderAt('job-31');

    await waitFor(() => expect(jobsApi.getEventHistory).toHaveBeenCalledWith('job-31'));
    await screen.findByText(sharedMessage);
    expect(screen.getAllByText(sharedMessage).length).toBeLessThanOrEqual(2);
  });

  it('omits the FigureDescriptions panel entirely when the job has no persisted figure captions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-25', status: 'succeeded', mode: 'baseline', dryRunDiff: [], createdAt: new Date().toISOString(),
    } as any);

    renderAt('job-25');

    await waitFor(() => expect(screen.getByRole('tab', { name: /diff/i })).toBeInTheDocument());
    expect(screen.queryByText(/figure description/i)).not.toBeInTheDocument();
  });

  it('refetches the real work-item-type catalog when the SSE stream reaches diff_ready, not just status/diff', async () => {
    // Regression: the mount-time fetch happens while the job is still
    // running, when the backend's own catalog-resolve gate (dryRunDiff !=
    // null) is false -- it always returns {}. The diff_ready refetch
    // previously applied status/dryRunDiff but dropped workItemTypeCatalog
    // on the floor, leaving every WorkItemTypeBadge on its hardcoded
    // fallback icon for the rest of the page's lifetime.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob')
      .mockResolvedValueOnce({ id: 'job-26', status: 'running', mode: 'baseline', dryRunDiff: null } as any)
      .mockResolvedValueOnce({
        id: 'job-26',
        status: 'diff_ready',
        dryRunDiff: [
          { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Root', description: '', action: 'create', customerId: null, tags: [] },
        ],
        workItemTypeCatalog: { Requirement: { color: '#009CCC', iconDataUrl: 'data:image/svg+xml;base64,AAA' } },
      } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
      onStage('diff_ready');
      return () => {};
    });

    const { container } = renderAt('job-26');

    await waitFor(() => expect(screen.getByText('Root')).toBeInTheDocument());
    // A real catalog entry renders an <img> icon; the fallback renders an
    // inline SVG icon component instead -- no <img> at all.
    await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument());
  });

  it('refetches warnings and kbCitations when the SSE stream reaches diff_ready, not just status/diff/typeCatalog', async () => {
    // Real bug (user-reported): the mount-time fetch runs while the job is
    // still running, when warnings/kbCitations are still empty on the Job
    // row -- both are written by the SAME pipeline.worker.ts update that
    // sets dryRunDiff/status/workItemTypeCatalog once the job reaches
    // diff_ready. The diff_ready refetch above already re-applies
    // dryRunDiff/typeCatalog but previously dropped warnings/kbCitations on
    // the floor, so the integrity warnings panel stayed empty until the
    // user manually reloaded the page.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob')
      .mockResolvedValueOnce({ id: 'job-27', status: 'running', mode: 'survey', dryRunDiff: null, warnings: [] } as any)
      .mockResolvedValueOnce({
        id: 'job-27',
        status: 'diff_ready',
        dryRunDiff: [],
        warnings: [
          { kind: 'low_grounding', severity: 'needs_review', nodeIds: [], detail: {}, raw: 'Some node has low grounding.' },
        ],
      } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
      onStage('diff_ready');
      return () => {};
    });

    renderAt('job-27');

    // The prominent warning banner and the detail panel below it both
    // legitimately say this now -- getAllByText tolerates that expected
    // duplication (same convention ProgressBanner's own tests already use).
    await waitFor(() => expect(screen.getAllByText(/1 integrity warning/i).length).toBeGreaterThan(0));
  });

  it('gates the Confirm button on diff_ready status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }),
    );
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-3', status: 'running', dryRunDiff: null } as any);
    renderAt('job-3');
    await waitFor(() => expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument());
  });

  it('bulk-excludes only rows matching the current text filter, sequentially (not concurrently)', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-6',
      status: 'diff_ready',
      dryRunDiff: [
        { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Match one', description: '', action: 'create', customerId: null, tags: [] },
        { localId: 'b', parentLocalId: null, type: 'Requirement', title: 'Match two', description: '', action: 'create', customerId: null, tags: [] },
        { localId: 'c', parentLocalId: null, type: 'Requirement', title: 'No hit', description: '', action: 'create', customerId: null, tags: [] },
      ],
    } as any);
    const excludeSpy = vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(async (_id, localId) => ({
      dryRunDiff: [
        { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Match one', description: '', action: 'create', customerId: null, tags: [], excluded: localId === 'a' },
        { localId: 'b', parentLocalId: null, type: 'Requirement', title: 'Match two', description: '', action: 'create', customerId: null, tags: [], excluded: localId === 'b' },
        { localId: 'c', parentLocalId: null, type: 'Requirement', title: 'No hit', description: '', action: 'create', customerId: null, tags: [] },
      ],
    }));

    renderAt('job-6');
    await waitFor(() => expect(screen.getByText('Match one')).toBeInTheDocument());

    const userEventModule = await import('@testing-library/user-event');
    const userEvent = userEventModule.default;
    await userEvent.type(screen.getByPlaceholderText(/filter by title/i), 'Match');
    await userEvent.click(screen.getByRole('button', { name: /^exclude matching$/i }));

    await waitFor(() => expect(excludeSpy).toHaveBeenCalledTimes(2));
    expect(excludeSpy).toHaveBeenCalledWith('job-6', 'a', true);
    expect(excludeSpy).toHaveBeenCalledWith('job-6', 'b', true);
    expect(excludeSpy).not.toHaveBeenCalledWith('job-6', 'c', true);
  });

  it('bulk-excludes only flagged rows when the "Needs review" filter is active, ignoring the rest of the diff', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-41',
      status: 'diff_ready',
      dryRunDiff: [
        {
          localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Flagged one', description: '',
          action: 'create', customerId: null, tags: [], groundingScore: 0.1,
        },
        {
          localId: 'b', parentLocalId: null, type: 'Requirement', title: 'Flagged two', description: '',
          action: 'create', customerId: null, tags: [], groundingScore: 0.05,
        },
        {
          localId: 'c', parentLocalId: null, type: 'Requirement', title: 'Healthy one', description: '',
          action: 'create', customerId: null, tags: [], groundingScore: 0.9,
        },
      ],
    } as any);
    const excludeSpy = vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(async (_id, localId) => ({
      dryRunDiff: [
        { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Flagged one', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.1, excluded: localId === 'a' },
        { localId: 'b', parentLocalId: null, type: 'Requirement', title: 'Flagged two', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.05, excluded: localId === 'b' },
        { localId: 'c', parentLocalId: null, type: 'Requirement', title: 'Healthy one', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.9 },
      ],
    }));

    renderAt('job-41');
    await waitFor(() => expect(screen.getByText('Flagged one')).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /needs review/i }));
    await userEvent.click(screen.getByRole('button', { name: /^exclude matching$/i }));

    await waitFor(() => expect(excludeSpy).toHaveBeenCalledTimes(2));
    expect(excludeSpy).toHaveBeenCalledWith('job-41', 'a', true);
    expect(excludeSpy).toHaveBeenCalledWith('job-41', 'b', true);
    expect(excludeSpy).not.toHaveBeenCalledWith('job-41', 'c', true);
  });

  it('shows an error toast when toggling exclude fails, instead of failing silently', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-9',
      status: 'diff_ready',
      dryRunDiff: [
        { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Row one', description: '', action: 'create', customerId: null, tags: [] },
      ],
    } as any);
    vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockRejectedValue(new Error('network error'));

    renderAt('job-9');
    await waitFor(() => expect(screen.getByText('Row one')).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('checkbox', { name: /exclude row one/i }));

    // findByText's own timeout, not the global asyncUtilTimeout (setup.ts) --
    // that default is deliberately kept under ToastProvider's 4400ms
    // auto-dismiss so a toast that appears fast can't be watched
    // disappearing before the assertion checks (confirmed live as a real
    // race this session). This click-to-toast path has no such ceiling:
    // setDiffEntryExcluded rejects immediately (no artificial delay in the
    // mock), so the toast's own 4400ms clock only starts once it actually
    // mounts -- widening just the "does it ever appear" wait here, for this
    // one assertion, adds real headroom against CI contention delaying the
    // click's own re-render without reintroducing that race anywhere else.
    await screen.findByText(/failed to update/i, {}, { timeout: 8000 });
  });

  // SWEEP.md §10 final-review fix: the backend (JobsService.getSummary/
  // BatchService.getBatch) already excludes excluded entries from the
  // created/reused/dedupSkipped counts, but the frontend only fetched
  // getSummary once on mount ([id, status] effect above) and never again --
  // so the confirm dialog's "This creates N new work item(s)" and these
  // stat tiles kept showing the stale pre-exclusion count until a full
  // remount. handleToggleExclude now refetches getSummary right after its
  // setDiff call succeeds, inside the same isDiffMutatingRef-guarded try.
  it('refetches the summary after toggling an exclusion, so the stat tiles reflect the new post-exclusion count', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-77',
      status: 'diff_ready',
      dryRunDiff: [
        { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Row one', description: '', action: 'create', customerId: null, tags: [] },
      ],
    } as any);
    // First call is the mount-time [id, status] effect; second is the
    // refetch handleToggleExclude triggers after the exclusion succeeds.
    vi.spyOn(jobsApi, 'getSummary')
      .mockResolvedValueOnce({ created: 5, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] })
      .mockResolvedValueOnce({ created: 2, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockResolvedValue({
      dryRunDiff: [
        { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Row one', description: '', action: 'create', customerId: null, tags: [], excluded: true },
      ],
    } as any);

    // "New" also matches a QualityBadge pill rendered elsewhere on the page
    // -- narrow to the StatTile's own <p> label (its value is the previous
    // sibling <p>, per StatTile.tsx's markup).
    function newTileValue(): string | null | undefined {
      return screen.getAllByText('New').find((el) => el.tagName === 'P')?.previousElementSibling?.textContent;
    }

    renderAt('job-77');
    await waitFor(() => expect(screen.getByText('Row one')).toBeInTheDocument());
    // Pre-exclusion count from the mount-time fetch.
    await waitFor(() => expect(newTileValue()).toBe('5'));

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('checkbox', { name: /exclude row one/i }));

    // Post-exclusion count from the refetch -- proves handleToggleExclude
    // re-read getSummary rather than leaving the stale mount-time value.
    await waitFor(() => expect(newTileValue()).toBe('2'));
    expect(jobsApi.getSummary).toHaveBeenCalledTimes(2);
  });

  it('shows an error toast reporting partial progress when bulk-exclude fails mid-loop', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-10',
      status: 'diff_ready',
      dryRunDiff: [
        { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Match one', description: '', action: 'create', customerId: null, tags: [] },
        { localId: 'b', parentLocalId: null, type: 'Requirement', title: 'Match two', description: '', action: 'create', customerId: null, tags: [] },
      ],
    } as any);
    vi.spyOn(jobsApi, 'setDiffEntryExcluded')
      .mockResolvedValueOnce({
        dryRunDiff: [
          { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Match one', description: '', action: 'create', customerId: null, tags: [], excluded: true },
          { localId: 'b', parentLocalId: null, type: 'Requirement', title: 'Match two', description: '', action: 'create', customerId: null, tags: [] },
        ],
      } as any)
      .mockRejectedValueOnce(new Error('network error'));

    renderAt('job-10');
    await waitFor(() => expect(screen.getByText('Match one')).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^exclude all$/i }));

    await waitFor(() => expect(screen.getByText(/stopped after updating 1 of 2 item/i)).toBeInTheDocument());
  });

  it('shows Cancel run for a pending/running job, and cancelling it updates status via ConfirmDialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-7', status: 'running', dryRunDiff: null } as any);
    const cancelSpy = vi.spyOn(jobsApi, 'cancelJob').mockResolvedValue({ status: 'cancelled' });

    renderAt('job-7');
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel run/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /cancel run/i }));
    await userEvent.click(screen.getByRole('button', { name: /^cancel run$/i, hidden: false }));

    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith('job-7'));
    // getAllByText tolerates expected duplication -- the StatusChip AND the
    // no-diff-produced EmptyState fallback (this job never reached
    // diff_ready) both now say "cancelled" somewhere in their text.
    await waitFor(() => expect(screen.getAllByText(/cancelled/i).length).toBeGreaterThan(0));
  });

  it('deletes a diff_ready job and navigates back to the jobs list on success', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-11', status: 'diff_ready', dryRunDiff: [] } as any);
    const deleteSpy = vi.spyOn(jobsApi, 'deleteJob').mockResolvedValue({ deleted: true });

    renderAt('job-11');
    await waitFor(() => expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^delete job$/i }));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('job-11'));
  });

  it('resubmits a diff_ready job and navigates to the newly created job', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-14', status: 'diff_ready', dryRunDiff: [] } as any);
    const resubmitSpy = vi.spyOn(jobsApi, 'resubmitJob').mockResolvedValue({ jobId: 'job-15' });

    renderAt('job-14');
    await waitFor(() => expect(screen.getByRole('button', { name: /^resubmit$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^resubmit$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^resubmit$/i, hidden: false }));

    await waitFor(() => expect(resubmitSpy).toHaveBeenCalledWith('job-14'));
  });

  it('shows an explanatory error when resubmit fails (e.g. source file was not retained)', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-16', status: 'diff_ready', dryRunDiff: [] } as any);
    vi.spyOn(jobsApi, 'resubmitJob').mockRejectedValue(new Error('404'));

    renderAt('job-16');
    await waitFor(() => expect(screen.getByRole('button', { name: /^resubmit$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^resubmit$/i }));
    const dialogButtons = screen.getAllByRole('button', { name: /^resubmit$/i });
    await userEvent.click(dialogButtons[dialogButtons.length - 1]);

    await waitFor(() => expect(screen.getByText(/resubmit failed/i)).toBeInTheDocument());
  });

  it('does not offer Delete while a job is pending or running', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-12', status: 'running', dryRunDiff: null } as any);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));

    renderAt('job-12');
    await waitFor(() => expect(screen.getByText(/running/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('shows an error toast when delete fails, and does not navigate away', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-13', status: 'diff_ready', dryRunDiff: [] } as any);
    vi.spyOn(jobsApi, 'deleteJob').mockRejectedValue(new Error('network error'));

    renderAt('job-13');
    await waitFor(() => expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^delete job$/i }));

    await waitFor(() => expect(screen.getByText(/delete failed/i)).toBeInTheDocument());
  });

  it('does not show Cancel run once a job has reached diff_ready', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-8', status: 'diff_ready', dryRunDiff: [] } as any);
    renderAt('job-8');
    await waitFor(() => expect(screen.getByText(/diff \(0\)/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument();
  });

  it('shows a queued indicator while the job is pending, before the worker picks it up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-9', status: 'pending', dryRunDiff: null } as any);
    renderAt('job-9');
    await waitFor(() => expect(screen.getByText(/queued/i)).toBeInTheDocument());
  });

  it('shows a success toast with the created count after Confirm succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob')
      .mockResolvedValueOnce({ id: 'job-10', status: 'diff_ready', dryRunDiff: [], areaPath: 'Project\\Area1' } as any)
      .mockResolvedValueOnce({ id: 'job-10', status: 'succeeded', dryRunDiff: [] } as any);
    vi.spyOn(jobsApi, 'confirmJob').mockResolvedValue({ status: 'succeeded', createdCount: 3 });
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');

    renderAt('job-10');
    await waitFor(() => expect(screen.getByRole('button', { name: /^confirm$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    // The confirm-to-ADO dialog is irreversible -- its Confirm button stays
    // disabled until the acknowledgement checkbox is ticked (DESIGN.md §7/§8).
    await userEvent.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm and write/i }));

    await waitFor(() => expect(screen.getByText(/confirmed — 3 work item\(s\) written/i)).toBeInTheDocument());
  });

  it('shows a success toast after Reject succeeds', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-11', status: 'diff_ready', dryRunDiff: [] } as any);
    vi.spyOn(jobsApi, 'rejectJob').mockResolvedValue({ status: 'rejected' });

    renderAt('job-11');
    await waitFor(() => expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^reject job$/i }));

    await waitFor(() => expect(screen.getByText(/job rejected — nothing was written/i)).toBeInTheDocument());
  });

  it('shows an error state with Retry when the job fetch fails, and recovers on retry', async () => {
    const getJobSpy = vi.spyOn(jobsApi, 'getJob').mockRejectedValueOnce(new Error('network error'));
    renderAt('job-5');

    await waitFor(() => expect(screen.getByText(/couldn't load this job/i)).toBeInTheDocument());

    getJobSpy.mockResolvedValueOnce({ id: 'job-5', status: 'diff_ready', dryRunDiff: [], areaPath: null } as any);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByText(/couldn't load this job/i)).not.toBeInTheDocument());
    expect(screen.getByText(/diff \(0\)/i)).toBeInTheDocument();
  });

  describe('Document overview', () => {
    it('renders the Document overview card for a SURVEY job with a real documentOverview', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-50',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [],
        documentOverview: { synopsis: 'About a backplane.', caveat: null },
      } as any);
      renderAt('job-50');
      expect(await screen.findByText('About a backplane.')).toBeInTheDocument();
    });

    it('renders nothing for a SURVEY job whose exposition generation failed (documentOverview null)', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-51',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [],
        documentOverview: null,
      } as any);
      renderAt('job-51');
      await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
      expect(screen.queryByText(/document overview/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/isn.t produced for baseline/i)).not.toBeInTheDocument();
    });

    it('renders an explicit absence note for a BASELINE job, never the card', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-52',
        status: 'diff_ready',
        mode: 'baseline',
        dryRunDiff: [],
        documentOverview: null,
      } as any);
      renderAt('job-52');
      expect(await screen.findByText(/isn.t produced for baseline jobs/i)).toBeInTheDocument();
    });
  });

  // CR: reparent -- real user feedback after deploying: "where is the
  // workitem creation?" -- there was no entry point to create a new item
  // with no anchor node at all (e.g. a first top-level Epic). Reuses
  // AddChildCard/AddChildForm with no parentEntry, SURVEY mode only (see
  // AddChildForm.tsx's own doc comment for why BASELINE has no
  // anchor-independent type model).
  describe('the tree toolbar "+ New item" entry point', () => {
    it('renders for a SURVEY job at diff_ready, and creates a root-level item via addDiffEntry', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-40',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [],
      } as any);
      vi.mocked(jobsApi.addDiffEntry).mockResolvedValue({
        dryRunDiff: [{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'New Epic', description: 'd', action: 'create', customerId: null }],
      });
      renderAt('job-40');
      await waitFor(() => expect(screen.getByRole('button', { name: /^new item$/i })).toBeInTheDocument());

      const { default: userEvent } = await import('@testing-library/user-event');
      await userEvent.click(screen.getByRole('button', { name: /^new item$/i }));
      await userEvent.type(screen.getByLabelText(/title/i), 'New Epic');
      await userEvent.type(screen.getByLabelText(/description/i), 'd');
      await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => expect(jobsApi.addDiffEntry).toHaveBeenCalledWith('job-40', { parentLocalId: null, type: 'Epic', title: 'New Epic', description: 'd' }));
      expect(await screen.findByText('New Epic')).toBeInTheDocument();
    });

    // Guard added alongside handleToggleExclude/handleBulkExclude/
    // handleMoveEntry's own isDiffMutatingRef re-entry guard
    // (JobDetail.tsx, 779-856) -- handleAddChild had none, so re-opening
    // "New item" and clicking Add again before the first addDiffEntry
    // request settles (AddChildCard's onAdd wrapper collapses the form
    // immediately, regardless of the request's outcome -- see
    // AddChildCard.tsx) could create two items. The never-resolving mock
    // isolates the still-in-flight window, same technique
    // JobDetail.optimisticMove.test.tsx already uses for moveDiffEntry.
    it('blocks a second handleAddChild call while the first add is still in flight', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-43',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [],
      } as any);
      // mockClear isolates the call-count assertion below from the earlier
      // "creates a root-level item via addDiffEntry" test in this same
      // describe block -- see the mockClear comment on the handleSaveEdit
      // guard test above for why this file needs it here.
      vi.mocked(jobsApi.addDiffEntry).mockClear().mockReturnValue(new Promise(() => {}));
      renderAt('job-43');
      await waitFor(() => expect(screen.getByRole('button', { name: /^new item$/i })).toBeInTheDocument());

      const { default: userEvent } = await import('@testing-library/user-event');
      await userEvent.click(screen.getByRole('button', { name: /^new item$/i }));
      await userEvent.type(screen.getByLabelText(/title/i), 'First Epic');
      await userEvent.type(screen.getByLabelText(/description/i), 'd');
      await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

      // The form collapses immediately after Add, so reopening it and
      // submitting again is reachable through the same UI -- the guard,
      // not the UI, must block the second underlying call. findByRole (async)
      // for the same reason as the handleSaveEdit guard test above: the
      // form-collapse re-render may not have committed on a slow CI runner.
      await userEvent.click(await screen.findByRole('button', { name: /^new item$/i }));
      await userEvent.type(screen.getByLabelText(/title/i), 'Second Epic');
      await userEvent.type(screen.getByLabelText(/description/i), 'd');
      await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

      expect(jobsApi.addDiffEntry).toHaveBeenCalledTimes(1);
      // Same silent-skip gap as handleSaveEdit's guard test above.
      await waitFor(() => expect(screen.getByText(/another change is still saving/i)).toBeInTheDocument());
    });

    it('does not render for a BASELINE job -- no anchor-independent type model', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-41',
        status: 'diff_ready',
        mode: 'baseline',
        dryRunDiff: [{ localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Row one', description: '', action: 'create', customerId: null, tags: [] }],
      } as any);
      renderAt('job-41');
      await waitFor(() => expect(screen.getByText('Row one')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /^new item$/i })).not.toBeInTheDocument();
    });

    it('does not render once the job is no longer diff_ready', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-42',
        status: 'succeeded',
        mode: 'survey',
        dryRunDiff: [{ localId: 'a', parentLocalId: null, type: 'Epic', title: 'Row one', description: '', action: 'create', customerId: null, tags: [] }],
      } as any);
      renderAt('job-42');
      await waitFor(() => expect(screen.getByText('Row one')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /^new item$/i })).not.toBeInTheDocument();
    });
  });

  describe('state-driven layout (DESIGN.md Track B, phase B7)', () => {
    it('renders no tabs and no filter textbox while running -- no dead space for a job still parsing/analyzing', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-20', status: 'running', dryRunDiff: null } as any);
      renderAt('job-20');
      await waitFor(() => expect(screen.getByRole('button', { name: /cancel run/i })).toBeInTheDocument());
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/filter by title/i)).not.toBeInTheDocument();
    });

    it('renders only the progress header while pending -- no tabs, no tiles, no filter bar', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-21', status: 'pending', dryRunDiff: null } as any);
      renderAt('job-21');
      await waitFor(() => expect(screen.getByText(/queued/i)).toBeInTheDocument());
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/filter by title/i)).not.toBeInTheDocument();
      expect(screen.queryByText('New')).not.toBeInTheDocument();
    });

    it('does not render the "Cancelled before a diff was produced" panel while a job is actually running', async () => {
      // Real bug this guards against (confirmed live): shouldShowTabs
      // returns false for a running job too, before its first diff/audit
      // fetch (diff.length and audit.length both still 0 at that point) --
      // not just cancelled/failed. Without the isRunDetailStatus guard, a
      // job actively ticking through Analyze in the live ProgressBanner
      // ALSO rendered "Cancelled before a diff was produced" underneath it
      // at the same time -- a running job simultaneously showing
      // cancelled-state UI.
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-running-no-diff', status: 'running', mode: 'survey', dryRunDiff: null,
      } as any);
      renderAt('job-running-no-diff');
      await waitFor(() => expect(screen.getAllByText(/running/i).length).toBeGreaterThan(0));
      expect(screen.queryByText('Cancelled before a diff was produced')).not.toBeInTheDocument();
      expect(screen.queryByText('No diff was produced')).not.toBeInTheDocument();
    });

    it('renders tabs and tiles, but no run-detail panel, once diff_ready', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-22',
        status: 'diff_ready',
        areaPath: 'Project\\Area1',
        dryRunDiff: [{ localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Row one', description: '', action: 'create', customerId: null, tags: [] }],
      } as any);
      renderAt('job-22');
      await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
      // "New" also matches the filter Select's <option> -- getAllByText
      // tolerates that expected duplication (the StatTile label is the
      // second match). The stat tiles come from a SEPARATE getSummary
      // effect/promise chain than the tablist (fed by getJob) -- waiting
      // only for the tablist and then asserting synchronously left a real
      // gap where the tiles hadn't rendered yet, confirmed live (CI-only,
      // never reproduced locally): "New" matched only the Select option,
      // not yet the tile.
      await waitFor(() => expect(screen.getAllByText('New').length).toBeGreaterThan(1));
      // ProgressBanner (the RunDetail panel) only ever renders for
      // running/writing -- diff_ready is a human decision point, not a
      // running process.
      expect(screen.queryByText(/you can close this page/i)).not.toBeInTheDocument();
    });

    it('renders the frozen stepper and the no-diff-produced fallback for a failed job, folded into the main tree', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-23', status: 'failed', mode: 'survey', dryRunDiff: null } as any);
      renderAt('job-23');
      // The old dedicated "Job Failed" early-return screen is gone -- this
      // now goes through the SAME JobLifecycleSteps + NarrationTicker every
      // other status does, plus the no-diff EmptyState fallback (no tabs,
      // since a failed job never reached diff_ready).
      await waitFor(() => expect(screen.getByText('No diff was produced')).toBeInTheDocument());
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /view audit/i })).toBeInTheDocument();
    });

    it('renders the Write step as skipped, not pending, for a rejected job', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-24',
        status: 'rejected',
        mode: 'survey',
        dryRunDiff: [{ localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Row one', description: '', action: 'create', customerId: null, tags: [] }],
      } as any);
      renderAt('job-24');
      await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
      const writeStep = screen.getByText('Write').closest('li')?.querySelector('[data-state]');
      expect(writeStep).toHaveAttribute('data-state', 'skipped');
    });
  });
});
