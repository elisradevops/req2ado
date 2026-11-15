import { usePageLabelStore } from '../store/pageLabelStore';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { JobDetail } from './JobDetail';
import { ToastProvider } from '../components/ToastProvider';
import * as jobsApi from '../api/jobs';
import { useAuthStore } from '../store/authStore';

// An item that still blocks the write is decided by the deliberate "Keep as written and next" button (A and R do nothing on it, DESIGN.md
// §11.3.6); any other item is decided with the key. One helper, so a test says "mark the open item" and gets the right gesture.
async function pressMark(user: { click: (el: Element) => Promise<void>; keyboard: (keys: string) => Promise<void> }): Promise<void> {
  const keep = screen.queryByRole('button', { name: 'Keep as written and next' });
  if (keep) await user.click(keep);
  else await user.keyboard('a');
}

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
// A running job calls loadRuntimeConfig(), whose relative fetch('/config.json') cannot resolve in Node and
// surfaced as an unhandled rejection that made the whole run exit 1.
vi.mock('../api/config', () => ({
  loadRuntimeConfig: vi.fn().mockResolvedValue({ apiBaseUrl: 'http://localhost' }),
}));
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

/**
 * Opens a tree node's detail dialog. A single click can be lost on a loaded CI runner (failed CI runs show the row
 * unselected and no dialog, i.e. the page never saw the click), and no wait helps a click that did not happen. So the
 * click is repeated until the dialog is there.
 */
async function openNodeDetails(
  userEvent: { click: (element: Element) => Promise<void> },
  label: string | RegExp,
): Promise<void> {
  await waitFor(
    async () => {
      if (!screen.queryByRole('dialog')) await userEvent.click(screen.getByText(label));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    },
    { timeout: 8000 },
  );
}

/**
 * Clicks an element until the call it should cause has been made. Same lost-click cause as openNodeDetails: a click
 * that the page never saw cannot be waited for. Stops at the first processed click, so a checkbox is never toggled twice.
 */
async function clickUntilCalled(
  userEvent: { click: (element: Element) => Promise<void> },
  find: () => Element,
  spy: { mock: { calls: unknown[] } },
): Promise<void> {
  await waitFor(
    async () => {
      if (spy.mock.calls.length === 0) await userEvent.click(find());
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    },
    { timeout: 8000 },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

type PreviewCounts = { createdTotal: number; parentLinks: number; figuresToAttach: number; traceLinks: { planned: number } };
function withServerFlags<T extends PreviewCounts>(preview: T): T & { hasWork: boolean; figuresOnly: boolean } {
  const noOtherWork = preview.createdTotal === 0 && preview.parentLinks === 0 && preview.traceLinks.planned === 0;
  return { ...preview, hasWork: !noOtherWork || preview.figuresToAttach > 0, figuresOnly: noOtherWork && preview.figuresToAttach > 0 };
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
    await openNodeDetails(userEvent, 'Root');
    expect(await screen.findAllByText('Root')).not.toHaveLength(0);
  });

  describe('proposal review gate (P9d)', () => {
    const proposal = { kind: 'criteria' as const, html: '<div data-r2a="criteria"><p><b>Proposed acceptance criteria</b></p><ul><li>Given X then Y</li></ul></div>' };
    const entry = { localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [], proposal };

    async function openEntry(jobId: string) {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: jobId, status: 'diff_ready', dryRunDiff: [entry] } as any);
      const chatApi = await import('../api/chat');
      vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
      vi.mocked(chatApi.listModels).mockResolvedValue([]);
      renderAt(jobId);
      await waitFor(() => expect(screen.getByText('Req Title')).toBeInTheDocument());
      const { default: userEvent } = await import('@testing-library/user-event');
      await openNodeDetails(userEvent, 'Req Title');
      return userEvent;
    }

    it('accepting a proposal calls the API and shows the accepted state from the server reply', async () => {
      const accept = vi.spyOn(jobsApi, 'setProposalAccepted').mockResolvedValue({ dryRunDiff: [{ ...entry, proposalAccepted: true }] });
      const userEvent = await openEntry('job-p9d-1');
      await userEvent.click(await screen.findByRole('button', { name: /accept criteria/i }));
      await waitFor(() => expect(accept).toHaveBeenCalledWith('job-p9d-1', 'e1', true));
      expect(await screen.findByText(/will be written to azure devops/i)).toBeInTheDocument();
    });

    it('shows an error toast and keeps the proposal unaccepted when the request fails', async () => {
      vi.spyOn(jobsApi, 'setProposalAccepted').mockRejectedValue(new Error('network error'));
      const userEvent = await openEntry('job-p9d-2');
      await userEvent.click(await screen.findByRole('button', { name: /accept criteria/i }));
      await waitFor(() => expect(screen.getByText(/failed to update the proposal/i)).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /accept criteria/i })).toBeInTheDocument();
    });
  });

  describe('moving a figure', () => {
    const entries = [
      { localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req One', description: 'd', action: 'create', customerId: null, tags: [], figureIds: ['f0'], attachFigureIds: ['f0'] },
      { localId: 'e2', parentLocalId: null, type: 'Requirement', title: 'Req Two', description: 'd', action: 'create', customerId: null, tags: [], attachFigureIds: [] },
    ];
    async function openFigureEntry(jobId: string) {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: jobId, status: 'diff_ready', dryRunDiff: entries } as any);
      const chatApi = await import('../api/chat');
      vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
      vi.mocked(chatApi.listModels).mockResolvedValue([]);
      renderAt(jobId);
      await waitFor(() => expect(screen.getByText('Req One')).toBeInTheDocument());
      const { default: userEvent } = await import('@testing-library/user-event');
      await openNodeDetails(userEvent, 'Req One');
      return userEvent;
    }

    it('moving a figure updates the diff and shows a toast', async () => {
      const move = vi.spyOn(jobsApi, 'moveFigure').mockResolvedValue({
        dryRunDiff: [{ ...entries[0], figureIds: [], attachFigureIds: [] }, { ...entries[1], figureIds: ['f0'], attachFigureIds: ['f0'] }],
      } as any);
      const userEvent = await openFigureEntry('job-fig-1');
      await userEvent.click(await screen.findByRole('button', { name: /^Move to…, figure 1 of 1$/ }));
      await userEvent.click(await screen.findByRole('button', { name: /Req Two/ }));
      await waitFor(() => expect(move).toHaveBeenCalledWith('job-fig-1', 'e1', 'f0', 'e2'));
      expect(await screen.findByText('Figure moved to Req Two')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('button', { name: /^Don't attach, figure 1 of 1$/ })).not.toBeInTheDocument());
    });

    it('figureMoveTargets exclude reuse and dedup_skip entries', async () => {
      const mixed = [
        entries[0],
        entries[1],
        { localId: 'e3', parentLocalId: null, type: 'Requirement', title: 'Req Reused', description: 'd', action: 'reuse', customerId: null, tags: [] },
        { localId: 'e4', parentLocalId: null, type: 'Requirement', title: 'Req Skipped', description: 'd', action: 'dedup_skip', customerId: null, tags: [] },
      ];
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-fig-3', status: 'diff_ready', dryRunDiff: mixed } as any);
      const chatApi = await import('../api/chat');
      vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
      vi.mocked(chatApi.listModels).mockResolvedValue([]);
      renderAt('job-fig-3');
      await waitFor(() => expect(screen.getByText('Req One')).toBeInTheDocument());
      const { default: userEvent } = await import('@testing-library/user-event');
      await openNodeDetails(userEvent, 'Req One');
      await userEvent.click(await screen.findByRole('button', { name: /^Move to…, figure 1 of 1$/ }));
      expect(await screen.findByRole('button', { name: /Req Two/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Req Reused/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Req Skipped/ })).not.toBeInTheDocument();
    });

    it('a refused move shows the server message', async () => {
      vi.spyOn(jobsApi, 'moveFigure').mockRejectedValue(new Error('That item is already written'));
      const userEvent = await openFigureEntry('job-fig-2');
      await userEvent.click(await screen.findByRole('button', { name: /^Don't attach, figure 1 of 1$/ }));
      expect(await screen.findByText('Could not change the figure: That item is already written')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Don't attach, figure 1 of 1$/ })).toBeInTheDocument();
    });
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
    await openNodeDetails(userEvent, 'Req Title');

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

  it('offers one filter chip per review group with its count, and isolates that group on click', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-40',
      status: 'diff_ready',
      dryRunDiff: [
        {
          localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Loose epic', description: '',
          action: 'create', customerId: null, tags: [], groundingScore: 0.1,
        },
        {
          localId: 'e2', parentLocalId: null, type: 'Epic', title: 'Healthy epic', description: '',
          action: 'create', customerId: null, tags: [], groundingScore: 0.9,
        },
      ],
    } as any);
    renderAt('job-40');
    await waitFor(() => expect(screen.getByText('Loose epic')).toBeInTheDocument());

    // A parent with loose wording is Check; a healthy one is Structure. Groups with nothing in them are not offered.
    const check = screen.getByRole('button', { name: /^check · 1$/i });
    const structure = screen.getByRole('button', { name: /^structure · 1$/i });
    expect(screen.queryByRole('button', { name: /^fix before writing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^clean/i })).not.toBeInTheDocument();
    // A toggle says whether it is on without relying on colour (DESIGN.md §7, §13), and uses the icon set, not a text glyph (§10).
    expect(check).toHaveAttribute('aria-pressed', 'false');
    expect(check.textContent).not.toContain('⚠');
    expect(check.querySelector('svg')).not.toBeNull();
    expect(structure).toHaveAttribute('aria-pressed', 'false');

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(check);
    expect(screen.getByRole('button', { name: /^check · 1$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Loose epic')).toBeInTheDocument();
    expect(screen.queryByText('Healthy epic')).not.toBeInTheDocument();

    // Pressing it again clears the filter.
    await userEvent.click(screen.getByRole('button', { name: /^check · 1$/i }));
    expect(screen.getByText('Healthy epic')).toBeInTheDocument();
  });

  it('puts only one group filter on at a time', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-40b', status: 'diff_ready',
      dryRunDiff: [
        { localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'Loose req', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.1 },
        { localId: 'r2', parentLocalId: null, type: 'Requirement', title: 'Fine req', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.9, qualityScore: 90 },
      ],
    } as any);
    renderAt('job-40b');
    await waitFor(() => expect(screen.getByText('Loose req')).toBeInTheDocument());
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^check · 1$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^clean · 1$/i }));
    expect(screen.getByRole('button', { name: /^check · 1$/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^clean · 1$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Fine req')).toBeInTheDocument();
    expect(screen.queryByText('Loose req')).not.toBeInTheDocument();
  });

  it('offers no group filter once the job is past review (the groups are about what is left to decide)', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-40c', status: 'failed',
      dryRunDiff: [{ localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'Loose req', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.1 }],
    } as any);
    renderAt('job-40c');
    await waitFor(() => expect(screen.getByText('Loose req')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^(check|clean|structure|fix before writing)/i })).not.toBeInTheDocument();
  });

  it('names the action filter, which has no visible label', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-41',
      status: 'diff_ready',
      dryRunDiff: [
        {
          localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Flagged epic', description: '',
          action: 'create', customerId: null, tags: [], groundingScore: 0.1,
        },
      ],
    } as any);
    renderAt('job-41');
    await waitFor(() => expect(screen.getByText('Flagged epic')).toBeInTheDocument());

    expect(screen.getByRole('combobox', { name: 'Filter by action' })).toBeInTheDocument();
  });

  it('a failed job says why from the stored failure fields, trusting the stored class over the audit text', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-fs', status: 'failed', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
      failedStage: 'infer_hierarchy_start', failureClass: 'timeout', failureMessage: 'fetch failed (UND_ERR_HEADERS_TIMEOUT)',
    } as any);
    vi.spyOn(jobsApi, 'getAudit').mockResolvedValue([{ id: 'a1', message: 'Pipeline failed: ECONNRESET other side closed', createdAt: new Date().toISOString() }] as any);
    renderAt('job-fs');

    expect(await screen.findByText('A step took too long to answer.')).toBeInTheDocument();
    expect(screen.getByText('fetch failed (UND_ERR_HEADERS_TIMEOUT)')).toBeInTheDocument();
    expect(screen.queryByText('The connection was cut during the run.')).not.toBeInTheDocument();
  });

  it('a succeeded job has no review controls, counters or risk-order entry, and shows the written items', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-ws', status: 'succeeded', mode: 'survey', createdItemCount: 1, writtenLocalIds: ['r1'], writtenItems: [{ localId: 'r1', adoId: 4242 }],
      dryRunDiff: [{ localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'Written req', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.1 }],
    } as any);
    renderAt('job-ws');

    await waitFor(() => expect(screen.getByText('Written req')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /mark reviewed|mark all reviewed/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/needs review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ of \d+ reviewed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review in risk order/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(check|clean|structure|fix before writing)/i })).not.toBeInTheDocument();
    expect(screen.getByText(/4242/)).toBeInTheDocument();
  });

  describe('integrity warnings', () => {
    function epic(localId: string, title: string) {
      return { localId, parentLocalId: null, type: 'Epic', title, description: '', action: 'create', customerId: null, tags: [] };
    }

    function mockJobWithWarnings() {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-60',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [epic('e1', 'Affected one'), epic('e2', 'Affected two'), epic('e3', 'Untouched')],
        warnings: [
          { kind: 'low_grounding', severity: 'needs_review', nodeIds: ['e1', 'e2'], detail: {}, raw: '2 nodes have low grounding.' },
          { kind: 'enhancement_call_failed', severity: 'pipeline_issue', nodeIds: ['e3'], detail: {}, raw: 'Enhancement failed.' },
        ],
      } as any);
    }

    it('counts only warning types that need attention in the banner, never informational ones', async () => {
      mockJobWithWarnings();
      renderAt('job-60');

      // Two warning types, but enhancement_call_failed is informational.
      await waitFor(() => expect(screen.getByText(/1 warning needs your attention/i)).toBeInTheDocument());
    });

    it('a succeeded job with fix-group warnings shows no approval gate', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-61',
        status: 'succeeded',
        mode: 'survey',
        dryRunDiff: [epic('e1', 'Affected one')],
        warnings: [{ kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['e1'], detail: {}, raw: '1 requirement has no source reference.' }],
      } as any);
      renderAt('job-61');

      await screen.findByRole('region', { name: /integrity warnings/i });
      expect(screen.queryByTestId('approval-gate')).not.toBeInTheDocument();
      expect(screen.queryByText(/before you approve/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/fix before writing/i)).not.toBeInTheDocument();
      expect(screen.getByText('Flagged before writing (1)')).toBeInTheDocument();
    });

    it('running job keeps the default fix group title', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-61r',
        status: 'running',
        mode: 'survey',
        dryRunDiff: [epic('e1', 'Affected one')],
        warnings: [{ kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['e1'], detail: {}, raw: '1 requirement has no source reference.' }],
      } as any);
      renderAt('job-61r');

      await screen.findByRole('region', { name: /integrity warnings/i });
      expect(screen.queryByText('Flagged before writing (1)')).not.toBeInTheDocument();
    });

    it('a diff_ready job still shows the approval gate', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-62',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [epic('e1', 'Affected one')],
        warnings: [{ kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['e1'], detail: {}, raw: '1 requirement has no source reference.' }],
      } as any);
      renderAt('job-62');

      expect(await screen.findByTestId('approval-gate')).toHaveTextContent(/1 warning needs your attention before you approve/i);
      expect(screen.getByText('Fix before writing (1)')).toBeInTheDocument();
    });

    it('says "before you approve" once, inside the Integrity warnings card, with no separate banner or jump button', async () => {
      mockJobWithWarnings();
      renderAt('job-60');

      const gate = await screen.findByTestId('approval-gate');
      expect(gate).toHaveTextContent(/1 warning needs your attention before you approve/i);
      expect(within(screen.getByRole('region', { name: /integrity warnings/i })).getByTestId('approval-gate')).toBe(gate);
      expect(screen.getAllByText(/before you approve/i)).toHaveLength(1);
      expect(screen.queryByRole('button', { name: /go to warnings/i })).not.toBeInTheDocument();
    });

    it("narrows the tree to a warning's items, shows a clearable chip, and points bulk actions at that set", async () => {
      mockJobWithWarnings();
      renderAt('job-60');
      await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
      const { default: userEvent } = await import('@testing-library/user-event');

      expect(screen.getByRole('button', { name: /exclude all/i })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));

      expect(screen.getByText('Affected one')).toBeInTheDocument();
      expect(screen.getByText('Affected two')).toBeInTheDocument();
      expect(screen.queryByText('Untouched')).not.toBeInTheDocument();
      expect(screen.getByText(/Low grounding: possible fabrication:\s*2 left of 2/)).toBeInTheDocument();
      // Reason chip on the rows, so a reviewer sees why each is listed.
      expect(screen.getAllByText('Low grounding')).toHaveLength(2);
      expect(screen.getByRole('button', { name: /exclude matching/i })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /clear warning filter/i }));

      expect(screen.getByText('Untouched')).toBeInTheDocument();
      expect(screen.queryByText(/2 left of 2/)).not.toBeInTheDocument();
      expect(screen.queryAllByText('Low grounding')).toHaveLength(0);
    });

    it('shows the focused warning as the reason in the details dialog', async () => {
      mockJobWithWarnings();
      renderAt('job-60');
      await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));
      await openNodeDetails(userEvent, 'Affected one');

      const note = await screen.findByRole('note');
      expect(note).toHaveTextContent('Low grounding: possible fabrication.');
    });

    it('no mark-all-reviewed for an auto_fixed focus', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-62',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [epic('e1', 'Affected one'), epic('e2', 'Affected two')],
        warnings: [{ kind: 'parent_title_collision', severity: 'auto_fixed', nodeIds: ['e1', 'e2'], detail: {}, raw: 'Fixed.' }],
      } as any);
      renderAt('job-62');
      fireEvent.click(await screen.findByRole('button', { name: /for your information/i })); // an informational group starts collapsed
      const { default: userEvent } = await import('@testing-library/user-event');
      await screen.findByRole('region', { name: /integrity warnings/i });
      // The informational group is the only one, so it is open already.
      await userEvent.click(await screen.findByRole('button', { name: 'Show in tree' }));
      await screen.findByText('Affected one');
      expect(screen.queryByRole('button', { name: 'Mark all reviewed' })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Hide reviewed' })).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+ left/)).not.toBeInTheDocument();
    });

    describe('busy presses in the warning-focus review', () => {
      it('says it is still saving when Mark reviewed is pressed during a save', async () => {
        mockJobWithWarnings();
        const save = deferred<{ dryRunDiff: unknown[] }>();
        vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(() => save.promise as never);
        renderAt('job-60');
        await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');
        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));
        await userEvent.click(screen.getByRole('button', { name: /^exclude matching$/i }));
        await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledTimes(1));
        await openNodeDetails(userEvent, 'Affected two');
        const dialog = screen.getByRole('dialog');

        await userEvent.keyboard('a');

        await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Still saving. Try again.'));
        expect(jobsApi.setDiffEntriesReviewed).not.toHaveBeenCalled();
        await act(async () => save.resolve({ dryRunDiff: [] }));
      });
    });

    describe('reviewing', () => {
      it('"Mark all reviewed" on a Check kind never decides an item that also blocks the write', async () => {
        vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
          id: 'job-60',
          status: 'diff_ready',
          mode: 'survey',
          dryRunDiff: [epic('e1', 'Affected one'), epic('e2', 'Affected two'), epic('e3', 'Untouched')],
          warnings: [
            { kind: 'low_grounding', severity: 'needs_review', nodeIds: ['e1', 'e2'], detail: {}, raw: '2 nodes have low grounding.' },
            { kind: 'duplicate_customer_id', severity: 'needs_review', nodeIds: ['e2'], detail: {}, raw: 'e2 repeats a Customer ID.' },
          ],
        } as any);
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockClear();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
        renderAt('job-60');
        await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');
        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));

        await userEvent.click(screen.getByRole('button', { name: 'Mark all reviewed' }));

        // e2 still blocks the write (duplicate Customer ID): it is left for a deliberate decision.
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1);
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-60', ['e1'], true);
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockClear(); // the next test counts its own calls
      });

      it('marks every item of the focused warning reviewed in one request, empties the tree and clears the banner, and Undo restores it', async () => {
        mockJobWithWarnings();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
        renderAt('job-60');
        await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');
        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));

        await userEvent.click(screen.getByRole('button', { name: 'Mark all reviewed' }));

        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1);
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-60', ['e1', 'e2'], true);
        // Hide reviewed is on by default: nothing is left to show.
        expect(screen.getByText('All 2 items reviewed.')).toBeInTheDocument();
        expect(screen.queryByText('Affected one')).not.toBeInTheDocument();
        expect(screen.getByText('All warnings handled. You can approve the diff.')).toBeInTheDocument();
        expect(screen.queryByText(/need.* your attention/i)).not.toBeInTheDocument();

        await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-60', ['e1', 'e2'], false);
        expect(await screen.findByText('Affected one')).toBeInTheDocument();
        expect(screen.getByText(/1 warning needs your attention/i)).toBeInTheDocument();
      });

      it('keeps reviewed items listed, marked Reviewed, when hide reviewed is turned off', async () => {
        mockJobWithWarnings();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
        renderAt('job-60');
        await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');
        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));
        await userEvent.click(screen.getByRole('checkbox', { name: 'Hide reviewed' }));

        await userEvent.click(screen.getByRole('button', { name: 'Mark all reviewed' }));

        expect(screen.getByText('Affected one')).toBeInTheDocument();
        expect(screen.getAllByText('Reviewed')).toHaveLength(2);
        expect(screen.queryByRole('button', { name: 'Mark all reviewed' })).not.toBeInTheDocument();
      });

      it('a second "Mark all reviewed" in the same tick, before React re-renders, sees the first and is not sent again', async () => {
        mockJobWithWarnings();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockClear();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
        renderAt('job-60');
        await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');
        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));
        const markAll = screen.getByRole('button', { name: 'Mark all reviewed' });

        act(() => {
          fireEvent.click(markAll);
          fireEvent.click(markAll);
        });

        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1);
      });

      it('puts the items back and says so when the server refuses the mark', async () => {
        mockJobWithWarnings();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockRejectedValue(new Error('409'));
        renderAt('job-60');
        await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');
        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));

        await userEvent.click(screen.getByRole('button', { name: 'Mark all reviewed' }));

        expect(await screen.findByText(/failed to update review state/i)).toBeInTheDocument();
        expect(screen.getByText('Affected one')).toBeInTheDocument();
        expect(screen.getByText(/1 warning needs your attention/i)).toBeInTheDocument();
      });

      it('marks the open item reviewed and steps to the next item still to do', async () => {
        mockJobWithWarnings();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
        renderAt('job-60');
        await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');
        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));
        await openNodeDetails(userEvent, 'Affected one');

        await userEvent.click(await screen.findByRole('button', { name: 'Mark reviewed and next' }));

        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-60', ['e1'], true);
        // Now showing the second item, and its position in what is left.
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getAllByText('Affected two').length).toBeGreaterThan(0);
        expect(within(dialog).queryByText('Affected one')).not.toBeInTheDocument();
      });

      it('closes the dialog after marking the last item to do', async () => {
        mockJobWithWarnings();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
        renderAt('job-60');
        await waitFor(() => expect(screen.getByText('Untouched')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');
        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));
        await openNodeDetails(userEvent, 'Affected one');
        await userEvent.click(await screen.findByRole('button', { name: 'Mark reviewed and next' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Mark reviewed and next' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-60', ['e2'], true);
      });

      it('offers no review controls once the job is no longer awaiting review', async () => {
        vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
          id: 'job-61',
          status: 'confirmed',
          mode: 'survey',
          dryRunDiff: [epic('e1', 'Affected one')],
          warnings: [{ kind: 'low_grounding', severity: 'needs_review', nodeIds: ['e1'], detail: {}, raw: 'x' }],
        } as any);
        renderAt('job-61');
        await waitFor(() => expect(screen.getByText('Affected one')).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');

        // Read-only: the row opens the flagged items without calling it a review.
        await userEvent.click(screen.getByRole('button', { name: 'Show in tree' }));

        expect(screen.queryByRole('button', { name: 'Mark all reviewed' })).not.toBeInTheDocument();
      });
    });

    describe('retrying a failed enhancement', () => {
      const requirement = (localId: string, title: string) => ({
        localId, parentLocalId: null, type: 'Requirement', title, description: `verbatim ${localId}`, action: 'create', customerId: null, tags: [],
      });
      const ids = Array.from({ length: 120 }, (_, i) => `r${i}`);
      const warningFor = (nodeIds: string[]) => ({
        kind: 'enhancement_call_failed', severity: 'pipeline_issue', nodeIds, detail: { pass: 'synthesis' }, raw: 'failed',
      });

      // vi.mock('../api/jobs') keeps call history and queued once-values
      // across tests -- every assertion here counts calls.
      beforeEach(() => {
        vi.mocked(jobsApi.retryEnhancement).mockReset();
      });

      function mockJob() {
        vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
          id: 'job-70',
          status: 'diff_ready',
          mode: 'survey',
          dryRunDiff: ids.map((id) => requirement(id, `Original ${id}`)),
          warnings: [warningFor(ids)],
        } as any);
      }

      it('retries in batches of 50, merges each batch into the tree, and reports the totals', async () => {
        mockJob();
        vi.mocked(jobsApi.retryEnhancement).mockImplementation(async (_id, input) => ({
          dryRunDiff: input.localIds.map((id) => ({ ...requirement(id, `Better ${id}`), reviewed: false })),
          warnings: [warningFor(ids.slice(ids.indexOf(input.localIds[input.localIds.length - 1]) + 1))].filter((w) => w.nodeIds.length > 0),
          enhanced: input.localIds,
          failed: [],
          skipped: [],
        }));
        renderAt('job-70');
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.click(await screen.findByRole('button', { name: 'Retry enhancement' }));

        await waitFor(() => expect(jobsApi.retryEnhancement).toHaveBeenCalledTimes(3));
        const calls = vi.mocked(jobsApi.retryEnhancement).mock.calls.map(([, input]) => input.localIds.length);
        expect(calls).toEqual([50, 50, 20]);
        expect(vi.mocked(jobsApi.retryEnhancement).mock.calls[0][1]).toEqual({
          kind: 'enhancement_call_failed', pass: 'synthesis', localIds: ids.slice(0, 50),
        });
        expect(await screen.findByText('120 enhanced.')).toBeInTheDocument();
        // The warning is gone once nothing is left, so the row (and its button) with it.
        await waitFor(() => expect(screen.queryByText('Enhanced wording unavailable')).not.toBeInTheDocument());
      });

      it('stops at the first batch that errors and says how far it got', async () => {
        mockJob();
        vi.mocked(jobsApi.retryEnhancement)
          .mockResolvedValueOnce({ dryRunDiff: [], warnings: [warningFor(ids.slice(50))], enhanced: ids.slice(0, 50), failed: [], skipped: [] })
          .mockRejectedValueOnce(new Error('502'));
        renderAt('job-70');
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.click(await screen.findByRole('button', { name: 'Retry enhancement' }));

        expect(await screen.findByText(/retry stopped after 50 enhanced/i)).toBeInTheDocument();
        expect(jobsApi.retryEnhancement).toHaveBeenCalledTimes(2);
        // Back to a usable button, with the remaining items still listed.
        expect(await screen.findByRole('button', { name: 'Retry enhancement' })).toBeEnabled();
      });

      it('reports items that failed again or were left alone, without retrying them in the same run', async () => {
        mockJob();
        vi.mocked(jobsApi.retryEnhancement).mockImplementation(async (_id, input) => ({
          dryRunDiff: [],
          warnings: [warningFor(ids)],
          enhanced: input.localIds.slice(2),
          failed: [input.localIds[0]],
          skipped: [input.localIds[1]],
        }));
        renderAt('job-70');
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.click(await screen.findByRole('button', { name: 'Retry enhancement' }));

        expect(await screen.findByText(/114 enhanced, 3 still failing, 3 left alone/)).toBeInTheDocument();
        expect(jobsApi.retryEnhancement).toHaveBeenCalledTimes(3);
      });

      it('offers no retry once the job is no longer awaiting review', async () => {
        vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
          id: 'job-71', status: 'confirmed', mode: 'survey',
          dryRunDiff: [requirement('r0', 'Original r0')],
          warnings: [warningFor(['r0'])],
        } as any);
        renderAt('job-71');
        fireEvent.click(await screen.findByRole('button', { name: /for your information/i })); // an informational group starts collapsed
        const { default: userEvent } = await import('@testing-library/user-event');

        await screen.findByText('Enhanced wording unavailable');
        expect(screen.queryByRole('button', { name: 'Retry enhancement' })).not.toBeInTheDocument();
      });
    });

    describe('marking a warning handled', () => {
      function mockJobWithZeroNodes() {
        vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
          id: 'job-62',
          status: 'diff_ready',
          mode: 'survey',
          dryRunDiff: [epic('e1', 'Only item')],
          warnings: [{ kind: 'zero_nodes', severity: 'pipeline_issue', nodeIds: [], detail: {}, raw: 'Section produced 0 work items.' }],
        } as any);
      }

      it('acknowledges the kind, completes it and clears the banner', async () => {
        mockJobWithZeroNodes();
        vi.mocked(jobsApi.setWarningsAcknowledged).mockResolvedValue({ warnings: [] });
        renderAt('job-62');
        await waitFor(() => expect(screen.getByText(/1 warning needs your attention/i)).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.click(screen.getByRole('button', { name: 'Mark handled' }));

        expect(jobsApi.setWarningsAcknowledged).toHaveBeenCalledWith('job-62', { kind: 'zero_nodes', raws: undefined, acknowledged: true });
        expect(screen.getByText('Done')).toBeInTheDocument();
        expect(screen.getByText('All warnings handled. You can approve the diff.')).toBeInTheDocument();
      });

      it('reverts the acknowledgement when the server refuses it', async () => {
        mockJobWithZeroNodes();
        vi.mocked(jobsApi.setWarningsAcknowledged).mockRejectedValue(new Error('409'));
        renderAt('job-62');
        await waitFor(() => expect(screen.getByText(/1 warning needs your attention/i)).toBeInTheDocument());
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.click(screen.getByRole('button', { name: 'Mark handled' }));

        expect(await screen.findByText(/failed to update/i)).toBeInTheDocument();
        expect(screen.queryByText('Done')).not.toBeInTheDocument();
        expect(screen.getByText(/1 warning needs your attention/i)).toBeInTheDocument();
      });
    });
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

    const retryName = /retry writing "covers" trace link/i;
    await openNodeDetails(userEvent, 'Root');
    await waitFor(() => expect(screen.getByRole('button', { name: retryName })).toBeInTheDocument(), { timeout: 8000 });
    const retryButton = screen.getByRole('button', { name: retryName });
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

  describe('rebuild duplicate index', () => {
    const FAILED = { id: 'a1', message: 'Dedup index may be only partly updated for 3 newly-created item(s) -- boom', createdAt: '2026-07-09T00:00:00Z' };
    const REBUILT = { id: 'a2', message: 'Duplicate index rebuilt for 3 item(s)', createdAt: '2026-07-09T01:00:00Z' };

    async function openAudit(entries: any[]) {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-dd', status: 'succeeded', createdItemCount: 1, dryRunDiff: [{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Root', description: '', action: 'create', customerId: null, tags: [] }] } as any);
      vi.spyOn(jobsApi, 'getAudit').mockResolvedValue(entries);
      vi.spyOn(jobsApi, 'getDebugCaptures').mockResolvedValue([]);
      renderAt('job-dd');
      const { default: userEvent } = await import('@testing-library/user-event');
      await waitFor(() => expect(screen.getByRole('tab', { name: /audit/i })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('tab', { name: /audit/i }));
      await waitFor(() => expect(screen.getByText(entries[0].message)).toBeInTheDocument());
      return userEvent;
    }

    it('shows the rebuild button only after a recorded dedup failure', async () => {
      await openAudit([FAILED]);
      expect(screen.getByRole('button', { name: 'Rebuild duplicate index' })).toBeInTheDocument();
    });

    it('does not show it when no dedup failure is recorded', async () => {
      await openAudit([{ id: 'a0', message: 'Job submitted: x.docx', createdAt: '2026-07-09T00:00:00Z' }]);
      expect(screen.queryByRole('button', { name: 'Rebuild duplicate index' })).not.toBeInTheDocument();
    });

    it('keys off the exact audit prefixes the server writes', async () => {
      await openAudit([{ id: 'p1', message: 'Dedup index may be only partly updated', createdAt: '2026-07-09T00:00:00Z' }]);
      expect(screen.getByRole('button', { name: 'Rebuild duplicate index' })).toBeInTheDocument();
    });

    it('hides it again after the rebuilt prefix', async () => {
      await openAudit([
        { id: 'p1', message: 'Dedup index may be only partly updated', createdAt: '2026-07-09T00:00:00Z' },
        { id: 'p2', message: 'Duplicate index rebuilt', createdAt: '2026-07-09T01:00:00Z' },
      ]);
      expect(screen.queryByRole('button', { name: 'Rebuild duplicate index' })).not.toBeInTheDocument();
    });

    it('hides it after a rebuild entry', async () => {
      await openAudit([FAILED, REBUILT]);
      expect(screen.queryByRole('button', { name: 'Rebuild duplicate index' })).not.toBeInTheDocument();
    });

    it('confirms and calls the API, then shows the toast', async () => {
      const reindex = vi.spyOn(jobsApi, 'reindexDedup').mockResolvedValue({ indexed: 3 });
      const userEvent = await openAudit([FAILED]);
      await userEvent.click(screen.getByRole('button', { name: 'Rebuild duplicate index' }));
      expect(screen.getByText(/If any were deleted there, they will still be treated as duplicates until you remove them from the index\./)).toBeInTheDocument();
      expect(reindex).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Rebuild index' }));
      await waitFor(() => expect(reindex).toHaveBeenCalledWith('job-dd'));
      await waitFor(() => expect(screen.getByText('Duplicate index rebuilt for 3 items')).toBeInTheDocument());
    });
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

  it('names the page with the file name as its level-one heading and tells the shell the job label', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-h1',
      status: 'diff_ready',
      dryRunDiff: [],
      createdItemCount: 0,
      originalFilename: 'mock_icd.docx',
    } as any);

    renderAt('job-h1');

    expect(await screen.findByRole('heading', { level: 1, name: 'mock_icd.docx' })).toBeInTheDocument();
    expect(usePageLabelStore.getState().jobLabels['job-h1']).toBe('mock_icd.docx');
  });

  it('still has a level-one heading when the job has no file name', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-noname', status: 'diff_ready', dryRunDiff: [], createdItemCount: 0 } as any);
    renderAt('job-noname');
    expect(await screen.findByRole('heading', { level: 1, name: 'Job' })).toBeInTheDocument();
  });

  it('does not render the resume-safe banner for a diff_ready job with no prior partial write', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-20',
      status: 'diff_ready',
      dryRunDiff: [],
      createdItemCount: 0,
    } as any);

    renderAt('job-20');

    await waitFor(() => expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeInTheDocument());
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

  it('shows the Validate icon button as busy and renamed "Validating…" while the check runs, and ignores a second click', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-22', status: 'completed', createdItemCount: 2, dryRunDiff: [] } as any);
    let finish!: (value: { valid: boolean; checkedCount: number; mismatches: never[] }) => void;
    const validateSpy = vi.spyOn(jobsApi, 'validateCreatedTree').mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    renderAt('job-22');
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /^validate$/i }));
    const busy = await screen.findByRole('button', { name: /validating/i });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(validateSpy).toHaveBeenCalledTimes(1);
    finish({ valid: true, checkedCount: 2, mismatches: [] });
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
        { localId: 'n1', adoWorkItemId: 101, field: 'existence', expected: 'work item exists in Azure DevOps', actual: 'not found' },
      ],
    });

    renderAt('job-22');
    const { default: userEvent } = await import('@testing-library/user-event');
    await waitFor(() => expect(screen.getByRole('button', { name: /^validate$/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /^validate$/i }));

    await waitFor(() => expect(screen.getByText(/2 mismatches found/i)).toBeInTheDocument());
    expect(screen.getByText(/WI-100/)).toBeInTheDocument();
    expect(screen.getByText(/WI-101/)).toBeInTheDocument();
    expect(screen.getByText(/work item exists in Azure DevOps/)).toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeInTheDocument());
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
    fireEvent.click(await screen.findByRole('tab', { name: /^Parse/ })); // figures and the overview belong to the Parse phase

    await waitFor(() => expect(screen.getByText(/1 figure description/i)).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    await userEvent.click(screen.getByText(/1 figure description/i));
    expect(screen.getByText(/A block diagram showing power distribution\./i)).toBeInTheDocument();
  });

  it('shows which figures got no description, and why, from the persisted figure descriptions alone (not from the last 50 events)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-outcomes',
      status: 'succeeded',
      mode: 'survey',
      dryRunDiff: [],
      createdAt: new Date().toISOString(),
      figureDescriptions: [
        { figureIndex: 1, figureId: 'f0', name: null, caption: 'A block diagram.' },
        { figureIndex: 2, figureId: 'f1', name: null, caption: null, captionStatus: 'insignificant', captionReason: 'A company logo.' },
        { figureIndex: 3, figureId: 'f2', name: null, caption: null, captionStatus: 'vision_failed' },
      ],
    } as any);

    renderAt('job-outcomes');
    fireEvent.click(await screen.findByRole('tab', { name: /^Parse/ })); // figures and the overview belong to the Parse phase

    await waitFor(() => expect(screen.getByText('1 described · 1 not significant · 1 failed')).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    await userEvent.click(screen.getByText('1 described · 1 not significant · 1 failed'));
    expect(screen.getByText(/Judged by the vision model: A company logo\./)).toBeInTheDocument();
    // a figure with neither a description nor a name is not listed as if it were described
    expect(screen.queryByText(/2 figure description/)).not.toBeInTheDocument();
  });

  it('does not show job A\'s failure cause on job B when the page is reused and B\'s audit cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockImplementation(async (jobId: string) =>
      ({ id: jobId, status: 'failed', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString() }) as any,
    );
    vi.spyOn(jobsApi, 'getAudit').mockImplementation(async (jobId: string) => {
      if (jobId === 'job-a') return [{ id: 'a1', jobId, message: 'Pipeline failed: terminated (UND_ERR_SOCKET: other side closed)', createdAt: '2026-11-12T21:48:00Z' }] as any;
      throw new Error('audit unavailable');
    });
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation(() => () => {});
    const { useNavigate } = await import('react-router-dom');
    function Switch() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/jobs/job-b')}>go to B</button>;
    }
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/jobs/job-a']}>
          <Switch />
          <Routes>
            <Route path="/jobs/:id" element={<JobDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByText('The connection was cut during the run.')).toBeInTheDocument();
    const userEvent = (await import('@testing-library/user-event')).default;
    await userEvent.click(screen.getByText('go to B'));
    await waitFor(() => expect(jobsApi.getAudit).toHaveBeenCalledWith('job-b'));
    await waitFor(() => expect(screen.queryByText('The connection was cut during the run.')).not.toBeInTheDocument());
    expect(await screen.findByText(/This job failed before completing analysis/)).toBeInTheDocument();
  });

  it('shows nothing of the previous job when the page is reused for another job id (figure outcomes and overview must not carry over)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    const base = { status: 'succeeded', mode: 'survey', dryRunDiff: [], createdAt: new Date().toISOString() };
    vi.spyOn(jobsApi, 'getJob').mockImplementation(async (jobId: string) =>
      (jobId === 'job-a'
        ? {
            ...base,
            id: 'job-a',
            documentOverview: { synopsis: 'About job A.', caveat: null, lines: ['Structure: job A has 3 sections.'] },
            figureDescriptions: [
              { figureIndex: 1, figureId: 'f0', name: null, caption: 'Job A diagram.' },
              { figureIndex: 2, figureId: 'f1', name: null, caption: null, captionStatus: 'insignificant', captionReason: 'A logo in job A.' },
            ],
          }
        : { ...base, id: 'job-b' }) as any,
    );
    const { ToastProvider: Toast } = await import('../components/ToastProvider');
    const { useNavigate } = await import('react-router-dom');
    function Switch() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/jobs/job-b')}>go to B</button>;
    }
    render(
      <Toast>
        <MemoryRouter initialEntries={['/jobs/job-a']}>
          <Switch />
          <Routes>
            <Route path="/jobs/:id" element={<JobDetail />} />
          </Routes>
        </MemoryRouter>
      </Toast>,
    );
    fireEvent.click(await screen.findByRole('tab', { name: /^Parse/ })); // figures and the overview belong to the Parse phase
    await waitFor(() => expect(screen.getByText('1 described · 1 not significant')).toBeInTheDocument());
    expect(screen.getByText(/Structure: job A has 3 sections\./)).toBeInTheDocument();

    const userEvent = (await import('@testing-library/user-event')).default;
    await userEvent.click(screen.getByText('go to B'));

    await waitFor(() => expect(jobsApi.getJob).toHaveBeenCalledWith('job-b'));
    await waitFor(() => expect(screen.queryByText('1 described · 1 not significant')).not.toBeInTheDocument());
    expect(screen.queryByText(/Structure: job A has 3 sections\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/figure description/)).not.toBeInTheDocument();
  });

  it('shows how many knowledge-base files were surfaced for a job that persisted kbCoverage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-kbc', status: 'diff_ready', mode: 'survey', dryRunDiff: [], createdAt: new Date().toISOString(),
      kbCoverage: { filesAvailable: 3, filesCited: 1 },
    } as any);

    renderAt('job-kbc');
    fireEvent.click(await screen.findByRole('button', { name: /Run details/ })); // the run's record sits behind "Run details" in the review state

    await waitFor(() => expect(screen.getByText('1 of 3 knowledge-base files were surfaced for this job.')).toBeInTheDocument());
  });

  it('shows no knowledge-base coverage note for a job without kbCoverage (older job or BASELINE)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-nokbc', status: 'diff_ready', mode: 'baseline', dryRunDiff: [], createdAt: new Date().toISOString(), kbCoverage: null,
    } as any);

    renderAt('job-nokbc');

    await waitFor(() => expect(jobsApi.getJob).toHaveBeenCalled());
    expect(screen.queryByText(/knowledge-base file/i)).not.toBeInTheDocument();
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
        figureCaptionReason: 'A decorative divider line.',
      } as any);
      return () => {};
    });

    renderAt('job-27');
    // The figure list belongs to the Parse phase; the run is on Analyze, so open Parse.
    fireEvent.click(await screen.findByRole('tab', { name: /Parse/ }));

    await waitFor(() => expect(screen.getByText(/1 described · 1 not significant/i)).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    const panelToggle = screen.getByText(/1 described · 1 not significant/i);
    await userEvent.click(panelToggle);
    // Scoped to the panel itself (a sibling ProgressBanner ticker
    // legitimately still shows the placeholder text once, by design -- see
    // figureCaptionStatus's own docstring) -- only the panel's OWN list must
    // exclude the insignificant figure.
    const panel = panelToggle.closest('button')!.parentElement as HTMLElement;
    expect(within(panel).getByText(/A block diagram showing power distribution\./i)).toBeInTheDocument();
    expect(within(panel).queryByText(/this figure has no discernible technical content/i)).not.toBeInTheDocument();
    // The figure is not hidden: the panel says what became of it, in plain words (the placeholder text still never counts as a description).
    expect(within(panel).getByText(/Figure 2 in the document/i)).toBeInTheDocument();
    expect(within(panel).getByText(/not significant, no description needed/i)).toBeInTheDocument();
    // ...and who judged it and why, in one short line, rebuilt from the stored history.
    expect(within(panel).getByText('Judged by the vision model: A decorative divider line.')).toBeInTheDocument();
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
          figureCaptionReason: 'A decorative divider line.',
        },
      },
    ] as any);

    renderAt('job-32');
    // The figure list belongs to the Parse phase; the run is on Analyze, so open Parse.
    fireEvent.click(await screen.findByRole('tab', { name: /Parse/ }));

    await waitFor(() => expect(screen.getByText(/1 described · 1 not significant/i)).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    const panelToggle = screen.getByText(/1 described · 1 not significant/i);
    await userEvent.click(panelToggle);
    const panel = panelToggle.closest('button')!.parentElement as HTMLElement;
    expect(within(panel).getByText(/A block diagram showing power distribution\./i)).toBeInTheDocument();
    expect(within(panel).queryByText(/this figure has no discernible technical content/i)).not.toBeInTheDocument();
    // The figure is not hidden: the panel says what became of it, in plain words (the placeholder text still never counts as a description).
    expect(within(panel).getByText(/Figure 2 in the document/i)).toBeInTheDocument();
    expect(within(panel).getByText(/not significant, no description needed/i)).toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByText('Written items (0)')).toBeInTheDocument());
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
    const recordedAt = '2026-11-07T09:41:07.000Z';
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([
      {
        id: 'evt-1', jobId: 'job-31', phase: 'preparing_analysis', severity: 'info', createdAt: recordedAt,
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
    await screen.findAllByText(sharedMessage);
    // The activity log (DESIGN.md section 11.3.2) makes the duplicate check direct: the same event is exactly one line.
    // The run log is collapsed until opened (§11.3.5).
    fireEvent.click(await screen.findByRole('button', { name: /Run log/ }));
    const log = await screen.findByRole('log', { name: 'Job activity' });
    expect(within(log).getAllByRole('listitem')).toHaveLength(1);
    // and the line carries the time the server recorded, not the moment this page loaded
    expect(log.querySelector('time')).toHaveAttribute('datetime', recordedAt);
    // and the sentence appears in at most the banner's one sentence and that one log line (the ticker is gone)
    expect(screen.getAllByText(sharedMessage).length).toBeLessThanOrEqual(2);
  });

  it('shows "How this run went" from the stored notices of a finished job and keeps them out of the audit list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-40', status: 'diff_ready', mode: 'survey',
      dryRunDiff: [{ localId: 'r1', title: 'Chassis size', type: 'Requirement', action: 'create', description: 'd' }],
      createdAt: new Date().toISOString(),
    } as any);
    const notice = {
      type: 'notice', id: 'n1', kind: 'output_limit_reached', severity: 'warning', count: 1,
      facts: { lastRef: 'r1' }, emittedAt: new Date().toISOString(),
    };
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([
      {
        id: 'evt-n', jobId: 'job-40', phase: 'notice', message: 'output_limit_reached', severity: 'info',
        createdAt: new Date().toISOString(), detail: notice,
      },
    ] as any);

    renderAt('job-40');
    fireEvent.click(await screen.findByRole('button', { name: /Run details/ })); // the run's record sits behind "Run details" in the review state

    const summary = await screen.findByTestId('run-notices');
    expect(summary).toHaveTextContent('How this run went');
    expect(screen.getByTestId('notice-output_limit_reached')).toHaveTextContent('The last item it finished was "Chassis size"');
    expect(screen.queryByText('output_limit_reached')).not.toBeInTheDocument();
  });

  it('omits the FigureDescriptions panel entirely when the job has no persisted figure captions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-25', status: 'succeeded', mode: 'baseline', dryRunDiff: [], createdAt: new Date().toISOString(),
    } as any);

    renderAt('job-25');

    await waitFor(() => expect(screen.getByRole('tab', { name: /(proposed|written) items/i })).toBeInTheDocument());
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

    // The prominent banner and the warnings panel below it both show the
    // warning now -- the banner by count, the panel by its row.
    await waitFor(() => expect(screen.getByText(/1 warning needs your attention/i)).toBeInTheDocument());
    expect(screen.getByText('Low grounding: possible fabrication')).toBeInTheDocument();
  });

  it('gates the Confirm button on diff_ready status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }),
    );
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-3', status: 'running', dryRunDiff: null } as any);
    renderAt('job-3');
    await waitFor(() => expect(screen.queryByRole('button', { name: /^write to azure devops$/i })).not.toBeInTheDocument());
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

  it('bulk-excludes only the rows of the active group filter, ignoring the rest of the diff', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: /^check · 2$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^exclude matching$/i }));

    await waitFor(() => expect(excludeSpy).toHaveBeenCalledTimes(2));
    expect(excludeSpy).toHaveBeenCalledWith('job-41', 'a', true);
    expect(excludeSpy).toHaveBeenCalledWith('job-41', 'b', true);
    expect(excludeSpy).not.toHaveBeenCalledWith('job-41', 'c', true);
  });

  it('shows the server message when excluding a written entry is refused', async () => {
    const { AxiosError } = await import('axios');
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-9w',
      status: 'diff_ready',
      dryRunDiff: [
        { localId: 'a', parentLocalId: null, type: 'Requirement', title: 'Row one', description: '', action: 'create', customerId: null, tags: [] },
      ],
    } as any);
    const message = 'Diff entry a was already written to Azure DevOps by an earlier attempt, so it can no longer change';
    vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockRejectedValue(
      new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 400,
        data: { statusCode: 400, message },
      } as any),
    );

    renderAt('job-9w');
    await waitFor(() => expect(screen.getByText('Row one')).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await clickUntilCalled(userEvent, () => screen.getByRole('checkbox', { name: /exclude row one/i }), jobsApi.setDiffEntryExcluded as never);

    await screen.findByText(message, {}, { timeout: 8000 });
    expect(screen.getByRole('checkbox', { name: /exclude row one/i })).not.toBeChecked();
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
    await clickUntilCalled(userEvent, () => screen.getByRole('checkbox', { name: /exclude row one/i }), jobsApi.setDiffEntryExcluded as never);

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
      // The counts are one summary line now (the closed "Run details" strip), not three tiles.
      return /(\d+) new/.exec(screen.queryByTestId('review-header')?.textContent ?? '')?.[1];
    }

    renderAt('job-77');
    await waitFor(() => expect(screen.getByText('Row one')).toBeInTheDocument());
    // Pre-exclusion count from the mount-time fetch.
    await waitFor(() => expect(newTileValue()).toBe('5'));

    const { default: userEvent } = await import('@testing-library/user-event');
    await clickUntilCalled(userEvent, () => screen.getByRole('checkbox', { name: /exclude row one/i }), jobsApi.setDiffEntryExcluded as never);

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

  it('lays the header out as tools only for a job in review: Reject and Write live in the write bar, the rest are labelled icons, Delete last', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-8', status: 'diff_ready', dryRunDiff: [] } as any);

    renderAt('job-8');
    const tools = await screen.findByRole('group', { name: 'Job tools' });
    const names = within(tools).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Download summary', 'Resubmit', 'Delete']);
    expect(within(tools).queryByRole('button', { name: /reject|write to azure/i })).toBeNull();
    const bar = screen.getByRole('region', { name: 'Review decision' });
    expect(within(bar).getByRole('button', { name: /^reject$/i })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /write to azure devops/i })).toBeInTheDocument();
  });

  it('puts the tools first and the decisions last in the DOM: the write bar follows the review, so a keyboard user meets the items before Write', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-10', status: 'diff_ready', dryRunDiff: [] } as any);

    renderAt('job-10');
    const tools = await screen.findByRole('group', { name: 'Job tools' });
    const write = screen.getByRole('button', { name: /write to azure devops/i });
    const reject = screen.getByRole('button', { name: /^reject$/i });
    expect(tools.compareDocumentPosition(write) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the counterpart decision sits beside Write, before it
    expect(reject.compareDocumentPosition(write) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /write to azure devops/i })).toHaveLength(1);
  });

  it('shows no Resubmit or Delete while a job is running, only Download summary and Cancel run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-9', status: 'running', dryRunDiff: null } as any);

    renderAt('job-9');
    const tools = await screen.findByRole('group', { name: 'Job tools' });
    expect(within(tools).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Download summary']);
    expect(screen.getByRole('button', { name: /cancel run/i })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText(/(proposed|written) items \(0\)/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument();
  });

  it('shows a queued indicator while the job is pending, before the worker picks it up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-9', status: 'pending', dryRunDiff: null } as any);
    renderAt('job-9');
    await waitFor(() => expect(screen.getByText(/queued/i)).toBeInTheDocument());
  });

  it('shows a success toast with the created count after the write succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob')
      .mockResolvedValueOnce({ id: 'job-10', status: 'diff_ready', dryRunDiff: [], areaPath: 'Project\\Area1' } as any)
      .mockResolvedValueOnce({ id: 'job-10', status: 'succeeded', dryRunDiff: [] } as any);
    vi.spyOn(jobsApi, 'confirmJob').mockResolvedValue({ status: 'succeeded', createdCount: 3 });
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');

    renderAt('job-10');
    await waitFor(() => expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^write to azure devops$/i }));
    // The confirm-to-ADO dialog is irreversible -- its Confirm button stays
    // disabled until the acknowledgement checkbox is ticked (DESIGN.md §7/§8).
    await userEvent.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
    await userEvent.click(screen.getByRole('button', { name: /^write to azure devops$/i }));

    await waitFor(() => expect(screen.getByText(/wrote 3 work items to azure devops/i)).toBeInTheDocument());
  });

  it('says how many items were linked to an existing work item instead of created', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob')
      .mockResolvedValueOnce({ id: 'job-10b', status: 'diff_ready', dryRunDiff: [], areaPath: 'Project\\Area1' } as any)
      .mockResolvedValueOnce({ id: 'job-10b', status: 'succeeded', dryRunDiff: [] } as any);
    vi.spyOn(jobsApi, 'confirmJob').mockResolvedValue({ status: 'succeeded', createdCount: 3, linkedInsteadCount: 2 });
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');

    renderAt('job-10b');
    await waitFor(() => expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^write to azure devops$/i }));
    // The confirm-to-ADO dialog is irreversible -- its Confirm button stays
    // disabled until the acknowledgement checkbox is ticked (DESIGN.md §7/§8).
    await userEvent.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
    await userEvent.click(screen.getByRole('button', { name: /^write to azure devops$/i }));

    await waitFor(() => expect(screen.getByText(/wrote 3 work items to azure devops, linked 2 that were already there/i)).toBeInTheDocument());
  });

  describe('final write summary', () => {
    const entry = (localId: string, extra: Record<string, unknown> = {}) => ({
      localId, parentLocalId: null, type: 'Requirement', title: localId, description: '', action: 'create', customerId: null, tags: [], ...extra,
    });
    // hasWork and figuresOnly are what the server sends; the fixture keeps them in step with the counts.
    const previewOf = (overrides: Record<string, unknown> = {}) => withServerFlags({
      createdTotal: 2,
      createdLocalIds: ['a', 'b'],
      createdByType: { Requirement: 2 },
      excluded: { direct: 1, viaAncestor: 0 },
      parentLinks: 0,
      figuresToAttach: 0,
      figuresUnavailable: 0,
      existingGettingChildren: 0,
      existingWithoutNewParentLink: 0,
      traceLinks: { planned: 0, skipped: 0 },
      alreadyWritten: 0,
      ...overrides,
    });

    async function openWriteDialog(jobId: string) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
      renderAt(jobId);
      await waitFor(() => expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeInTheDocument());
      const { default: userEvent } = await import('@testing-library/user-event');
      await userEvent.click(screen.getByRole('button', { name: /^write to azure devops$/i }));
      return userEvent;
    }

    it('shows what the server says will be written, the destination, and a button with the count and project', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-ws1', status: 'diff_ready', areaPath: 'Compliance\\Auth', adoProject: 'Compliance',
        dryRunDiff: [entry('a', { reviewed: true }), entry('b'), entry('x', { excluded: true })],
      } as any);
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf());
      await openWriteDialog('job-ws1');

      expect(await screen.findByText('2 new work items: 2 Requirements.')).toBeInTheDocument();
      expect(screen.getByText('1 item left out: 1 excluded by you.')).toBeInTheDocument();
      expect(screen.getByText('Review: 1 reviewed earlier, 1 not reviewed.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Write 2 items to Compliance' })).toBeInTheDocument();
    });

    it('disables the write when nothing would be created', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-ws2', status: 'diff_ready', areaPath: 'Compliance\\Auth', adoProject: 'Compliance', dryRunDiff: [entry('a', { excluded: true })],
      } as any);
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(
        previewOf({ createdTotal: 0, createdLocalIds: [], createdByType: {}, excluded: { direct: 1, viaAncestor: 0 } }),
      );
      const user = await openWriteDialog('job-ws2');

      expect(await screen.findByText('Nothing will be created.')).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      expect(screen.getByRole('button', { name: /^write 0 items to compliance$/i })).toBeDisabled();
    });

    it('says it could not check, and still lets the reviewer write', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-ws3', status: 'diff_ready', areaPath: 'Compliance\\Auth', dryRunDiff: [entry('a')],
      } as any);
      vi.spyOn(jobsApi, 'getWritePreview').mockRejectedValue(new Error('down'));
      const user = await openWriteDialog('job-ws3');

      expect(await screen.findByText(/couldn't check what will be written/i)).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeEnabled();
    });

    const jobOf = (jobId: string, extra: Record<string, unknown> = {}) =>
      ({ id: jobId, status: 'diff_ready', areaPath: 'Compliance\\Auth', adoProject: 'Compliance', dryRunDiff: [entry('a')], ...extra }) as any;
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const writeDialog = () => screen.queryByRole('dialog', { name: /write these items to azure devops/i });

    const headerWriteButton = () => screen.getByRole('button', { name: /^write to azure devops$/i, hidden: true });

    it('Cancel returns focus to the header write button', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws20'));
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf());
      const user = await openWriteDialog('job-ws20');
      await screen.findByText('2 new work items: 2 Requirements.');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(writeDialog()).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(headerWriteButton()));
    });

    it('"Review N unreviewed items" closes the confirmation without refocusing the header button and opens the review queue', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws21', { dryRunDiff: [entry('a'), entry('b')] }));
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf());
      const user = await openWriteDialog('job-ws21');
      const headerButton = headerWriteButton();
      await user.click(await screen.findByRole('button', { name: 'Review 2 unreviewed items' }));
      await waitFor(() => expect(writeDialog()).toBeNull());
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(document.activeElement).not.toBe(headerButton);
    });

    it('does not offer "Go to N warnings to fix" once the gate has passed: an item the reviewer decided on is not an open fix', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(
        jobOf('job-ws22', {
          dryRunDiff: [entry('a', { reviewed: true })],
          warnings: [{ kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['a'], detail: {}, raw: 'x' }],
        }),
      );
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf());
      await openWriteDialog('job-ws22');
      expect(await screen.findByRole('dialog', { name: /write these items to azure devops/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /warnings? to fix/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/still open\. You can still write/i)).not.toBeInTheDocument();
    });

    it('"Show the N excluded items" closes the write dialog and filters the tree to excluded items', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(
        jobOf('job-ws23', {
          dryRunDiff: [
            entry('a', { title: 'Kept item' }),
            entry('x', { title: 'Excluded item', excluded: true }),
            entry('y', { title: 'Under excluded', parentLocalId: 'x' }),
          ],
        }),
      );
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf({ excluded: { direct: 1, viaAncestor: 1 } }));
      const user = await openWriteDialog('job-ws23');
      await user.click(await screen.findByRole('button', { name: 'Show the 2 excluded items' }));

      await waitFor(() => expect(writeDialog()).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByText('Kept item')).not.toBeInTheDocument());
      expect(screen.getByText('Excluded item')).toBeInTheDocument();
      expect(screen.getByText('Under excluded')).toBeInTheDocument();
      expect(screen.getByText(/left out of the write: 2 items/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark all reviewed' })).not.toBeInTheDocument();
    });

    it('a preview timeout shows the timed-out message and Confirm stays enabled', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws24'));
      vi.spyOn(jobsApi, 'getWritePreview').mockReturnValue(new Promise(() => {}));
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let user!: Awaited<ReturnType<typeof openWriteDialog>>;
      try {
        user = await openWriteDialog('job-ws24');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15000);
        });
      } finally {
        vi.useRealTimers();
      }
      expect(await screen.findByText(/the check took too long/i)).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeEnabled();
    });

    it('a failed (non-timeout) preview keeps the generic message', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws25'));
      vi.spyOn(jobsApi, 'getWritePreview').mockRejectedValue(new Error('down'));
      await openWriteDialog('job-ws25');
      expect(await screen.findByText(/couldn't check what will be written/i)).toBeInTheDocument();
      expect(screen.queryByText(/the check took too long/i)).not.toBeInTheDocument();
    });

    it('a malformed preview is treated as a failed check', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws26'));
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue({ createdTotal: 2, createdLocalIds: null, excluded: { direct: 0, viaAncestor: 0 } } as any);
      const user = await openWriteDialog('job-ws26');
      expect(await screen.findByText(/couldn't check what will be written/i)).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeEnabled();
    });

    it('entries the server reports as written get the written lock in the details dialog', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(
        jobOf('job-ws27', { dryRunDiff: [entry('a', { title: 'Written item' })], writtenLocalIds: ['a'] }),
      );
      const { default: userEvent } = await import('@testing-library/user-event');
      renderAt('job-ws27');
      await userEvent.click(await screen.findByText('Written item'));
      const dialog = await screen.findByRole('dialog');
      expect(
        await within(dialog).findByText('Already written to Azure DevOps by an earlier attempt, so this can no longer change.'),
      ).toBeInTheDocument();
    });

    it('disables the write while the check is running and says so', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws4'));
      vi.spyOn(jobsApi, 'getWritePreview').mockReturnValue(new Promise(() => {}));
      const user = await openWriteDialog('job-ws4');

      await user.click(await screen.findByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      const button = screen.getByRole('button', { name: /^write to azure devops$/i });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(/checking what will be written/i);
    });

    it('lets a retry with only links left finish writing', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws5'));
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(
        previewOf({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 2, alreadyWritten: 3 }),
      );
      const user = await openWriteDialog('job-ws5');

      expect(await screen.findByText('Nothing new to create; 2 parent links remain. 3 items are already written.')).toBeInTheDocument();
      expect(screen.queryByText(/creates 0 new work items/i)).not.toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      expect(screen.getByRole('button', { name: 'Finish writing to Compliance' })).toBeEnabled();
    });

    it('figures-only write dialog shows the attach copy and button label', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws5f'));
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(
        previewOf({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 0, figuresToAttach: 36 }),
      );
      const user = await openWriteDialog('job-ws5f');

      expect(await screen.findByText('36 figures will be attached to their items in Azure DevOps.')).toBeInTheDocument();
      expect(screen.getByText('No new items will be created.')).toBeInTheDocument();
      expect(screen.queryByText('Nothing will be created.')).not.toBeInTheDocument();
      expect(screen.getByText(/Figures are attached by position/)).toBeInTheDocument();
      expect(screen.getByText(/This attaches the figures to their items under/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Attach figures to Azure DevOps items?' })).toBeInTheDocument();
      expect(screen.queryByText(/No new items are created\./)).not.toBeInTheDocument();
      expect(screen.getByText(/Attachments must be removed directly in Azure DevOps afterward/)).toBeInTheDocument();
      expect(screen.queryByText(/must be deleted directly/)).not.toBeInTheDocument();
      expect(screen.queryByText('Write these items to Azure DevOps?')).not.toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      expect(screen.getByRole('button', { name: 'Attach 36 figures to Compliance' })).toBeEnabled();
    });

    it('keeps the write disabled, with the reason, when there is nothing at all to do', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws6'));
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(
        previewOf({ createdTotal: 0, createdLocalIds: [], createdByType: {}, excluded: { direct: 0, viaAncestor: 0 } }),
      );
      const user = await openWriteDialog('job-ws6');

      expect(await screen.findByText('Nothing will be created.')).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      const button = screen.getByRole('button', { name: /^write 0 items to compliance$/i });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(/nothing will be created, so there is nothing to write/i);
    });

    it('gives up on a check that never answers after 15 seconds and lets the reviewer write', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws7'));
      vi.spyOn(jobsApi, 'getWritePreview').mockReturnValue(new Promise(() => {}));
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let user!: Awaited<ReturnType<typeof openWriteDialog>>;
      try {
        user = await openWriteDialog('job-ws7');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15000);
        });
      } finally {
        vi.useRealTimers();
      }

      expect(await screen.findByText(/the check took too long/i)).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));
      expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeEnabled();
    });

    it('drops a late answer from an earlier opening of the dialog', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws8'));
      const a = deferred<ReturnType<typeof previewOf>>();
      const b = deferred<ReturnType<typeof previewOf>>();
      vi.spyOn(jobsApi, 'getWritePreview').mockReturnValueOnce(a.promise as any).mockReturnValueOnce(b.promise as any);
      const user = await openWriteDialog('job-ws8');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(writeDialog()).not.toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^write to azure devops$/i }));
      await act(async () => b.resolve(previewOf({ createdTotal: 7, createdLocalIds: [], createdByType: { Requirement: 7 } })));
      expect(await screen.findByText('7 new work items: 7 Requirements.')).toBeInTheDocument();

      await act(async () => a.resolve(previewOf({ createdTotal: 99, createdLocalIds: [], createdByType: { Requirement: 99 } })));

      expect(screen.getByText('7 new work items: 7 Requirements.')).toBeInTheDocument();
      expect(screen.queryByText(/99/)).not.toBeInTheDocument();
    });

    it('asks the server again each time the dialog is opened', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws9'));
      const spy = vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf());
      const user = await openWriteDialog('job-ws9');
      await screen.findByText('2 new work items: 2 Requirements.');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(writeDialog()).not.toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^write to azure devops$/i }));

      await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    });

    it.each([
      ['cancelled', 'The job changed, so the write was cancelled. Nothing was written.'],
      ['failed', 'The job changed, so the write was cancelled. Nothing was written.'],
      ['writing', 'This job is already being written or was already written, so this write was cancelled.'],
      ['succeeded', 'This job is already being written or was already written, so this write was cancelled.'],
    ])('closes when the job leaves diff_ready for %s while the dialog is open, saying %j', async (newStatus, message) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
      // Nothing else moves a diff_ready job's status under an open dialog; navigating to another job re-runs the job load.
      vi.spyOn(jobsApi, 'getJob').mockImplementation(async (jobId: string) =>
        jobOf(jobId, jobId === 'job-ws10b' ? { status: newStatus } : {}),
      );
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf());
      render(
        <ToastProvider>
          <MemoryRouter initialEntries={['/jobs/job-ws10a']}>
            <Link to="/jobs/job-ws10b">open b</Link>
            <Routes>
              <Route path="/jobs/:id" element={<JobDetail />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      );
      await waitFor(() => expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeInTheDocument());
      const { default: user } = await import('@testing-library/user-event');
      await user.click(screen.getByRole('button', { name: /^write to azure devops$/i }));
      expect(writeDialog()).toBeInTheDocument();

      await act(async () => fireEvent.click(screen.getByText('open b')));

      await waitFor(() => expect(writeDialog()).not.toBeInTheDocument());
      expect(await screen.findByText(message)).toBeInTheDocument();
      const other = message.startsWith('The job changed')
        ? 'This job is already being written or was already written, so this write was cancelled.'
        : 'The job changed, so the write was cancelled. Nothing was written.';
      expect(screen.queryByText(other)).not.toBeInTheDocument();
    });

    it('closes for its own write without treating that as a status change', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(jobOf('job-ws11'));
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf());
      vi.spyOn(jobsApi, 'confirmJob').mockReturnValue(new Promise(() => {}));
      const user = await openWriteDialog('job-ws11');
      await screen.findByText('2 new work items: 2 Requirements.');
      await user.click(screen.getByRole('checkbox', { name: /cannot be undone from req2ado/i }));

      await user.click(screen.getByRole('button', { name: 'Write 2 items to Compliance' }));

      await waitFor(() => expect(writeDialog()).not.toBeInTheDocument());
      expect(jobsApi.confirmJob).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/confirm failed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/write was cancelled/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/so this write was cancelled/i)).not.toBeInTheDocument();
    });

    it('counts items marked reviewed with Mark all reviewed as marked from a warning list', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue(
        jobOf('job-ws12', {
          mode: 'survey',
          dryRunDiff: [entry('a'), entry('b')],
          warnings: [{ kind: 'low_grounding', severity: 'needs_review', nodeIds: ['a', 'b'], detail: {}, raw: '2 nodes have low grounding.' }],
        }),
      );
      vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(previewOf());
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
      renderAt('job-ws12');
      const { default: user } = await import('@testing-library/user-event');
      await user.click(await screen.findByRole('button', { name: 'Review in tree' }));
      await user.click(screen.getByRole('button', { name: 'Mark all reviewed' }));

      await user.click(await screen.findByRole('button', { name: /^write to azure devops$/i }));

      expect(await screen.findByText('Review: 2 marked reviewed from a warning list.')).toBeInTheDocument();
    });
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
    expect(screen.getByText(/(proposed|written) items \(0\)/i)).toBeInTheDocument();
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
      fireEvent.click(await screen.findByRole('tab', { name: /^Parse/ })); // figures and the overview belong to the Parse phase
      // collapsed: it must not compete with the job's own progress; one click opens it
      await userEvent.click(await screen.findByRole('button', { name: /show/i }));
      expect(await screen.findByText('About a backplane.')).toBeInTheDocument();
    });

    it('is collapsed and belongs to the Parse phase while the run is on another phase', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-52', status: 'running', mode: 'survey', stage: 'parse', startedAt: new Date().toISOString(), dryRunDiff: [],
        documentOverview: { synopsis: 'x', caveat: null, lines: ['Structure line.', 'Another line.'], aiSummary: 'An AI summary of the file. More.' },
      } as any);
      renderAt('job-52');
      await userEvent.click(await screen.findByRole('tab', { name: /Parse/ }));
      await screen.findByText('Document overview');
      expect(screen.queryByText('Another line.')).not.toBeInTheDocument();
      const overview = screen.getByText('Document overview');
      const banner = document.querySelector('[data-testid="progress-banner"], [aria-label*="rogress"]');
      if (banner) expect(banner.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders each line of a stored overview that has lines, instead of one joined paragraph', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-51',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [],
        documentOverview: { synopsis: 'First line. Second line.', caveat: null, lines: ['First line.', 'Second line.'] },
      } as any);
      renderAt('job-51');
      fireEvent.click(await screen.findByRole('tab', { name: /^Parse/ })); // figures and the overview belong to the Parse phase
      await userEvent.click(await screen.findByRole('button', { name: /show/i }));
      expect(await screen.findByText('First line.')).toBeInTheDocument();
      expect(screen.getByText('Second line.')).toBeInTheDocument();
      expect(screen.queryByText('First line. Second line.')).not.toBeInTheDocument();
    });

    it('renders nothing for a SURVEY job that has no overview (documentOverview null)', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-51',
        status: 'diff_ready',
        mode: 'survey',
        dryRunDiff: [],
        documentOverview: null,
      } as any);
      renderAt('job-51');
      await waitFor(() => expect(screen.getByRole('tab', { name: /Proposed items/ })).toBeInTheDocument());
      expect(screen.queryByText(/document overview/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/isn.t produced for baseline/i)).not.toBeInTheDocument();
    });

    it('draws nothing for the document overview of a BASELINE job: no card and no placeholder box', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-52',
        status: 'diff_ready',
        mode: 'baseline',
        dryRunDiff: [],
        documentOverview: null,
      } as any);
      renderAt('job-52');
      await screen.findByRole('button', { name: /Run details/ });
      // Nothing is produced, so nothing is drawn: no placeholder box for something that does not exist (§16.22).
      expect(screen.queryByText(/isn.t produced for baseline jobs/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Document overview/)).not.toBeInTheDocument();
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

    it('does not call a queued job cancelled: no "Cancelled before a diff was produced" or "No diff was produced" while it waits for a worker', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-queued', status: 'pending', mode: 'survey', dryRunDiff: null } as any);
      renderAt('job-queued');
      await waitFor(() => expect(screen.getAllByText(/queued/i).length).toBeGreaterThan(0));
      expect(screen.queryByText('Cancelled before a diff was produced')).not.toBeInTheDocument();
      expect(screen.queryByText('No diff was produced')).not.toBeInTheDocument();
      expect(screen.queryByText(/was cancelled before parsing/i)).not.toBeInTheDocument();
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

    it('renders tabs and the summary line, but no run-detail panel, once diff_ready', async () => {
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
      await waitFor(() => expect(screen.getByTestId('review-header')).toHaveTextContent(/new ·/));
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
      expect(screen.queryByRole('tab', { name: /items \(/i })).not.toBeInTheDocument();
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
      // The phase rail carries the state: Write is skipped on a rejected job, not pending.
      expect(await screen.findByRole('tab', { name: /^Write/ })).toHaveTextContent(/Skipped/);
    });
  });

  it('says the job is loading to assistive technology from the first moment, while the placeholders are still undrawn', async () => {
    vi.spyOn(jobsApi, 'getJob').mockReturnValue(new Promise(() => {}) as any);
    renderAt('job-loading');
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/loading job/i);
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  describe('diff ready arrival (DESIGN.md section 8)', () => {
    const root = { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Root', description: '', action: 'create', customerId: null, tags: [] };

    it('announces the result once, fades the review area in, and leaves focus alone, when a running job finishes', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      vi.spyOn(jobsApi, 'getJob')
        .mockResolvedValueOnce({ id: 'job-arrive', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString() } as any)
        .mockResolvedValue({ id: 'job-arrive', status: 'diff_ready', mode: 'survey', dryRunDiff: [root], createdAt: new Date().toISOString() } as any);
      const events = await import('../api/events');
      let emitStage: (stage: string) => void = () => {};
      vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
        emitStage = onStage;
        return () => {};
      });
      renderAt('job-arrive');
      const region = await screen.findByTestId('live-status-region');
      expect(region).toHaveAttribute('role', 'status');
      expect(region).toBeEmptyDOMElement();
      const focused = document.activeElement;

      await act(async () => emitStage('diff_ready'));

      await waitFor(() => expect(screen.getByText('Root')).toBeInTheDocument());
      expect(region).toHaveTextContent(/diff is ready to review/i);
      expect(document.getElementById('proposed-tree')!.className).toContain('fadeIn');
      expect(document.activeElement).toBe(focused);
    });

    it('announces once and stops fading: a later edit does not re-announce, and the fade does not replay', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      vi.spyOn(jobsApi, 'getJob')
        .mockResolvedValueOnce({ id: 'job-once', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString() } as any)
        .mockResolvedValue({ id: 'job-once', status: 'diff_ready', mode: 'survey', dryRunDiff: [root], createdAt: new Date().toISOString() } as any);
      const events = await import('../api/events');
      let emitStage: (stage: string) => void = () => {};
      vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
        emitStage = onStage;
        return () => {};
      });
      renderAt('job-once');
      const region = await screen.findByTestId('live-status-region');
      await act(async () => emitStage('diff_ready'));
      await waitFor(() => expect(region).toHaveTextContent('The diff is ready to review: 1 item.'));

      await waitFor(() => expect(document.getElementById('proposed-tree')!.className).not.toContain('fadeIn'));
      expect(region).toHaveTextContent('The diff is ready to review: 1 item.');
    });

    it('does not carry one job\'s arrival over to the next job opened in the same page', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      let aCalls = 0;
      vi.spyOn(jobsApi, 'getJob').mockImplementation(async (id: string) => {
        if (id === 'job-a') {
          aCalls += 1;
          return (aCalls === 1
            ? { id, status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString() }
            : { id, status: 'diff_ready', mode: 'survey', dryRunDiff: [root], createdAt: new Date().toISOString() }) as any;
        }
        return { id, status: 'diff_ready', mode: 'survey', dryRunDiff: [root, { ...root, localId: 'e2', title: 'Second' }], createdAt: new Date().toISOString() } as any;
      });
      const events = await import('../api/events');
      let emitStage: (stage: string) => void = () => {};
      vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
        emitStage = onStage;
        return () => {};
      });
      render(
        <ToastProvider>
          <MemoryRouter initialEntries={['/jobs/job-a']}>
            <Link to="/jobs/job-b">open b</Link>
            <Routes>
              <Route path="/jobs/:id" element={<JobDetail />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      );
      await screen.findByTestId('live-status-region');
      await act(async () => emitStage('diff_ready'));
      await waitFor(() => expect(screen.getByTestId('live-status-region')).toHaveTextContent(/ready to review/)); // A finished while watched

      await userEvent.click(screen.getByRole('link', { name: 'open b' }));
      await waitFor(() => expect(screen.getByText('Second')).toBeInTheDocument());
      expect(screen.getByTestId('live-status-region')).toBeEmptyDOMElement();
      expect(document.getElementById('proposed-tree')!.className).not.toContain('fadeIn');
    });

    it('stays silent and still when a job is opened already finished', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-done', status: 'diff_ready', mode: 'survey', dryRunDiff: [root], createdAt: new Date().toISOString() } as any);
      renderAt('job-done');
      await waitFor(() => expect(screen.getByText('Root')).toBeInTheDocument());
      expect(screen.getByTestId('live-status-region')).toBeEmptyDOMElement();
      expect(document.getElementById('proposed-tree')!.className).not.toContain('fadeIn');
    });
  });
  describe('risk-ordered review queue (P17a)', () => {
    function req(localId: string, title: string, extra: Record<string, unknown> = {}) {
      return { localId, parentLocalId: null, type: 'Epic', title, description: '', action: 'create', customerId: null, tags: [], ...extra };
    }

    function mockQueueJob(status = 'diff_ready') {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-70',
        status,
        mode: 'survey',
        dryRunDiff: [
          req('clean', 'Clean item', { qualityScore: 95, groundingScore: 0.9 }),
          req('low', 'Low item', { qualityScore: 30 }),
          req('blocked', 'Blocked item', { qualityScore: 99 }),
        ],
        warnings: [{ kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['blocked'], detail: {}, raw: 'x' }],
      } as any);
    }

    async function startQueue() {
      mockQueueJob();
      vi.mocked(jobsApi.setDiffEntriesReviewed).mockClear();
      vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
      renderAt('job-70');
      const { default: userEvent } = await import('@testing-library/user-event');
      await userEvent.click(await screen.findByRole('button', { name: /review in risk order/i }));
      return userEvent;
    }

    it('offers the queue with the count of items still to review, only while the job awaits review', async () => {
      mockQueueJob();
      renderAt('job-70');
      expect(await screen.findByRole('button', { name: /review in risk order · 3/i })).toBeInTheDocument();
    });

    it('offers no queue once the job is past review', async () => {
      mockQueueJob('confirmed');
      renderAt('job-70');
      await waitFor(() => expect(screen.getByText('Clean item')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /review in risk order/i })).not.toBeInTheDocument();
    });

    it('opens on the riskiest item with the reason it is first', async () => {
      await startQueue();
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getAllByText('Blocked item').length).toBeGreaterThan(0);
      expect(within(dialog).getByRole('note')).toHaveTextContent(/blocking warning/i);
    });

    it('A does nothing on an item that blocks the write, and says why; the Keep as written button decides it', async () => {
      const userEvent = await startQueue();
      const dialog = await screen.findByRole('dialog');

      await userEvent.keyboard('a');

      expect(jobsApi.setDiffEntriesReviewed).not.toHaveBeenCalled();
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent(/kept as written/i);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Keep as written and next' }));
      expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-70', ['blocked'], true);
    });

    it('A accepts the item, steps to the next riskiest and announces what is left', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');

      await pressMark(userEvent);

      expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-70', ['blocked'], true);
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Low item').length).toBeGreaterThan(0));
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Marked reviewed. 2 left.');
    });

    it('says where the reviewer is: "1 of 3" on the first item, and "1 of 2" on the next after one is marked', async () => {
      const userEvent = await startQueue();
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('note')).toHaveTextContent('1 of 3');
      await pressMark(userEvent);
      await waitFor(() => expect(within(dialog).getByRole('note')).toHaveTextContent('1 of 2'));
    });

    it('X excludes the item, steps on and announces it', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(async (_id, localId) => ({
        dryRunDiff: [
          req('clean', 'Clean item', { qualityScore: 95, groundingScore: 0.9 }),
          req('low', 'Low item', { qualityScore: 30 }),
          req('blocked', 'Blocked item', { qualityScore: 99, excluded: localId === 'blocked' }),
        ],
      }) as any);

      await userEvent.keyboard('x');

      await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledWith('job-70', 'blocked', true));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Low item').length).toBeGreaterThan(0));
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Excluded. 2 left.');
    });

    it('X and A step to the item after the current one, not back to the top of the queue (R5)', async () => {
      const rq = (localId: string, title: string, extra: Record<string, unknown> = {}) => ({
        localId, parentLocalId: null, type: 'Requirement', title, description: '', action: 'create', customerId: null, tags: [], ...extra,
      });
      const items = (excluded?: string) => [
        rq('b1', 'Blocked one', { qualityScore: 99 }),
        rq('l1', 'Low one', { qualityScore: 30, excluded: excluded === 'l1' }),
        rq('l2', 'Low two', { qualityScore: 35 }),
        rq('l3', 'Low three', { qualityScore: 40 }),
      ];
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-72', status: 'diff_ready', mode: 'survey', dryRunDiff: items(),
        warnings: [{ kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['b1'], detail: {}, raw: 'x' }],
      } as any);
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(async (_id, localId) => ({ dryRunDiff: items(localId) }) as any);
      renderAt('job-72');
      const { default: userEvent } = await import('@testing-library/user-event');
      await userEvent.click(await screen.findByRole('button', { name: /review in risk order/i }));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Blocked one').length).toBeGreaterThan(0));

      await userEvent.keyboard('j');
      await waitFor(() => expect(within(dialog).getAllByText('Low one').length).toBeGreaterThan(0));
      await userEvent.keyboard('x');

      await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledWith('job-72', 'l1', true));
      // The next in line, "Low two", not the top of the queue.
      await waitFor(() => expect(within(dialog).getAllByText('Low two').length).toBeGreaterThan(0));
      expect(within(dialog).queryAllByText('Blocked one')).toHaveLength(0);
    });

    it('with a group chip pressed the queue is that group: the counter counts it and J and K do not leave it', async () => {
      const rq = (localId: string, title: string, extra: Record<string, unknown> = {}) => ({
        localId, parentLocalId: null, type: 'Requirement', title, description: '', action: 'create', customerId: null, tags: [], ...extra,
      });
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-73', status: 'diff_ready', mode: 'survey',
        dryRunDiff: [
          rq('c1', 'Check one', { qualityScore: 30 }),
          rq('c2', 'Check two', { qualityScore: 35 }),
          rq('ok', 'Clean one', { qualityScore: 95, groundingScore: 0.9 }),
        ],
        warnings: [],
      } as any);
      renderAt('job-73');
      const { default: userEvent } = await import('@testing-library/user-event');
      await userEvent.click(await screen.findByRole('button', { name: /^check · 2$/i }));
      await userEvent.click(screen.getByRole('button', { name: /^review in check · 2$/i }));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getByRole('note')).toHaveTextContent('1 of 2'));

      await userEvent.keyboard('j');
      await waitFor(() => expect(within(dialog).getByRole('note')).toHaveTextContent('2 of 2'));
      await userEvent.keyboard('j'); // the end of the group: J does not step onto the clean item
      await waitFor(() => expect(within(dialog).getByRole('note')).toHaveTextContent('2 of 2'));
      expect(within(dialog).queryAllByText('Clean one')).toHaveLength(0);
    });

    it('outside the queue, J and K follow the order the tree is drawn in, even when the diff lists a parent last', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-71',
        status: 'diff_ready',
        mode: 'survey',
        // A wrapper Epic is listed after its child, but drawn first.
        dryRunDiff: [
          req('child', 'Child feature', { type: 'Feature', parentLocalId: 'wrapper' }),
          req('wrapper', 'Wrapper epic'),
        ],
        warnings: [],
      } as any);
      renderAt('job-71');
      const { default: userEvent } = await import('@testing-library/user-event');
      await waitFor(() => expect(screen.getByText('Wrapper epic')).toBeInTheDocument());
      await openNodeDetails(userEvent, 'Wrapper epic');

      await userEvent.keyboard('j');

      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Child feature').length).toBeGreaterThan(0));
    });

    it('J and K follow the risk order, not the tree order', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');

      await userEvent.keyboard('j');
      let dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Low item').length).toBeGreaterThan(0));
      await userEvent.keyboard('j');
      dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Clean item').length).toBeGreaterThan(0));
      await userEvent.keyboard('k');
      dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Low item').length).toBeGreaterThan(0));
    });

    it('closes the dialog and announces the end after the last item', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');

      await pressMark(userEvent);
      await pressMark(userEvent);
      await pressMark(userEvent);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-70', ['clean'], true);
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Marked reviewed. Review queue done.');
    });

    it('moves focus to a "Review queue done." row after the last item, since the queue button it came from is gone', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');

      await pressMark(userEvent);
      await pressMark(userEvent);
      await pressMark(userEvent);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByText('Review queue done.')).toHaveFocus());
      expect(screen.queryByRole('button', { name: /review in risk order/i })).not.toBeInTheDocument();
    });

    it('brings the queue button back, and drops the done row, when an accept is undone', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      await pressMark(userEvent);
      await pressMark(userEvent);
      await pressMark(userEvent);
      await waitFor(() => expect(screen.getByText('Review queue done.')).toBeInTheDocument());

      await userEvent.click((await screen.findAllByRole('button', { name: 'Undo' })).at(-1)!);

      expect(await screen.findByRole('button', { name: /review in risk order · 1/i })).toBeInTheDocument();
      expect(screen.queryByText('Review queue done.')).not.toBeInTheDocument();
    });

    function excludedDiff(excludedId: string) {
      return {
        dryRunDiff: [
          req('clean', 'Clean item', { qualityScore: 95, groundingScore: 0.9 }),
          req('low', 'Low item', { qualityScore: 30 }),
          req('blocked', 'Blocked item', { qualityScore: 99, excluded: excludedId === 'blocked' }),
        ],
      } as any;
    }

    it('keeps the item open and says so when an exclude fails, instead of announcing it as done', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockRejectedValue(new Error('network'));

      await userEvent.keyboard('x');

      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Couldn\'t exclude "Blocked item". Try again.'));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getAllByText('Blocked item').length).toBeGreaterThan(0);
      expect(screen.getByTestId('review-queue-status')).not.toHaveTextContent(/excluded\./i);
    });

    it('does not reopen a closed dialog, or say the queue is done, when the last reviewed mark fails', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      vi.mocked(jobsApi.setDiffEntriesReviewed)
        .mockResolvedValueOnce({ dryRunDiff: [] })
        .mockResolvedValueOnce({ dryRunDiff: [] })
        .mockRejectedValueOnce(new Error('network'));

      await pressMark(userEvent);
      await pressMark(userEvent);
      await pressMark(userEvent);

      await waitFor(() =>
        expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Couldn\'t mark "Clean item" reviewed. Try again.'),
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Review queue done.')).not.toBeInTheDocument();
      // The queue button is back with the item that is still to review, and holds focus.
      const button = await screen.findByRole('button', { name: /review in risk order · 1/i });
      await waitFor(() => expect(button).toHaveFocus());
    });

    it('brings the reviewer back to the item, by name, when a mark fails while the dialog is still open', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      vi.mocked(jobsApi.setDiffEntriesReviewed).mockRejectedValueOnce(new Error('network'));

      await pressMark(userEvent);

      await waitFor(() =>
        expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Couldn\'t mark "Blocked item" reviewed. Try again.'),
      );
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Blocked item').length).toBeGreaterThan(0));
    });

    it('repeats the announcement inside the open dialog, where a screen reader can hear it', async () => {
      const userEvent = await startQueue();
      const dialog = await screen.findByRole('dialog');

      await pressMark(userEvent);

      await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Marked reviewed. 2 left.'));
    });

    // Marking reviewed saves optimistically and in sequence (G3), so only the exclude, which waits for the server, is busy.
    it('marks the dialog buttons busy while an exclude is saving', async () => {
      const userEvent = await startQueue();
      const dialog = await screen.findByRole('dialog');
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(() => new Promise(() => {}));

      await userEvent.keyboard('x');

      const mark = within(dialog).getByRole('button', { name: 'Keep as written and next' });
      await waitFor(() => expect(mark).toHaveAttribute('aria-busy', 'true'));
      expect(mark).toHaveAttribute('aria-disabled', 'true');
      expect(mark).not.toBeDisabled();
    });

    it('offers Undo after X, naming what was excluded, and Undo includes it again', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      const excludeSpy = vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(async (_id, localId, excluded) =>
        excludedDiff(excluded ? localId : ''),
      );

      await userEvent.keyboard('x');

      expect(await screen.findByText('Excluded "Blocked item".')).toBeInTheDocument();
      // The dialog is still open (modal), which hides the toast from role queries.
      await userEvent.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
      await waitFor(() => expect(excludeSpy).toHaveBeenLastCalledWith('job-70', 'blocked', false));
    });

    it('says it is still saving, and acts once, when X is pressed again before the exclude comes back', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      const excludeSpy = vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(() => new Promise(() => {}));

      await userEvent.keyboard('x');
      await userEvent.keyboard('x');

      expect(excludeSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Still saving. Try again.');
    });

    it('ends the queue as done, with focus on the done row, when the exclude reply that empties it arrives while the exclude is still saving', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      let reply: (value: unknown) => void = () => {};
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(() => new Promise((resolve) => { reply = resolve; }));

      await pressMark(userEvent); // 'blocked' reviewed
      await pressMark(userEvent); // 'low' reviewed, now on 'clean'
      await userEvent.keyboard('x'); // exclude the last item, pending
      // The queue is empty the moment the reply lands, a render before the queue steps on.
      reply({
        dryRunDiff: [
          req('clean', 'Clean item', { qualityScore: 95, groundingScore: 0.9, excluded: true }),
          req('low', 'Low item', { qualityScore: 30 }),
          req('blocked', 'Blocked item', { qualityScore: 99 }),
        ],
      });

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Excluded. Review queue done.');
      await waitFor(() => expect(screen.getByText('Review queue done.')).toHaveFocus());
    });

    it('does not let an exclude reply flip an item that was just marked reviewed back to unreviewed', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      // The reply is a snapshot taken before the accept of 'low' reached the server.
      let reply: (value: unknown) => void = () => {};
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(() => new Promise((resolve) => { reply = resolve; }));

      await pressMark(userEvent); // 'blocked' reviewed, now on 'low'
      await userEvent.keyboard('x'); // exclude 'low', pending
      reply({
        dryRunDiff: [
          req('clean', 'Clean item', { qualityScore: 95, groundingScore: 0.9 }),
          req('low', 'Low item', { qualityScore: 30, excluded: true }),
          req('blocked', 'Blocked item', { qualityScore: 99 }), // server snapshot: not yet reviewed
        ],
      });

      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Excluded. 1 left.'));
      // Only 'clean' is left: the reviewed 'blocked' did not come back into the queue.
      expect(await screen.findByRole('button', { name: /review in risk order · 1/i, hidden: true })).toBeInTheDocument();
    });

    it('U undoes the last accept, announces it, and offers the hint', async () => {
      const userEvent = await startQueue();
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('note')).not.toHaveTextContent(/U\s*undo/);

      await pressMark(userEvent);
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Marked reviewed. 2 left.'));
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('note')).toHaveTextContent(/U\s*undo/));
      await userEvent.keyboard('u');

      await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-70', ['blocked'], false));
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Undone: "Blocked item".'));
      // Nothing left to undo: a second U does not repeat it.
      const calls = vi.mocked(jobsApi.setDiffEntriesReviewed).mock.calls.length;
      await userEvent.keyboard('u');
      expect(vi.mocked(jobsApi.setDiffEntriesReviewed).mock.calls.length).toBe(calls);
    });

    it('U undoes the last exclude', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      const setExcluded = vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(async (_id, localId, excluded) => excludedDiff(excluded ? localId : '') as any);

      await userEvent.keyboard('x');
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Excluded. 2 left.'));
      await userEvent.keyboard('u');

      await waitFor(() => expect(setExcluded).toHaveBeenLastCalledWith('job-70', 'blocked', false));
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Undone: "Blocked item".'));
    });

    it('says so, and keeps the undo, when U is pressed while another save is running', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      await pressMark(userEvent);
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Marked reviewed. 2 left.'));
      // The next item's exclude never answers, so a save is running.
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockReturnValue(new Promise(() => {}));
      await userEvent.keyboard('x');
      const calls = vi.mocked(jobsApi.setDiffEntriesReviewed).mock.calls.length;

      await userEvent.keyboard('u');

      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Still saving. Try again.'));
      expect(vi.mocked(jobsApi.setDiffEntriesReviewed).mock.calls.length).toBe(calls);
    });

    it('says so, and keeps the undo for another try, when U fails to undo', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      const setExcluded = vi
        .spyOn(jobsApi, 'setDiffEntryExcluded')
        .mockImplementationOnce(async (_id, localId) => excludedDiff(localId) as any)
        .mockRejectedValueOnce(new Error('network'));
      await userEvent.keyboard('x');
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Excluded. 2 left.'));

      await userEvent.keyboard('u');

      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Couldn\'t undo "Blocked item". Try again.'));
      expect(within(screen.getByRole('dialog')).getByRole('note')).toHaveTextContent(/U\s*undo/);
      setExcluded.mockImplementation(async (_id, localId, excluded) => excludedDiff(excluded ? localId : '') as any);
      await userEvent.keyboard('u');
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Undone: "Blocked item".'));
    });

    it('does not undo a second time with U after the toast Undo already did', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      const setExcluded = vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(async (_id, localId, excluded) => excludedDiff(excluded ? localId : '') as any);
      await userEvent.keyboard('x');
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Excluded. 2 left.'));

      await userEvent.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
      await waitFor(() => expect(setExcluded).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('note')).not.toHaveTextContent(/U\s*undo/));
      await userEvent.keyboard('u');

      expect(setExcluded).toHaveBeenCalledTimes(2);
    });

    it('does not undo a second time with U after the toast Undo of an accept already did', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      await pressMark(userEvent);
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Marked reviewed. 2 left.'));

      await userEvent.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
      await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-70', ['blocked'], false));
      const calls = vi.mocked(jobsApi.setDiffEntriesReviewed).mock.calls.length;
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('note')).not.toHaveTextContent(/U\s*undo/));
      await userEvent.keyboard('u');

      expect(vi.mocked(jobsApi.setDiffEntriesReviewed).mock.calls.length).toBe(calls);
    });

    it('speaks a repeated "Still saving" again, since the text is identical', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      await pressMark(userEvent);
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Marked reviewed. 2 left.'));
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockReturnValue(new Promise(() => {}));
      await userEvent.keyboard('x');
      const region = screen.getByTestId('review-queue-status');
      const written: string[] = [];
      const observer = new MutationObserver(() => written.push(region.textContent ?? ''));
      observer.observe(region, { childList: true, characterData: true, subtree: true });
      try {
        await userEvent.keyboard('u');
        await userEvent.keyboard('u');
        await waitFor(() => expect(written.filter((text) => text.startsWith('Still saving. Try again.')).length).toBe(2));
      } finally {
        observer.disconnect();
      }
    });

    it('speaks a repeated identical failure again, by clearing the message when a new attempt starts', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockRejectedValue(new Error('network'));
      const region = screen.getByTestId('review-queue-status');
      const message = 'Couldn\'t exclude "Blocked item". Try again.';
      const written: string[] = [];
      const observer = new MutationObserver(() => written.push(region.textContent ?? ''));
      observer.observe(region, { childList: true, characterData: true, subtree: true });
      try {
        await userEvent.keyboard('x');
        await waitFor(() => expect(region).toHaveTextContent(message));
        await userEvent.keyboard('x');
        await waitFor(() => expect(written.filter((text) => text === message).length).toBe(2));
      } finally {
        observer.disconnect();
      }
    });

    it('puts focus back on the queue button when the dialog is closed mid-queue', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      // The app's dialogs have no Radix trigger to hand focus back to, so the page does it.
      await waitFor(() => expect(screen.getByRole('button', { name: /review in risk order/i })).toHaveFocus());
    });

    it('does nothing on a key when shortcuts are switched off in Settings', async () => {
      const { useUiPreferencesStore } = await import('../store/uiPreferencesStore');
      useUiPreferencesStore.getState().setKeyboardShortcuts(false);
      try {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        await userEvent.keyboard('a');
        expect(jobsApi.setDiffEntriesReviewed).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: 'Keep as written and next' }));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-70', ['blocked'], true);
      } finally {
        useUiPreferencesStore.getState().setKeyboardShortcuts(true);
      }
    });

    it('leaves queue mode when the dialog is closed, so a tree click opens in tree order again', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      expect(await screen.findByRole('button', { name: /review in risk order · 3/i })).toBeInTheDocument();
    });

    describe('review-state races (G3)', () => {
      const rows = (excludedId?: string) => [
        req('clean', 'Clean item', { qualityScore: 95, groundingScore: 0.9 }),
        req('low', 'Low item', { qualityScore: 30 }),
        req('blocked', 'Blocked item', { qualityScore: 99, excluded: excludedId === 'blocked' }),
      ];

      it('U undoes the most recent accept, not the one whose save finishes last', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const first = deferred<{ dryRunDiff: never[] }>();
        const second = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed)
          .mockImplementationOnce(() => first.promise as never)
          .mockImplementationOnce(() => second.promise as never);

        await pressMark(userEvent);
        await pressMark(userEvent);
        // Saves are sent one at a time, so the second goes out once the first has finished.
        await act(async () => first.resolve({ dryRunDiff: [] }));
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(2));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenNthCalledWith(1, 'job-70', ['blocked'], true);
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenNthCalledWith(2, 'job-70', ['low'], true);
        await act(async () => second.resolve({ dryRunDiff: [] }));

        await userEvent.keyboard('u');

        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(3));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-70', ['low'], false);
      });

      it('U right after an accept sends its Undo only once the accept has been saved, so the server ends in the same state', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const first = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockImplementationOnce(() => first.promise as never);

        await pressMark(userEvent);
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await userEvent.keyboard('u');
        // Give the Undo every chance to go out early.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1);

        await act(async () => first.resolve({ dryRunDiff: [] }));

        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(2));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenNthCalledWith(1, 'job-70', ['blocked'], true);
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenNthCalledWith(2, 'job-70', ['blocked'], false);
      });

      it('a failed review save does not stop the next one from being sent', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const first = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockImplementationOnce(() => first.promise as never);

        await pressMark(userEvent);
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await pressMark(userEvent);
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1);
        await act(async () => first.reject(new Error('network')));

        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(2));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenNthCalledWith(2, 'job-70', ['low'], true);
      });

      const queueButtonCount = (count: number) => screen.findByRole('button', { name: new RegExp(`review in risk order · ${count}`, 'i') });

      it('a mark and its Undo that both fail leave the item as the server has it (not reviewed)', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const first = deferred<{ dryRunDiff: never[] }>();
        const second = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed)
          .mockImplementationOnce(() => first.promise as never)
          .mockImplementationOnce(() => second.promise as never);

        await pressMark(userEvent);
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await userEvent.keyboard('u');
        await act(async () => first.reject(new Error('network')));
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(2));
        await act(async () => second.reject(new Error('network')));
        await screen.findAllByText(/failed to update review state/i);

        // An error toast has focus by now, so Escape would go to it; the close button is used instead.
        await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(await queueButtonCount(3)).toBeInTheDocument();
      });

      it('a failed older mark does not undo a newer mark that was saved', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const first = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockImplementationOnce(() => first.promise as never);

        await pressMark(userEvent);
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await userEvent.keyboard('u');
        await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Low item').length).toBeGreaterThan(0));
        await userEvent.keyboard('k');
        await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Blocked item').length).toBeGreaterThan(0));
        await pressMark(userEvent);
        await act(async () => first.reject(new Error('network')));
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(3));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenNthCalledWith(3, 'job-70', ['blocked'], true);
        // The failed call was superseded by newer writes on its item, so it has nothing to put back and says nothing.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(screen.queryByText(/failed to update review state/i)).not.toBeInTheDocument();

        await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(await queueButtonCount(2)).toBeInTheDocument();
      });

      it('a lone failing mark is rolled back to not reviewed', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockRejectedValueOnce(new Error('network'));

        await pressMark(userEvent);
        await screen.findAllByText(/failed to update review state/i);

        // An error toast has focus by now, so Escape would go to it; the close button is used instead.
        await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(await queueButtonCount(3)).toBeInTheDocument();
      });

      it('the toast Undo of a mark that is no longer in force says there is nothing left to undo, and sends nothing', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        await pressMark(userEvent);
        await waitFor(() => expect(screen.getAllByText('Undo').length).toBeGreaterThan(0));
        const olderToastUndo = screen.getAllByText('Undo')[0].closest('button')!;
        // U takes the mark back first, so the older toast's Undo has nothing to do.
        await userEvent.keyboard('u');
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(2));

        fireEvent.click(olderToastUndo);

        await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Nothing left to undo.'));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(2);
      });

      it('a save that fails after the page moved to another job shows no error and touches nothing', async () => {
        mockQueueJob();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockClear();
        const save = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockImplementationOnce(() => save.promise as never);
        const original = vi.mocked(jobsApi.getJob).getMockImplementation();
        vi.spyOn(jobsApi, 'getJob').mockImplementation((async (jobId: string) =>
          jobId === 'job-71'
            ? { id: 'job-71', status: 'diff_ready', mode: 'survey', dryRunDiff: [req('other', 'Other job item')], warnings: [] }
            : { id: 'job-70', status: 'diff_ready', mode: 'survey', dryRunDiff: rows(), warnings: [] }) as never);
        const { default: userEvent } = await import('@testing-library/user-event');
        render(
          <ToastProvider>
            <MemoryRouter initialEntries={['/jobs/job-70']}>
              <Link to="/jobs/job-71">go to the other job</Link>
              <Routes>
                <Route path="/jobs/:id" element={<JobDetail />} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>,
        );
        await userEvent.click(await screen.findByRole('button', { name: /review in risk order/i }));
        await pressMark(userEvent);
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await userEvent.keyboard('{Escape}');
        await userEvent.click(await screen.findByRole('link', { name: 'go to the other job' }));
        await screen.findByText('Other job item');

        await act(async () => save.reject(new Error('network')));

        expect(screen.queryByText(/failed to update review state/i)).not.toBeInTheDocument();
        expect(screen.getByText('Other job item')).toBeInTheDocument();
        if (original) vi.mocked(jobsApi.getJob).mockImplementation(original);
      });

      it('an exclude that finishes after the reviewer moved on (J) does not pull the selection back', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const save = deferred<{ dryRunDiff: unknown[] }>();
        vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(() => save.promise as never);

        await userEvent.keyboard('x');
        await userEvent.keyboard('j');
        await userEvent.keyboard('j');
        await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Clean item').length).toBeGreaterThan(0));
        await act(async () => save.resolve({ dryRunDiff: rows('blocked') }));

        await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Excluded. 2 left.'));
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getAllByText('Clean item').length).toBeGreaterThan(0);
        expect(within(dialog).queryAllByText('Low item')).toHaveLength(0);
      });

      it('the exclude toast\'s Undo while another save is in flight says so and keeps U working', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const pendingLow = deferred<{ dryRunDiff: unknown[] }>();
        vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation((async (_id: string, localId: string, excluded: boolean) => {
          if (localId === 'low') return pendingLow.promise;
          return { dryRunDiff: rows(excluded ? localId : undefined) };
        }) as never);

        await userEvent.keyboard('x');
        await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Excluded. 2 left.'));
        const toastUndo = (await screen.findByText('Undo')).closest('button')!;
        // The next exclude (the Low item) is still saving when the toast's Undo is pressed.
        await userEvent.keyboard('x');
        await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledWith('job-70', 'low', true));
        fireEvent.click(toastUndo);

        await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Still saving. Try again.'));
        expect(jobsApi.setDiffEntryExcluded).not.toHaveBeenCalledWith('job-70', 'blocked', false);
        await act(async () => pendingLow.reject(new Error('network')));
        await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent(/couldn't exclude/i));

        await userEvent.keyboard('u');

        await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledWith('job-70', 'blocked', false));
      });
    });

    describe('review-state hardening (G3b)', () => {
      const rowsWith = (extra: unknown[] = []) => [
        req('clean', 'Clean item', { qualityScore: 95, groundingScore: 0.9 }),
        req('low', 'Low item', { qualityScore: 30 }),
        req('blocked', 'Blocked item', { qualityScore: 99 }), // a server snapshot that does not have the mark yet
        ...extra,
      ];

      // Marks 'blocked' with its save left pending, then closes the dialog so the tree is reachable.
      async function markBlockedPending() {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const first = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockImplementationOnce(() => first.promise as never);
        await pressMark(userEvent);
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(await screen.findByRole('button', { name: /review in risk order · 2/i })).toBeInTheDocument();
        return { userEvent, first };
      }

      it('an added item whose reply predates a pending mark does not un-review it, and a later failure rolls it back to the confirmed state', async () => {
        const { userEvent, first } = await markBlockedPending();
        vi.mocked(jobsApi.addDiffEntry).mockResolvedValue({
          dryRunDiff: rowsWith([req('added', 'Added item', { reviewed: true })]),
        } as never);

        await userEvent.click(screen.getByRole('button', { name: /^new item$/i }));
        await userEvent.type(screen.getByLabelText(/title/i), 'Added item');
        await userEvent.type(screen.getByLabelText(/description/i), 'd');
        await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
        await screen.findByText('Added item');

        // 'blocked' is still marked on screen: the queue did not get it back.
        expect(screen.getByRole('button', { name: /review in risk order · 2/i })).toBeInTheDocument();

        await act(async () => first.reject(new Error('network')));
        await screen.findAllByText(/failed to update review state/i);
        // The save failed, so the server never had the mark: back to what it confirmed (not reviewed).
        expect(await screen.findByRole('button', { name: /review in risk order · 3/i })).toBeInTheDocument();
      });

      it('a bulk exclude whose replies predate a pending mark does not un-review it', async () => {
        const { userEvent } = await markBlockedPending();
        vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation((async () => ({ dryRunDiff: rowsWith() })) as never);

        await userEvent.click(screen.getByRole('button', { name: /^exclude all$/i }));
        await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledTimes(3));
        await screen.findByText(/excluded 3 items/i);

        expect(screen.getByRole('button', { name: /review in risk order · 2/i })).toBeInTheDocument();
      });

      it('a failed call that a newer write on the same item superseded neither says so nor sends the reviewer back to that item', async () => {
        const userEvent = await startQueue();
        await screen.findByRole('dialog');
        const first = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockImplementationOnce(() => first.promise as never);

        await pressMark(userEvent); // 'blocked', pending
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await userEvent.keyboard('u'); // takes it back: a newer write on the same item
        await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Low item').length).toBeGreaterThan(0));
        await userEvent.keyboard('k');
        await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Blocked item').length).toBeGreaterThan(0));
        await pressMark(userEvent); // and marks it again
        await waitFor(() => expect(within(screen.getByRole('dialog')).queryAllByText('Blocked item')).toHaveLength(0));

        await act(async () => first.reject(new Error('network')));
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(3));
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(screen.queryByText(/failed to update review state/i)).not.toBeInTheDocument();
        expect(screen.getByTestId('review-queue-status')).not.toHaveTextContent(/couldn't mark/i);
        expect(within(screen.getByRole('dialog')).queryAllByText('Blocked item')).toHaveLength(0);
      });

      it('a save that finishes after the page is gone shows no toast and logs no error', async () => {
        mockQueueJob();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockClear();
        const save = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockImplementationOnce(() => save.promise as never);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { default: userEvent } = await import('@testing-library/user-event');
        render(
          <ToastProvider>
            <MemoryRouter initialEntries={['/jobs/job-70']}>
              <Link to="/elsewhere">leave</Link>
              <Routes>
                <Route path="/jobs/:id" element={<JobDetail />} />
                <Route path="/elsewhere" element={<p>elsewhere page</p>} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>,
        );
        await userEvent.click(await screen.findByRole('button', { name: /review in risk order/i }));
        await pressMark(userEvent);
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
        await userEvent.keyboard('{Escape}');
        await userEvent.click(await screen.findByRole('link', { name: 'leave' }));
        await screen.findByText('elsewhere page');

        await act(async () => save.resolve({ dryRunDiff: [] }));
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(screen.queryByText(/marked reviewed/i)).not.toBeInTheDocument();
        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
      });
    });
  });

  describe('approve clean items (P17c)', () => {
    function item(localId: string, title: string, extra: Record<string, unknown> = {}) {
      return {
        localId, parentLocalId: null, type: 'Requirement', title, description: '', action: 'create', customerId: null, tags: [],
        qualityScore: 80, groundingScore: 0.9, ...extra,
      };
    }
    const CLEAN_IDS = ['c1', 'c2', 'c3', 'c4', 'c5'];
    function diffRows(excludedId?: string) {
      return [
        item('c1', 'Clean one', { qualityScore: 60, excluded: excludedId === 'c1' }),
        item('c2', 'Clean two', { qualityScore: 70 }),
        item('c3', 'Clean three', { qualityScore: 80 }),
        item('c4', 'Clean four', { qualityScore: 90 }),
        item('c5', 'Clean five', { qualityScore: 95 }),
        item('low', 'Low item', { qualityScore: 30 }),
        item('unscored', 'Unscored item', { qualityScore: null, groundingScore: null }),
      ];
    }
    function mockJob(overrides: Record<string, unknown> = {}) {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-80', status: 'diff_ready', mode: 'survey', dryRunDiff: diffRows(), warnings: [], ...overrides,
      } as any);
    }
    async function render80(overrides: Record<string, unknown> = {}) {
      mockJob(overrides);
      vi.mocked(jobsApi.setDiffEntriesReviewed).mockClear();
      vi.mocked(jobsApi.setDiffEntriesReviewed).mockResolvedValue({ dryRunDiff: [] });
      renderAt('job-80');
      const { default: userEvent } = await import('@testing-library/user-event');
      return userEvent;
    }
    async function openConfirmation(userEvent: Awaited<ReturnType<typeof render80>>) {
      await userEvent.click(await screen.findByRole('button', { name: 'Approve 5 clean items' }));
      return screen.findByRole('dialog', { name: 'Approve 5 clean items?' });
    }
    // The sample of five is the lowest, the middle and the highest.
    async function spotCheckAll(userEvent: Awaited<ReturnType<typeof render80>>) {
      await userEvent.click(screen.getByRole('button', { name: 'Start spot-check' }));
      for (const title of ['Clean one', 'Clean three', 'Clean five']) {
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(within(dialog).getAllByText(title).length).toBeGreaterThan(0));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Looks right and next' }));
      }
      return screen.findByRole('dialog', { name: 'Approve 5 clean items?' });
    }

    it('reports in the write summary how bulk-approved items were reviewed: looked at in the spot-check, or not', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
      vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue({
        createdTotal: 7,
        createdLocalIds: [...CLEAN_IDS, 'low', 'unscored'],
        createdByType: { Requirement: 7 },
        excluded: { direct: 0, viaAncestor: 0 },
        parentLinks: 0,
        figuresToAttach: 0,
        figuresUnavailable: 0,
        existingGettingChildren: 0,
        existingWithoutNewParentLink: 0,
        traceLinks: { planned: 0, skipped: 0 },
        hasWork: true,
        figuresOnly: false,
      });
      const userEvent = await render80({ areaPath: 'Compliance\\Auth', adoProject: 'Compliance' });
      await openConfirmation(userEvent);
      const dialog = await spotCheckAll(userEvent);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Approve 5 clean items' }));
      await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-80', CLEAN_IDS, true));

      await userEvent.click(screen.getByRole('button', { name: /^write to azure devops$/i }));
      expect(
        await screen.findByText('Review: 3 approved in bulk after you looked at them, 2 approved in bulk without being looked at, 2 not reviewed.'),
      ).toBeInTheDocument();
    });

    it('offers the action only for a SURVEY job awaiting review that has clean items', async () => {
      await render80();
      expect(await screen.findByRole('button', { name: 'Approve 5 clean items' })).toBeInTheDocument();
    });

    it('offers nothing for a BASELINE job, a job past review, or when nothing is clean', async () => {
      mockJob({ mode: 'baseline' });
      const first = renderAt('job-80');
      await waitFor(() => expect(screen.getByText('Clean one')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /clean items?$/i })).not.toBeInTheDocument();
      first.unmount();

      mockJob({ status: 'confirmed' });
      const second = renderAt('job-80');
      await waitFor(() => expect(screen.getByText('Clean one')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /clean items?$/i })).not.toBeInTheDocument();
      second.unmount();

      mockJob({ dryRunDiff: [item('only', 'Only flagged', { qualityScore: 20 })] });
      renderAt('job-80');
      await waitFor(() => expect(screen.getByText('Only flagged')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /clean items?$/i })).not.toBeInTheDocument();
    });

    it('opens a confirmation with the count and what is left out, focus on Cancel, and writes nothing', async () => {
      const userEvent = await render80();
      const dialog = await openConfirmation(userEvent);
      expect(dialog).toHaveTextContent('60 to 95');
      expect(dialog).toHaveTextContent('2 items left out: 1 flagged or with warnings, 1 not scored');
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      expect(within(dialog).getByRole('button', { name: 'Approve 5 clean items' })).toBeDisabled();
      expect(jobsApi.setDiffEntriesReviewed).not.toHaveBeenCalled();
    });

    it('steps through the sample, lowest score first, and only then enables the approval', async () => {
      const userEvent = await render80();
      await openConfirmation(userEvent);
      await userEvent.click(screen.getByRole('button', { name: 'Start spot-check' }));
      const first = await screen.findByRole('dialog');
      await waitFor(() => expect(within(first).getAllByText('Clean one').length).toBeGreaterThan(0));
      expect(within(first).getByRole('button', { name: 'Looks right and next' })).toBeInTheDocument();

      await userEvent.click(within(first).getByRole('button', { name: 'Looks right and next' }));
      await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Clean three').length).toBeGreaterThan(0));
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Looks right. 1 of 3 checked.');
      await pressMark(userEvent);
      await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Clean five').length).toBeGreaterThan(0));
      await pressMark(userEvent);

      const confirmation = await screen.findByRole('dialog', { name: 'Approve 5 clean items?' });
      expect(confirmation).toHaveTextContent('3 of 3 checked');
      expect(within(confirmation).getByRole('button', { name: 'Approve 5 clean items' })).toBeEnabled();
      expect(jobsApi.setDiffEntriesReviewed).not.toHaveBeenCalled();
    });

    it('focus: starting the spot-check leaves focus inside the details dialog, not stolen by the closing bulk dialog', async () => {
      const userEvent = await render80();
      await openConfirmation(userEvent);
      await userEvent.click(screen.getByRole('button', { name: 'Start spot-check' }));
      const details = await screen.findByRole('dialog');
      await waitFor(() => expect(within(details).getAllByText('Clean one').length).toBeGreaterThan(0));
      // Let the closing bulk dialog's exit finish; focus must still be in the details dialog.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(details.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(document.body);
    });

    it('focus: after the spot-check completes and the confirmation is cancelled, focus is on the "Approve N clean items" button', async () => {
      const userEvent = await render80();
      await openConfirmation(userEvent);
      const confirmation = await spotCheckAll(userEvent);
      await userEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const header = screen.getByRole('button', { name: 'Approve 5 clean items' });
      await waitFor(() => expect(document.activeElement).toBe(header));
    });

    it('returns to the confirmation, keeping the progress, when the reviewer leaves the spot-check with Escape', async () => {
      const userEvent = await render80();
      await openConfirmation(userEvent);
      await userEvent.click(screen.getByRole('button', { name: 'Start spot-check' }));
      await screen.findByRole('dialog');
      await pressMark(userEvent);
      await userEvent.keyboard('{Escape}');

      const confirmation = await screen.findByRole('dialog', { name: 'Approve 5 clean items?' });
      expect(confirmation).toHaveTextContent('1 of 3 checked');
      expect(within(confirmation).getByRole('button', { name: 'Continue spot-check' })).toBeInTheDocument();
      expect(within(confirmation).getByRole('button', { name: 'Approve 5 clean items' })).toBeDisabled();
    });

    it('marks all of them reviewed in ONE call, with a toast Undo and an announcement', async () => {
      const userEvent = await render80();
      await openConfirmation(userEvent);
      const confirmation = await spotCheckAll(userEvent);

      await userEvent.click(within(confirmation).getByRole('button', { name: 'Approve 5 clean items' }));

      await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1));
      expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-80', CLEAN_IDS, true);
      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Approved 5 clean items. Undo available.'));
      await waitFor(() => expect(screen.queryByRole('button', { name: /^Approve \d+ clean items?$/ })).not.toBeInTheDocument());

      await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-80', CLEAN_IDS, false));
      expect(await screen.findByRole('button', { name: 'Approve 5 clean items' })).toBeInTheDocument();
    });

    it('puts the approval back, announces the failure and keeps the button when the save fails', async () => {
      const userEvent = await render80();
      await openConfirmation(userEvent);
      const confirmation = await spotCheckAll(userEvent);
      vi.mocked(jobsApi.setDiffEntriesReviewed).mockRejectedValueOnce(new Error('network'));

      await userEvent.click(within(confirmation).getByRole('button', { name: 'Approve 5 clean items' }));

      await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Couldn\'t approve 5 clean items. Try again.'));
      // Nothing stays marked, and the confirmation is back with the reason and the progress kept.
      const back = await screen.findByRole('dialog', { name: 'Approve 5 clean items?' });
      expect(back).toHaveTextContent('Couldn\'t approve 5 clean items. Try again.');
      expect(back).toHaveTextContent('3 of 3 checked');
      expect(within(back).getByRole('button', { name: 'Approve 5 clean items' })).toBeEnabled();
    });

    it('works out the sample again after an exclude, and approves only what is still clean', async () => {
      const userEvent = await render80();
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockResolvedValue({ dryRunDiff: diffRows('c1') } as any);
      await openConfirmation(userEvent);
      await userEvent.click(screen.getByRole('button', { name: 'Start spot-check' }));
      await screen.findByRole('dialog');

      await userEvent.keyboard('x');
      await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledWith('job-80', 'c1', true));

      // Four are left, so the sample is c2, c3 (rounded), c5 -- and the excluded one is not in it.
      await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Clean two').length).toBeGreaterThan(0));
      for (const title of ['Clean two', 'Clean four', 'Clean five']) {
        await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText(title).length).toBeGreaterThan(0));
        await pressMark(userEvent);
      }
      const confirmation = await screen.findByRole('dialog', { name: 'Approve 4 clean items?' });
      await userEvent.click(within(confirmation).getByRole('button', { name: 'Approve 4 clean items' }));
      await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-80', ['c2', 'c3', 'c4', 'c5'], true));
    });

    it('says it is still saving when "looks right" is pressed during a save in the spot-check', async () => {
      const userEvent = await render80();
      const save = deferred<{ dryRunDiff: unknown[] }>();
      vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(() => save.promise as never);
      await openConfirmation(userEvent);
      await userEvent.click(screen.getByRole('button', { name: 'Start spot-check' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.keyboard('x');
      await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledTimes(1));

      await pressMark(userEvent);

      await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Still saving. Try again.'));
      await act(async () => save.resolve({ dryRunDiff: diffRows('c1') }));
    });

    it('filters the tree to the clean items from the confirmation, without a way to mark them all reviewed', async () => {
      const userEvent = await render80();
      await openConfirmation(userEvent);

      await userEvent.click(screen.getByRole('button', { name: 'Show these items in the tree' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByText('Low item')).not.toBeInTheDocument());
      expect(screen.getByText('Clean one')).toBeInTheDocument();
      expect(screen.getByText(/clean items: 5 items/i)).toBeInTheDocument();
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Showing 5 clean items in the tree.');
      expect(screen.queryByRole('button', { name: 'Mark all reviewed' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Hide reviewed')).not.toBeInTheDocument();
    });

    it('drops the clean-items tree filter once they are approved, so no row keeps a stale "Not flagged" chip', async () => {
      const userEvent = await render80();
      await openConfirmation(userEvent);
      await userEvent.click(screen.getByRole('button', { name: 'Show these items in the tree' }));
      await waitFor(() => expect(screen.getByText(/clean items: 5 items/i)).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: 'Approve 5 clean items' }));
      const confirmation = await spotCheckAll(userEvent);
      await userEvent.click(within(confirmation).getByRole('button', { name: 'Approve 5 clean items' }));

      await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-80', CLEAN_IDS, true));
      await waitFor(() => expect(screen.queryByText(/clean items: \d+ items/i)).not.toBeInTheDocument());
      expect(screen.getByText('Low item')).toBeInTheDocument();
    });

    describe('review-state correctness (G3)', () => {
      function stubWritePreview() {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
        useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
        vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue({
          createdTotal: 7,
          createdLocalIds: [...CLEAN_IDS, 'low', 'unscored'],
          createdByType: { Requirement: 7 },
          excluded: { direct: 0, viaAncestor: 0 },
          parentLinks: 0,
          figuresToAttach: 0,
          figuresUnavailable: 0,
          existingGettingChildren: 0,
          existingWithoutNewParentLink: 0,
          traceLinks: { planned: 0, skipped: 0 },
          hasWork: true,
          figuresOnly: false,
        });
      }
      async function approveAll(userEvent: Awaited<ReturnType<typeof render80>>) {
        await openConfirmation(userEvent);
        const confirmation = await spotCheckAll(userEvent);
        await userEvent.click(within(confirmation).getByRole('button', { name: 'Approve 5 clean items' }));
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-80', CLEAN_IDS, true));
      }

      it('two Approve clicks in one tick save once', async () => {
        const userEvent = await render80();
        const save = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockReturnValue(save.promise as never);
        await openConfirmation(userEvent);
        const confirmation = await spotCheckAll(userEvent);
        const approve = within(confirmation).getByRole('button', { name: 'Approve 5 clean items' });

        act(() => {
          fireEvent.click(approve);
          fireEvent.click(approve);
        });
        await act(async () => save.resolve({ dryRunDiff: [] }));

        await waitFor(() => expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Approved 5 clean items. Undo available.'));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(1);
      });

      it('a failed Undo keeps how the items were approved: still in bulk, with the spot-check kept', async () => {
        stubWritePreview();
        const userEvent = await render80();
        vi.mocked(jobsApi.setDiffEntriesReviewed)
          .mockResolvedValueOnce({ dryRunDiff: [] })
          .mockRejectedValueOnce(new Error('network'));
        await approveAll(userEvent);

        await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(2));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-80', CLEAN_IDS, false);
        await screen.findByText(/failed to update review state/i);

        await userEvent.click(await screen.findByRole('button', { name: /^write to azure devops$/i }));
        expect(
          await screen.findByText('Review: 3 approved in bulk after you looked at them, 2 approved in bulk without being looked at, 2 not reviewed.'),
        ).toBeInTheDocument();
      });

      it('counts the items the reviewer looked at as looked at from the moment of the approval, before its save is back', async () => {
        stubWritePreview();
        const userEvent = await render80();
        const save = deferred<{ dryRunDiff: never[] }>();
        vi.mocked(jobsApi.setDiffEntriesReviewed).mockReturnValue(save.promise as never);
        await approveAll(userEvent);

        await userEvent.click(await screen.findByRole('button', { name: /^write to azure devops$/i }));

        expect(
          await screen.findByText('Review: 3 approved in bulk after you looked at them, 2 approved in bulk without being looked at, 2 not reviewed.'),
        ).toBeInTheDocument();
        await act(async () => save.resolve({ dryRunDiff: [] }));
      });

      it('Undo of a bulk approval leaves alone an item that was excluded since', async () => {
        const userEvent = await render80();
        vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockResolvedValue({
          dryRunDiff: diffRows().map((row) => (row.localId === 'c3' ? { ...row, excluded: true } : row)),
        } as never);
        await approveAll(userEvent);

        await clickUntilCalled(userEvent, () => screen.getByRole('checkbox', { name: /exclude clean three/i }), jobsApi.setDiffEntryExcluded as never);
        await waitFor(() => expect(screen.getByRole('checkbox', { name: /exclude clean three/i })).toBeChecked());
        await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

        await waitFor(() => expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledTimes(2));
        expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-80', ['c1', 'c2', 'c4', 'c5'], false);
      });

      it('an excluded sample item that comes back by Undo has to be looked at again', async () => {
        const userEvent = await render80();
        vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation((async (_id: string, _localId: string, excluded: boolean) => ({
          dryRunDiff: diffRows(excluded ? 'c1' : undefined),
        })) as never);
        await openConfirmation(userEvent);
        await userEvent.click(screen.getByRole('button', { name: 'Start spot-check' }));
        await screen.findByRole('dialog');
        // Look at Clean one (checked), step on, step back to it and exclude it.
        await pressMark(userEvent);
        await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Clean three').length).toBeGreaterThan(0));
        await userEvent.keyboard('k');
        await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText('Clean one').length).toBeGreaterThan(0));
        await userEvent.keyboard('x');
        await waitFor(() => expect(jobsApi.setDiffEntryExcluded).toHaveBeenCalledWith('job-80', 'c1', true));
        // The sample for the four left is Clean two, four and five.
        for (const title of ['Clean two', 'Clean four', 'Clean five']) {
          await waitFor(() => expect(within(screen.getByRole('dialog')).getAllByText(title).length).toBeGreaterThan(0));
          await pressMark(userEvent);
        }
        await screen.findByRole('dialog', { name: 'Approve 4 clean items?' });

        // The toast sits outside the modal, so it is clicked directly.
        fireEvent.click((await screen.findByText('Undo')).closest('button')!);

        const back = await screen.findByRole('dialog', { name: 'Approve 5 clean items?' });
        // Clean five was checked; Clean one was checked before it was excluded and must not count any more.
        await waitFor(() => expect(back).toHaveTextContent('1 of 3 checked'));
        expect(within(back).getByRole('button', { name: 'Approve 5 clean items' })).toBeDisabled();
      });

      it('a bulk approve that empties a queue that was never opened still shows the "Review queue done." row, with focus', async () => {
        const userEvent = await render80({ dryRunDiff: diffRows().slice(0, 5) });
        await openConfirmation(userEvent);
        const confirmation = await spotCheckAll(userEvent);

        await userEvent.click(within(confirmation).getByRole('button', { name: 'Approve 5 clean items' }));

        await waitFor(() => expect(screen.getByText('Review queue done.')).toHaveFocus());
      });
    });
  });
});

describe('JobDetail: the nothing-written line (DESIGN.md §0)', () => {
  const LINE = 'Nothing has been written to Azure DevOps. Writing only starts after you approve the diff.';

  beforeEach(() => {
    // Same defaults the main describe sets: vi.mock('../api/jobs') above makes every export return undefined.
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });

  async function mountWithStatus(status: string): Promise<void> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-safety', status, mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation(() => () => {});
    renderAt('job-safety');
  }

  it('is visible while a job is running', async () => {
    await mountWithStatus('running');
    expect(await screen.findByText(LINE)).toBeInTheDocument();
  });

  it('is visible while a job awaits review', async () => {
    await mountWithStatus('diff_ready');
    expect(await screen.findByText(LINE)).toBeInTheDocument();
  });

  it('is not shown for a job that went back to diff_ready after a partial write', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-partial', status: 'diff_ready', mode: 'survey', createdAt: new Date().toISOString(),
      createdItemCount: 1, writtenLocalIds: ['e1'],
      dryRunDiff: [{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Root', description: '', action: 'create', customerId: null, tags: [] }],
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation(() => () => {});
    renderAt('job-partial');
    await screen.findByText('Root');
    expect(screen.queryByText(LINE)).not.toBeInTheDocument();
  });

  it('is not shown once the job is writing, because it would no longer be true', async () => {
    await mountWithStatus('writing');
    // Wait for the loaded page (its status chip), so the absence below is not a vacuous pre-render pass.
    await screen.findByText('Writing');
    expect(screen.queryByText(LINE)).not.toBeInTheDocument();
  });
});

describe('JobDetail: the stepper while the model reads the whole document', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });

  it('labels the Parse step "reading whole document", so a minute and a half under Parse does not look like a stuck parser', async () => {
    // Seen live (2026-11-12): the primer call ran for 1m34s with Parse as the only active step and no explanation under it.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-primer', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString(),
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, _onStage, onNarration) => {
      onNarration?.({
        phase: 'primer', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
        kbGrounded: false, kbCitations: [], message: 'Reading the whole document to understand it - 0:12',
      } as any);
      return () => {};
    });
    renderAt('job-primer');
    expect(await screen.findByText('reading whole document')).toBeInTheDocument();
  });
});

describe('JobDetail: the phase rail while a run is in progress (DESIGN.md §11.3.5)', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });

  let pushStage: (stage: string) => void = () => undefined;

  async function mountRunning(opts: { status?: string; mode?: string; stage?: string | null } = {}): Promise<void> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-rail', status: opts.status ?? 'running', mode: opts.mode ?? 'survey', dryRunDiff: opts.status === 'diff_ready' ? [] : null,
      createdAt: new Date().toISOString(),
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
      pushStage = (stage) => onStage(stage as any);
      // A queued job has no stage yet; a stage event would also start it running.
      if (opts.stage !== null) onStage((opts.stage ?? 'infer_hierarchy_start') as any);
      return () => {};
    });
    renderAt('job-rail');
  }

  it('shows the SURVEY phases as a vertical tab list with the live phase selected', async () => {
    await mountRunning();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringContaining('Parse'), expect.stringContaining('Analyze'), expect.stringContaining('Score'),
      expect.stringContaining('Dedup check'), expect.stringContaining('Review'), expect.stringContaining('Write'),
    ]);
    expect(screen.getByRole('tab', { name: /Analyze/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'phase-tab-analyze');
  });

  it('has exactly one polite status region while a run is in progress (DESIGN.md §13)', async () => {
    await mountRunning({ stage: 'infer_hierarchy_start' });
    await screen.findAllByRole('tab');
    expect(document.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
    expect(screen.getByTestId('live-status-region')).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-status')).not.toBeInTheDocument();
  });

  it('shows four phases for BASELINE', async () => {
    await mountRunning({ mode: 'baseline', stage: 'parse' });
    expect(await screen.findAllByRole('tab')).toHaveLength(4);
  });

  it('has no dark narration strip: the ticker is gone while a run is in progress', async () => {
    await mountRunning();
    await screen.findAllByRole('tab');
    expect(document.querySelector('.bg-ink-1')).toBeNull();
  });

  it('lets you read a finished phase and come back to the live one, and says what a pending phase is for', async () => {
    await mountRunning();
    await userEvent.click(await screen.findByRole('tab', { name: /Parse/ }));
    expect(screen.getByRole('tab', { name: /Parse/ })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: 'Parse' })).toBeInTheDocument();
    expect(within(panel).getByText('Finished')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Score/ }));
    expect(within(screen.getByRole('tabpanel')).getByText('Not started yet')).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).getByText(/Judging each drafted requirement/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back to live' }));
    expect(screen.getByRole('tab', { name: /Analyze/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Back to live' })).not.toBeInTheDocument();
  });

  it('keeps showing the phase you chose, and keeps focus where it is, while the live phase moves on', async () => {
    await mountRunning();
    await userEvent.click(await screen.findByRole('tab', { name: /Parse/ }));
    const focused = document.activeElement;
    // The run really moves on: Analyze is done and Dedup check begins.
    act(() => pushStage('dedup_check'));
    expect(screen.getByRole('tab', { name: /Dedup check/ })).toHaveTextContent('Live');
    expect(screen.getByRole('tab', { name: /Parse/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Back to live' })).toBeInTheDocument();
    expect(document.activeElement).toBe(focused);
  });

  it('follows the live phase by default as the run moves on', async () => {
    await mountRunning();
    expect(await screen.findByRole('tab', { name: /Analyze/ })).toHaveAttribute('aria-selected', 'true');
    act(() => pushStage('dedup_check'));
    expect(screen.getByRole('tab', { name: /Dedup check/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('says in words that the Write phase cannot be undone, before it has started', async () => {
    await mountRunning();
    expect(await screen.findByRole('tab', { name: /Write/ })).toHaveTextContent(/cannot be undone/i);
  });

  it('shows a queued job in the live layout, with the queue notice in the panel and "Queued" under its phase', async () => {
    await mountRunning({ status: 'pending', stage: null });
    expect(await screen.findByText(/Queued\. It starts when a slot is free/)).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Parse/ })).getByText('Queued')).toBeInTheDocument();
    // Reading another phase hides the queue notice; Back to live brings it back.
    await userEvent.click(screen.getByRole('tab', { name: /Review/ }));
    expect(screen.queryByText(/Queued\. It starts when a slot is free/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to live' }));
    expect(await screen.findByText(/Queued\. It starts when a slot is free/)).toBeInTheDocument();
  });

  it('puts a writing job on the Write phase', async () => {
    await mountRunning({ status: 'writing', stage: 'writing' });
    expect(await screen.findByRole('tab', { name: /Write/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('does not carry a phase you picked on one job over to the next job', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockImplementation(async (id: string) =>
      ({ id, status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString() }) as any,
    );
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
      onStage('infer_hierarchy_start');
      return () => {};
    });
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/jobs/job-one']}>
          <Link to="/jobs/job-two">next job</Link>
          <Routes>
            <Route path="/jobs/:id" element={<JobDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    await userEvent.click(await screen.findByRole('tab', { name: /Parse/ }));
    expect(screen.getByRole('button', { name: 'Back to live' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'next job' }));
    await waitFor(() => expect(jobsApi.getJob).toHaveBeenCalledWith('job-two'));
    expect(await screen.findByRole('tab', { name: /Analyze/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Back to live' })).not.toBeInTheDocument();
  });

  it('keeps the same phase rail once the run is no longer in progress, with Review in view and no live marker', async () => {
    await mountRunning({ status: 'diff_ready', stage: 'diff_ready' });
    expect(await screen.findByRole('tablist', { name: 'Run phases' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Review/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('● Live')).not.toBeInTheDocument();
  });
});

describe('JobDetail: the run log outlives the run (DESIGN.md §11.3.5)', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });

  it('offers a collapsed "Run log (n)" on a finished job, built from the stored event history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-log', status: 'diff_ready', mode: 'survey', dryRunDiff: [], createdAt: new Date().toISOString() } as any);
    const at = new Date().toISOString();
    const entry = (id: string, phase: string, message: string) => ({
      id, jobId: 'job-log', phase, severity: 'info', createdAt: at, message,
      detail: { phase, branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0, kbGrounded: false, kbCitations: [], message },
    });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([
      entry('e1', 'table_detected', 'Detected a table t0'),
      entry('e2', 'score_requirements', 'Scoring requirement batch 1 of 1'),
    ] as any);
    renderAt('job-log');

    fireEvent.click(await screen.findByRole('button', { name: /Run details/ }));
    const toggle = await screen.findByRole('button', { name: 'Run log (2)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Scoring requirement batch 1 of 1')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByText('Scoring requirement batch 1 of 1')).toBeInTheDocument();
  });

  it('shows no run log for a job whose history is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-nolog', status: 'diff_ready', mode: 'survey', dryRunDiff: [], createdAt: new Date().toISOString() } as any);
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    renderAt('job-nolog');
    fireEvent.click(await screen.findByRole('button', { name: /Run details/ }));
    await screen.findByText('Review');
    expect(screen.queryByRole('button', { name: /Run log/ })).not.toBeInTheDocument();
  });
});

describe('JobDetail: the browser tab names the job (WCAG 2.4.2)', () => {
  it('shows the file name first, then the product', async () => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-title', status: 'diff_ready', mode: 'survey', dryRunDiff: [], originalFilename: 'radar-icd.docx', createdAt: new Date().toISOString(),
    } as any);
    renderAt('job-title');
    await waitFor(() => expect(document.title).toBe('radar-icd.docx - req2ado'));
  });
});


describe('JobDetail: the review state puts the task first (DESIGN.md §11.3.5, review state)', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([
      {
        id: 'e1', jobId: 'job-rv', phase: 'score_requirements', severity: 'info', createdAt: new Date().toISOString(), message: 'Scoring requirement batch 1 of 1',
        detail: { phase: 'score_requirements', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0, kbGrounded: false, kbCitations: [], message: 'Scoring requirement batch 1 of 1' },
      },
    ] as any);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });

  async function mountReview(status = 'diff_ready'): Promise<void> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 17, reused: 2, dedupSkipped: 1, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-rv', status, mode: 'survey', originalFilename: 'radar-icd.docx', createdAt: new Date().toISOString(),
      documentOverview: { synopsis: 'About a radar.', caveat: null, lines: ['Structure: 6 sections.'] },
      dryRunDiff: [{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Radar', description: '', action: 'create', customerId: null, tags: [] }],
    } as any);
    renderAt('job-rv');
    await screen.findByText('Radar');
  }

  it('shows one summary line with the counts, instead of three tiles', async () => {
    await mountReview();
    const header = await screen.findByTestId('review-header');
    expect(header).toHaveTextContent('Review the proposed items');
    expect(header).toHaveTextContent('17 new · 2 reused · 1 skipped as duplicate');
    expect(screen.queryByText('Duplicates skipped')).not.toBeInTheDocument();
  });

  it('keeps the run log and the knowledge-base note behind "Run details" until asked; the phases live in the rail', async () => {
    await mountReview();
    const strip = await screen.findByRole('button', { name: /Run details/ });
    expect(strip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Run log/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Document overview/)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Dedup check/ })).toBeInTheDocument(); // the rail is the stepper now

    fireEvent.click(strip);
    expect(await screen.findByRole('button', { name: /Run log \(1\)/ })).toBeInTheDocument();
  });

  it('shows the document overview with the Parse phase, and Back to review returns to the items', async () => {
    await mountReview();
    fireEvent.click(await screen.findByRole('tab', { name: /^Parse/ }));
    expect(await screen.findByText(/Document overview/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to review' }));
    expect(screen.queryByText(/Document overview/)).not.toBeInTheDocument();
  });

  it('titles the page with the file name at the page-title size, like every other page (DESIGN.md §4)', async () => {
    await mountReview();
    const title = await screen.findByRole('heading', { level: 1, name: 'radar-icd.docx' });
    expect(title.className).toMatch(/(^| )text-display( |$)/);
  });

  it('calls the list "Proposed items" while it is a proposal and "Written items" once it has been written (DESIGN.md §0, item 3)', async () => {
    await mountReview('diff_ready');
    expect(await screen.findByRole('tab', { name: 'Proposed items (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Diff/ })).not.toBeInTheDocument();
  });

  it('never calls items that are already in Azure DevOps a proposal', async () => {
    await mountReview('succeeded');
    expect(await screen.findByRole('tab', { name: 'Written items (1)' })).toBeInTheDocument();
  });

  it('has no dark narration strip: the state is said once, by the status chip', async () => {
    await mountReview();
    await screen.findByRole('button', { name: /Run details/ });
    expect(document.querySelector('.bg-ink-1')).toBeNull();
    expect(screen.queryByText('Diff ready for your review.')).not.toBeInTheDocument();
  });

  it('is the same structure for a finished job, minus the counts that no longer apply to a decision', async () => {
    await mountReview('rejected');
    const strip = await screen.findByRole('button', { name: /Run details/ });
    expect(strip).toBeInTheDocument();
    expect(strip.textContent).not.toMatch(/new ·/);
  });
});

describe('JobDetail: one toolbar row above the proposed items (DESIGN.md §11.3.5, review state)', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 2, reused: 0, dedupSkipped: 0, flagged: 1, warnings: [] });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });

  it('puts the risk-order action, the filters and the bulk actions on the same row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-tb', status: 'diff_ready', mode: 'survey', createdAt: new Date().toISOString(),
      dryRunDiff: [
        { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Flagged epic', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.1 },
        { localId: 'e2', parentLocalId: null, type: 'Epic', title: 'Healthy epic', description: '', action: 'create', customerId: null, tags: [], groundingScore: 0.9 },
      ],
    } as any);
    renderAt('job-tb');
    await screen.findByText('Flagged epic');

    const rowOf = (el: HTMLElement): Element | null => el.closest('.border-b');
    const risk = await screen.findByRole('button', { name: /Review in risk order/ });
    const filter = screen.getByPlaceholderText('Filter by title…');
    const exclude = screen.getByRole('button', { name: /^Exclude/ });
    expect(rowOf(risk)).not.toBeNull();
    expect(rowOf(risk)).toBe(rowOf(filter));
    expect(rowOf(risk)).toBe(rowOf(exclude));
  });
});

describe('JobDetail: review-state follow-ups from the independent review', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 2, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });
  const entry = { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Radar', description: '', action: 'create', customerId: null, tags: [] };
  async function mount(job: Record<string, unknown>): Promise<void> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ mode: 'survey', createdAt: new Date().toISOString(), dryRunDiff: [entry], ...job } as any);
    renderAt(String(job.id));
    await screen.findByText('Radar');
  }

  async function mountFailedWithoutDiff(id: string): Promise<void> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id, status: 'failed', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString() } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation(() => () => {});
    renderAt(id);
  }

  it('says why a failed run failed, at the top, in plain words, with the raw text beneath (E3)', async () => {
    vi.spyOn(jobsApi, 'getAudit').mockResolvedValue([
      { id: 'a1', jobId: 'job-f3', message: 'Job submitted: AirPro.docx', createdAt: '2026-11-12T21:39:00Z' },
      { id: 'a2', jobId: 'job-f3', message: 'Pipeline failed: terminated (UND_ERR_SOCKET: other side closed)', createdAt: '2026-11-12T21:48:00Z' },
    ] as any);
    await mountFailedWithoutDiff('job-f3');
    expect(await screen.findByText('The connection was cut during the run.')).toBeInTheDocument();
    expect(screen.getByText('terminated (UND_ERR_SOCKET: other side closed)')).toBeInTheDocument();
    expect(screen.queryByText(/Check the audit trail for details/)).not.toBeInTheDocument();
  });

  it('keeps the generic line for a failed run whose cause was never recorded', async () => {
    vi.spyOn(jobsApi, 'getAudit').mockResolvedValue([{ id: 'a1', jobId: 'job-f4', message: 'Job submitted: a.docx', createdAt: '2026-11-12T21:39:00Z' }] as any);
    await mountFailedWithoutDiff('job-f4');
    expect(await screen.findByText(/This job failed before completing analysis/)).toBeInTheDocument();
  });

  it('opens "Run details" for a failed or cancelled job, where the stepper shows where it stopped', async () => {
    await mount({ id: 'job-f1', status: 'failed' });
    const strip = await screen.findByRole('button', { name: /Run details/ });
    expect(strip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Dedup check')).toBeInTheDocument();
  });

  it('leaves "Run details" closed for a job awaiting review', async () => {
    await mount({ id: 'job-f2', status: 'diff_ready' });
    expect(await screen.findByRole('button', { name: /Run details/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not call a list "Proposed items" once some of it has been written (a partial write)', async () => {
    await mount({ id: 'job-pw', status: 'diff_ready', createdItemCount: 1, writtenLocalIds: ['e1'] });
    expect(await screen.findByRole('tab', { name: 'Items (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Proposed items/ })).not.toBeInTheDocument();
  });

  it('shows no "Run details" strip while the run is live: the phase rail owns that layout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-lv', status: 'running', mode: 'survey', dryRunDiff: null, createdAt: new Date().toISOString() } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation((_id, _base, onStage) => {
      onStage('infer_hierarchy_start');
      return () => {};
    });
    renderAt('job-lv');
    await screen.findAllByRole('tab');
    expect(screen.queryByRole('button', { name: /Run details/ })).not.toBeInTheDocument();
  });

  it('keeps one toolbar row for the filters when there is no review queue to start', async () => {
    await mount({ id: 'job-nq', status: 'succeeded' });
    const filter = await screen.findByPlaceholderText('Filter by title…');
    expect(filter.closest('.border-b')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Review in risk order/ })).not.toBeInTheDocument();
  });
});


describe('JobDetail: the write gate is a hard block (DESIGN.md §11.3.5, review state)', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 2, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
    vi.spyOn(jobsApi, 'getWritePreview').mockResolvedValue(withServerFlags({
      createdTotal: 2, createdLocalIds: ['r1', 'r2'], createdByType: { Requirement: 2 }, excluded: { direct: 0, viaAncestor: 0 },
      parentLinks: 0, figuresToAttach: 0, figuresUnavailable: 0, existingGettingChildren: 0, existingWithoutNewParentLink: 0,
      traceLinks: { planned: 0, skipped: 0 }, alreadyWritten: 0,
    }) as any);
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
  });
  const req = (localId: string, extra: Record<string, unknown> = {}) => ({
    localId, parentLocalId: null, type: 'Requirement', title: `Title ${localId}`, description: '', action: 'create', customerId: null, tags: [], ...extra,
  });
  async function mount(job: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      mode: 'survey', createdAt: new Date().toISOString(), status: 'diff_ready', adoProject: 'Compliance', areaPath: 'Compliance\\Auth', ...job,
    } as any);
    const events = await import('../api/events');
    vi.mocked(events.subscribeToJobEvents).mockImplementation(() => () => {});
    renderAt(String(job.id));
    return screen.findByRole('button', { name: /write to azure devops/i });
  }
  const duplicateIds = (nodeIds: string[]) => ({
    kind: 'duplicate_customer_id', severity: 'needs_review', nodeIds, detail: {}, raw: 'Customer ID reported on several requirements.',
  });

  it('keeps Write focusable but aria-disabled, states the reason in text, and does not open the dialog while a fix item is open', async () => {
    const write = await mount({ id: 'gate-1', dryRunDiff: [req('r1'), req('r2')], warnings: [duplicateIds(['r1', 'r2'])] });
    expect(write).toHaveAttribute('aria-disabled', 'true');
    expect(write).not.toBeDisabled();
    expect(screen.getByText('2 items to fix before writing')).toBeInTheDocument();

    await userEvent.click(write);
    expect(screen.queryByRole('dialog', { name: /write these items to azure devops/i })).not.toBeInTheDocument();
  });

  it('jumps to the first blocker when Write is pressed while blocked', async () => {
    const write = await mount({ id: 'gate-2', dryRunDiff: [req('r1'), req('r2')], warnings: [duplicateIds(['r1', 'r2'])] });
    expect(screen.queryByRole('checkbox', { name: /hide reviewed/i })).not.toBeInTheDocument();
    await userEvent.click(write);
    // The same focus the "Fix in tree" button gives: the tree narrows to the blocker and "Hide reviewed" appears.
    expect(await screen.findByRole('checkbox', { name: /hide reviewed/i })).toBeInTheDocument();
  });

  it('opens the dialog once every fix item is decided (an excluded item counts as decided)', async () => {
    const write = await mount({
      id: 'gate-3', dryRunDiff: [req('r1', { reviewed: true }), req('r2', { excluded: true })], warnings: [duplicateIds(['r1', 'r2'])],
    });
    expect(write).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(/to fix before writing/i)).not.toBeInTheDocument();
    await userEvent.click(write);
    expect(await screen.findByRole('dialog', { name: /write these items to azure devops/i })).toBeInTheDocument();
  });

  it('never blocks on a review warning', async () => {
    const write = await mount({
      id: 'gate-4', dryRunDiff: [req('r1')],
      warnings: [{ kind: 'criteria_value_ungrounded', severity: 'needs_review', nodeIds: ['r1'], detail: {}, raw: 'x' }],
    });
    expect(write).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('offers no "Mark all reviewed" on a fix kind, but does on a review kind', async () => {
    await mount({ id: 'gate-5', dryRunDiff: [req('r1'), req('r2')], warnings: [duplicateIds(['r1', 'r2'])] });
    await userEvent.click(await screen.findByRole('button', { name: 'Fix in tree' }));
    expect(screen.queryByRole('button', { name: 'Mark all reviewed' })).not.toBeInTheDocument();
  });

  it('shows "Mark all reviewed" for a review kind', async () => {
    await mount({
      id: 'gate-6', dryRunDiff: [req('r1'), req('r2')],
      warnings: [{ kind: 'criteria_value_ungrounded', severity: 'needs_review', nodeIds: ['r1', 'r2'], detail: {}, raw: 'x' }],
    });
    await userEvent.click(await screen.findByRole('button', { name: /review in tree/i }));
    expect(await screen.findByRole('button', { name: 'Mark all reviewed' })).toBeInTheDocument();
  });

  it('clears a missing-Customer-ID kind with one counted acknowledgement, which can be undone', async () => {
    vi.mocked(jobsApi.setWarningsAcknowledged).mockResolvedValue({ warnings: [] } as any);
    const noId = { kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['r1', 'r2'], detail: {}, raw: 'Requirement has no Customer ID.' };
    const write = await mount({ id: 'gate-7', dryRunDiff: [req('r1'), req('r2')], warnings: [noId] });
    expect(write).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Accept 2 without a Customer ID' }));

    expect(jobsApi.setWarningsAcknowledged).toHaveBeenCalledWith('gate-7', { kind: 'missing_source_reference', raws: undefined, acknowledged: true });
    // Said as what was accepted, not as a generic "handled".
    expect(await screen.findByText('Accepted 2 without a Customer ID.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /write to azure devops/i })).not.toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('offers the counted acknowledgement only for kinds that allow it', async () => {
    await mount({ id: 'gate-8', dryRunDiff: [req('r1'), req('r2')], warnings: [duplicateIds(['r1', 'r2'])] });
    expect(screen.queryByRole('button', { name: /^Accept \d+ without/ })).not.toBeInTheDocument();
  });

  it('does not gate a job that is not awaiting review', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'gate-9', status: 'succeeded', mode: 'survey', createdAt: new Date().toISOString(), createdItemCount: 1, writtenLocalIds: ['r1'],
      dryRunDiff: [req('r1')], warnings: [duplicateIds(['r1'])],
    } as any);
    renderAt('gate-9');
    await screen.findByText('Title r1');
    expect(screen.queryByText(/to fix before writing/i)).not.toBeInTheDocument();
  });
  it('says why Write did nothing in the live region and moves focus to the tree, so neither a screen reader nor a keyboard user is left behind', async () => {
    const write = await mount({ id: 'gate-a11y', dryRunDiff: [req('r1'), req('r2')], warnings: [duplicateIds(['r1', 'r2'])] });
    await userEvent.click(write);
    await waitFor(() =>
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Write is blocked: 2 items to fix before writing. Showing them.'),
    );
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('proposed-tree')));
  });

  it('takes a blocked Write to the warning itself when the blocker has no tree items, instead of an empty tree', async () => {
    const zero = (raw: string) => ({ kind: 'zero_nodes', severity: 'pipeline_issue', nodeIds: [], detail: {}, raw });
    const write = await mount({ id: 'gate-empty', dryRunDiff: [req('r1')], warnings: [zero('Section 3 produced 0 work items.'), zero('Section 7 produced 0 work items.')] });
    expect(write).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(write);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('integrity-warnings')));
    // The tree is not narrowed to nothing.
    expect(screen.queryByRole('checkbox', { name: /hide reviewed/i })).not.toBeInTheDocument();
    expect(screen.getByText('Title r1')).toBeInTheDocument();
  });

  it('clears a group filter when its group empties, so a pressed chip can never vanish and leave the tree filtered to nothing', async () => {
    const excluded = new Set<string>();
    const items = () => [
      req('a', { title: 'Loose one', groundingScore: 0.1, excluded: excluded.has('a') }),
      req('b', { title: 'Loose two', groundingScore: 0.05, excluded: excluded.has('b') }),
      req('c', { title: 'Healthy one', groundingScore: 0.9, qualityScore: 90, excluded: excluded.has('c') }),
    ];
    vi.spyOn(jobsApi, 'setDiffEntryExcluded').mockImplementation(async (_id, localId, value) => {
      if (value) excluded.add(localId);
      else excluded.delete(localId);
      return { dryRunDiff: items() } as any;
    });
    await mount({ id: 'gate-chip', dryRunDiff: items(), warnings: [] });
    await userEvent.click(screen.getByRole('button', { name: /^check · 2$/i }));
    expect(screen.queryByText('Healthy one')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^exclude matching$/i }));
    // Both Check items are now excluded: the group is empty, its chip is gone, and the filter with it.
    await waitFor(() => expect(screen.queryByRole('button', { name: /^check/i })).not.toBeInTheDocument());
    expect(screen.getByText('Healthy one')).toBeInTheDocument();
  });

  it('keeps a "Skip to proposed items" link first in the page, which moves focus to the tree (WCAG 2.4.1)', async () => {
    await mount({ id: 'gate-skip', dryRunDiff: [req('r1'), req('r2')], warnings: [] });
    const skip = screen.getByRole('link', { name: 'Skip to proposed items' });
    const tools = screen.getByRole('group', { name: 'Job tools' });
    expect(skip.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(skip);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('proposed-tree')));
  });

  describe('the sticky write bar (W3)', () => {
    it('comes after the tree in the DOM and stays at the bottom of the review view', async () => {
      const write = await mount({ id: 'bar-1', dryRunDiff: [req('r1'), req('r2')], warnings: [] });
      const bar = screen.getByRole('region', { name: 'Review decision' });
      expect(bar).toContainElement(write);
      expect(bar).toHaveClass('sticky', 'bottom-0');
      const tree = document.getElementById('proposed-tree')!;
      expect(tree.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByRole('button', { name: /write to azure devops/i })).toHaveLength(1);
    });

    it('carries the blocker count in text, linked to Write, and a blocked Write still jumps to the first blocker', async () => {
      const write = await mount({ id: 'bar-2', dryRunDiff: [req('r1'), req('r2')], warnings: [duplicateIds(['r1', 'r2'])] });
      const bar = screen.getByRole('region', { name: 'Review decision' });
      const reason = within(bar).getByText('2 items to fix before writing');
      expect(write.getAttribute('aria-describedby')).toBe(reason.id);
      expect(write).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(write);
      expect(await screen.findByRole('checkbox', { name: /hide reviewed/i })).toBeInTheDocument();
    });

    it('keeps Write the only signal-yellow control on the page', async () => {
      await mount({ id: 'bar-3', dryRunDiff: [req('r1')], warnings: [] });
      const write = screen.getByRole('button', { name: /write to azure devops/i });
      const yellow = Array.from(document.querySelectorAll('button')).filter((b) => /\bbg-cta\b|\bbg-signal\b/.test(b.className));
      expect(yellow).toEqual([write]);
    });

    it('gives the bar 44 px targets below md', async () => {
      await mount({ id: 'bar-4', dryRunDiff: [req('r1')], warnings: [] });
      expect(screen.getByRole('button', { name: /write to azure devops/i })).toHaveClass('max-md:min-h-11');
      expect(screen.getByRole('button', { name: /^reject$/i })).toHaveClass('max-md:min-h-11');
    });

    it.each(['running', 'failed', 'succeeded'])('is not drawn for a %s job', async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: `bar-${status}`, status, mode: 'survey', createdAt: new Date().toISOString(), dryRunDiff: status === 'running' ? null : [req('r1')], warnings: [],
      } as any);
      renderAt(`bar-${status}`);
      await screen.findByRole('group', { name: 'Job tools' });
      expect(screen.queryByRole('region', { name: 'Review decision' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /write to azure devops/i })).not.toBeInTheDocument();
    });
  });

  it('offers no skip link when the job is not awaiting review', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'gate-skip2', status: 'failed', mode: 'survey', createdAt: new Date().toISOString(), dryRunDiff: [req('r1')], warnings: [],
    } as any);
    renderAt('gate-skip2');
    await screen.findByText('Title r1');
    expect(screen.queryByRole('link', { name: 'Skip to proposed items' })).not.toBeInTheDocument();
  });
});
