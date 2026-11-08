import { usePageLabelStore } from '../store/pageLabelStore';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
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
    // text-warning on warning-soft is 3.9:1; the -ink token is the readable one.
    expect(screen.getByRole('button', { name: /needs review/i })).toHaveClass('text-warning-ink');

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /needs review/i }));

    expect(screen.getByText(/flagged/i)).toBeInTheDocument();
    expect(screen.queryByText('Healthy epic')).not.toBeInTheDocument();
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

    describe('reviewing', () => {
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

        await userEvent.click(screen.getByRole('button', { name: 'Review in tree' }));

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

    await waitFor(() => expect(screen.getByText('1 described · 1 not significant · 1 failed')).toBeInTheDocument());
    const userEvent = (await import('@testing-library/user-event')).default;
    await userEvent.click(screen.getByText('1 described · 1 not significant · 1 failed'));
    expect(screen.getByText(/Judged by the vision model: A company logo\./)).toBeInTheDocument();
    // a figure with neither a description nor a name is not listed as if it were described
    expect(screen.queryByText(/2 figure description/)).not.toBeInTheDocument();
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
    const log = await screen.findByRole('log', { name: 'Job activity' });
    expect(within(log).getAllByRole('listitem')).toHaveLength(1);
    // and the line carries the time the server recorded, not the moment this page loaded
    expect(log.querySelector('time')).toHaveAttribute('datetime', recordedAt);
    // and the sentence appears in at most the ticker, the headline and that one line
    expect(screen.getAllByText(sharedMessage).length).toBeLessThanOrEqual(3);
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
      return screen.getAllByText('New').find((el) => el.tagName === 'P')?.previousElementSibling?.textContent;
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

  it('lays the header actions out in tiers: Reject and Write as text buttons, the rest as labelled icons in a tools group, Delete last', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-8', status: 'diff_ready', dryRunDiff: [] } as any);

    renderAt('job-8');
    const tools = await screen.findByRole('group', { name: 'Job tools' });
    const names = within(tools).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Download summary', 'Resubmit', 'Delete']);
    expect(within(tools).queryByRole('button', { name: /reject|write to azure/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /write to azure devops/i })).toBeInTheDocument();
  });

  it('puts the decisions before the tools in the DOM, so keyboard and screen-reader order matches the phone layout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ apiBaseUrl: 'http://localhost' }) }));
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-10', status: 'diff_ready', dryRunDiff: [] } as any);

    renderAt('job-10');
    const tools = await screen.findByRole('group', { name: 'Job tools' });
    const write = screen.getByRole('button', { name: /write to azure devops/i });
    expect(write.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    await waitFor(() => expect(screen.getByRole('button', { name: /^write to azure devops$/i })).toBeInTheDocument());

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^write to azure devops$/i }));
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
      // collapsed: it must not compete with the job's own progress; one click opens it
      await userEvent.click(await screen.findByRole('button', { name: /show/i }));
      expect(await screen.findByText('About a backplane.')).toBeInTheDocument();
    });

    it('is collapsed below the live progress, so the job stays the focus of the page', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
        id: 'job-52', status: 'running', mode: 'survey', stage: 'parse', startedAt: new Date().toISOString(), dryRunDiff: [],
        documentOverview: { synopsis: 'x', caveat: null, lines: ['Structure line.', 'Another line.'], aiSummary: 'An AI summary of the file. More.' },
      } as any);
      renderAt('job-52');
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
      const region = await screen.findByTestId('job-arrival-status');
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
      const region = await screen.findByTestId('job-arrival-status');
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
      await screen.findByTestId('job-arrival-status');
      await act(async () => emitStage('diff_ready'));
      await waitFor(() => expect(screen.getByTestId('job-arrival-status')).toHaveTextContent(/ready to review/)); // A finished while watched

      await userEvent.click(screen.getByRole('link', { name: 'open b' }));
      await waitFor(() => expect(screen.getByText('Second')).toBeInTheDocument());
      expect(screen.getByTestId('job-arrival-status')).toBeEmptyDOMElement();
      expect(document.getElementById('proposed-tree')!.className).not.toContain('fadeIn');
    });

    it('stays silent and still when a job is opened already finished', async () => {
      vi.spyOn(jobsApi, 'getJob').mockResolvedValue({ id: 'job-done', status: 'diff_ready', mode: 'survey', dryRunDiff: [root], createdAt: new Date().toISOString() } as any);
      renderAt('job-done');
      await waitFor(() => expect(screen.getByText('Root')).toBeInTheDocument());
      expect(screen.getByTestId('job-arrival-status')).toBeEmptyDOMElement();
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

    it('A accepts the item, steps to the next riskiest and announces what is left', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');

      await userEvent.keyboard('a');

      expect(jobsApi.setDiffEntriesReviewed).toHaveBeenCalledWith('job-70', ['blocked'], true);
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Low item').length).toBeGreaterThan(0));
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Marked reviewed. 2 left.');
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

      await userEvent.keyboard('a');
      await userEvent.keyboard('a');
      await userEvent.keyboard('a');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(jobsApi.setDiffEntriesReviewed).toHaveBeenLastCalledWith('job-70', ['clean'], true);
      expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Marked reviewed. Review queue done.');
    });

    it('moves focus to a "Review queue done." row after the last item, since the queue button it came from is gone', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');

      await userEvent.keyboard('a');
      await userEvent.keyboard('a');
      await userEvent.keyboard('a');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByText('Review queue done.')).toHaveFocus());
      expect(screen.queryByRole('button', { name: /review in risk order/i })).not.toBeInTheDocument();
    });

    it('brings the queue button back, and drops the done row, when an accept is undone', async () => {
      const userEvent = await startQueue();
      await screen.findByRole('dialog');
      await userEvent.keyboard('a');
      await userEvent.keyboard('a');
      await userEvent.keyboard('a');
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

      await userEvent.keyboard('a');
      await userEvent.keyboard('a');
      await userEvent.keyboard('a');

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

      await userEvent.keyboard('a');

      await waitFor(() =>
        expect(screen.getByTestId('review-queue-status')).toHaveTextContent('Couldn\'t mark "Blocked item" reviewed. Try again.'),
      );
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getAllByText('Blocked item').length).toBeGreaterThan(0));
    });

    it('repeats the announcement inside the open dialog, where a screen reader can hear it', async () => {
      const userEvent = await startQueue();
      const dialog = await screen.findByRole('dialog');

      await userEvent.keyboard('a');

      await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Marked reviewed. 2 left.'));
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

      await userEvent.keyboard('a'); // 'blocked' reviewed
      await userEvent.keyboard('a'); // 'low' reviewed, now on 'clean'
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

      await userEvent.keyboard('a'); // 'blocked' reviewed, now on 'low'
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

      await userEvent.keyboard('a');
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
      await userEvent.keyboard('a');
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
      await userEvent.keyboard('a');
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
      await userEvent.keyboard('a');
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
        await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed and next' }));
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
  });
});
