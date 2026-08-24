import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodeDetailDialog } from './NodeDetailDialog';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';
import * as chatApi from '../api/chat';
import * as jobsApi from '../api/jobs';

vi.mock('../api/chat');
vi.mock('../api/jobs');
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

const ENTRY: DryRunDiffEntry = {
  localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
  action: 'create', customerId: '3.2.1', tags: [],
};

function renderDialog(props: Partial<React.ComponentProps<typeof NodeDetailDialog>> = {}) {
  return render(
    <ToastProvider>
      <NodeDetailDialog
        open
        onOpenChange={vi.fn()}
        jobId="job-1"
        entry={ENTRY}
        onAddChild={vi.fn()}
        {...props}
      />
    </ToastProvider>,
  );
}

describe('NodeDetailDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue([]);
    // vi.mock('../api/jobs') auto-mocks every export as a bare vi.fn() that
    // returns undefined by default -- FigureImage (mounted by the Figures
    // section whenever entry.figureIds is non-empty) calls this and
    // .then()s the result, which throws on undefined rather than a real
    // promise. null is the real "nothing stored" response shape.
    vi.mocked(jobsApi.getFigureFile).mockResolvedValue(null);
  });

  it('renders nothing when entry is null', () => {
    const { container } = renderDialog({ entry: null });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the item title, type badge, and clause id in the header', () => {
    renderDialog();
    expect(screen.getAllByText('Req Title').length).toBeGreaterThan(0);
    expect(screen.getByText('3.2.1')).toBeInTheDocument();
  });

  it('mounts only ONE layout variant at a time (never both details+chat panes AND the tabbed layout simultaneously)', () => {
    // Regression guard: an earlier version rendered both the >=lg two-pane
    // layout and the <lg tabbed layout unconditionally (gated only by CSS
    // display classes) -- ChatPanel fetches history and opens a websocket
    // on mount regardless of visibility, so that mounted TWO real ChatPanel
    // instances for the same jobId+localId simultaneously. jsdom's
    // matchMedia stub (test/setup.ts) defaults to non-matching, so this
    // renders the mobile/tabbed layout -- details visible, chat behind its
    // own not-yet-selected tab.
    renderDialog();
    expect(screen.getByText('Req body')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/ask the assistant/i)).not.toBeInTheDocument();
  });

  it('does not render an interactive exclude control -- excluding is a table-row action, not a dialog action', () => {
    // Regression guard: an earlier version had its own interactive exclude
    // checkbox in the dialog header, duplicating DiffTree's per-row
    // checkbox and giving two places to look for the same state.
    renderDialog();
    expect(screen.queryByRole('checkbox', { name: /exclude/i })).not.toBeInTheDocument();
  });

  it('shows a read-only "Excluded" note when the entry is already excluded', () => {
    renderDialog({ entry: { ...ENTRY, excluded: true } });
    expect(screen.getByText(/excluded from this run/i)).toBeInTheDocument();
  });

  it('shows the collapsed Add child card only once jobMode is set and the job is diff_ready', () => {
    const { rerender } = renderDialog({ jobMode: 'baseline', jobStatus: 'running' });
    expect(screen.queryByRole('button', { name: /^add direct child wi$/i })).not.toBeInTheDocument();

    rerender(
      <ToastProvider>
        <NodeDetailDialog
          open
          onOpenChange={vi.fn()}
          jobId="job-1"
          entry={ENTRY}
          jobMode="baseline"
          jobStatus="diff_ready"
          onAddChild={vi.fn()}
        />
      </ToastProvider>,
    );
    expect(screen.getByRole('button', { name: /^add direct child wi$/i })).toBeInTheDocument();
  });

  it('calls onNavigate("next")/("prev") when the header chevrons are clicked, gated by hasNext/hasPrev', async () => {
    const onNavigate = vi.fn();
    renderDialog({ onNavigate, hasPrev: false, hasNext: true });
    const { default: userEvent } = await import('@testing-library/user-event');

    expect(screen.getByRole('button', { name: /previous item/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /next item/i }));
    expect(onNavigate).toHaveBeenCalledWith('next');
  });

  it('mounts the real two-pane layout (details + chat both visible, no tabs) on a desktop-width viewport', () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);

    renderDialog();
    expect(screen.getByText('Req body')).toBeInTheDocument();
    // Chat pane is genuinely mounted (not behind an unselected tab) --
    // its composer placeholder is present.
    expect(screen.getByPlaceholderText(/ask the assistant/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /chat/i })).not.toBeInTheDocument();

    matchMediaSpy.mockRestore();
  });

  it('disables chat with a status-specific message once the job leaves diff_ready', async () => {
    // jsdom has no real viewport (see test/setup.ts's matchMedia stub, which
    // defaults to non-matching) -- renders the mobile/tabbed layout, so Chat
    // is behind its own tab rather than always-visible as on a real desktop.
    renderDialog({ jobStatus: 'succeeded' });
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('tab', { name: /chat/i }));
    expect(screen.getByText(/this job's review is closed/i)).toBeInTheDocument();
  });

  // Figures section (item 3/4 of the figure-viewing + manual-attach work):
  // this entry's OWN referenced figures, distinct from the document-wide
  // FigureDescriptions panel (JobDetail.tsx).
  describe('Figures section', () => {
    it('renders nothing when the entry has no figureIds', () => {
      renderDialog({ entry: { ...ENTRY, figureIds: [] } });
      expect(screen.queryByText('Figures')).not.toBeInTheDocument();
    });

    it('shows each referenced figure with its caption from captionByFigureId', () => {
      renderDialog({
        entry: { ...ENTRY, figureIds: ['f0'] },
        captionByFigureId: { f0: 'A block diagram showing power distribution.' },
      });
      expect(screen.getByText('Figures')).toBeInTheDocument();
      expect(screen.getByText('A block diagram showing power distribution.')).toBeInTheDocument();
    });

    it('offers an enabled "Upload to ADO" action for a reuse entry with a resolved existingAdoId, and calls onAttachFigure on click', async () => {
      const onAttachFigure = vi.fn().mockResolvedValue(undefined);
      renderDialog({
        entry: { ...ENTRY, action: 'reuse', existingAdoId: 555, figureIds: ['f0'] },
        onAttachFigure,
      });
      const { default: userEvent } = await import('@testing-library/user-event');

      const button = screen.getByRole('button', { name: /upload to ado \(wi-555\)/i });
      expect(button).toBeEnabled();
      await userEvent.click(button);

      expect(onAttachFigure).toHaveBeenCalledWith('e1', 'f0');
      await waitFor(() => expect(screen.getByRole('button', { name: /uploaded/i })).toBeDisabled());
    });

    it('offers the action for a dedup_skip entry too (the case that never gets confirm()\'s automatic attachment)', () => {
      renderDialog({ entry: { ...ENTRY, action: 'dedup_skip', existingAdoId: 777, figureIds: ['f0'] }, onAttachFigure: vi.fn() });
      expect(screen.getByRole('button', { name: /upload to ado \(wi-777\)/i })).toBeEnabled();
    });

    it('does not offer the upload action for a "create" entry -- no resolved ADO id is available in this view', () => {
      renderDialog({ entry: { ...ENTRY, action: 'create', existingAdoId: null, figureIds: ['f0'] }, onAttachFigure: vi.fn() });
      expect(screen.queryByRole('button', { name: /upload to ado/i })).not.toBeInTheDocument();
      expect(screen.getByText(/not available until this job has confirmed/i)).toBeInTheDocument();
    });

    it('reverts to a clickable button (not stuck) when onAttachFigure rejects', async () => {
      const onAttachFigure = vi.fn().mockRejectedValue(new Error('upload failed'));
      renderDialog({ entry: { ...ENTRY, action: 'reuse', existingAdoId: 555, figureIds: ['f0'] }, onAttachFigure });
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.click(screen.getByRole('button', { name: /upload to ado \(wi-555\)/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /upload to ado \(wi-555\)/i })).toBeEnabled());
    });
  });

  // DESIGN.md §11.5 -- the keyboard-accessible reparent control DiffTree's
  // own drag-and-drop always claimed existed but never actually built.
  describe('Move control', () => {
    const EPIC: DryRunDiffEntry = { localId: 'epic1', parentLocalId: null, type: 'Epic', title: 'Root Epic', description: '', action: 'create', customerId: null };
    const OTHER_EPIC: DryRunDiffEntry = { localId: 'epic2', parentLocalId: null, type: 'Epic', title: 'Other Epic', description: '', action: 'create', customerId: null };
    const CHILD_FEATURE: DryRunDiffEntry = { localId: 'e1', parentLocalId: 'epic1', type: 'Feature', title: 'Req Title', description: 'Req body', action: 'create', customerId: '3.2.1' };

    it('does not render when onMove is omitted', () => {
      renderDialog({ entry: CHILD_FEATURE, jobStatus: 'diff_ready', diffByLocalId: { epic1: EPIC, e1: CHILD_FEATURE } });
      expect(screen.queryByRole('button', { name: /move this feature to a different parent/i })).not.toBeInTheDocument();
    });

    it('does not render once the job leaves diff_ready, even with onMove provided', () => {
      renderDialog({ entry: CHILD_FEATURE, jobStatus: 'succeeded', onMove: vi.fn(), diffByLocalId: { epic1: EPIC, e1: CHILD_FEATURE } });
      expect(screen.queryByRole('button', { name: /move this feature to a different parent/i })).not.toBeInTheDocument();
    });

    it('shows the current parent and a working "Move to…" trigger when diff_ready and onMove is provided', () => {
      renderDialog({ entry: CHILD_FEATURE, jobStatus: 'diff_ready', onMove: vi.fn(), diffByLocalId: { epic1: EPIC, e1: CHILD_FEATURE } });
      expect(screen.getByText('Root Epic')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /move this feature to a different parent/i })).toBeEnabled();
    });

    it('shows "Top level (no parent)" for a root entry', () => {
      renderDialog({
        entry: EPIC,
        jobStatus: 'diff_ready',
        onMove: vi.fn(),
        diffByLocalId: { epic1: EPIC, epic2: OTHER_EPIC },
      });
      expect(screen.getByText('Top level (no parent)')).toBeInTheDocument();
    });

    it('calls onMove with the chosen parent when a candidate is selected from the picker', async () => {
      const onMove = vi.fn();
      renderDialog({ entry: CHILD_FEATURE, jobStatus: 'diff_ready', onMove, diffByLocalId: { epic1: EPIC, epic2: OTHER_EPIC, e1: CHILD_FEATURE } });
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.click(screen.getByRole('button', { name: /move this feature to a different parent/i }));
      await userEvent.click(await screen.findByRole('button', { name: /other epic/i }));

      expect(onMove).toHaveBeenCalledWith('e1', { parentLocalId: 'epic2' });
    });

    // Real gap this closes: dragging a reuse/dedup_skip row's DISPLAY
    // position is allowed (DiffTree.tsx's own "already in ADO" badge
    // explains why it's cosmetic) -- the keyboard path must offer the same,
    // not a narrower, capability.
    it('is available for a reuse-matched entry too -- its own display position is still movable', () => {
      renderDialog({
        entry: { ...CHILD_FEATURE, action: 'reuse', existingAdoId: 42 },
        jobStatus: 'diff_ready',
        onMove: vi.fn(),
        diffByLocalId: { epic1: EPIC, e1: { ...CHILD_FEATURE, action: 'reuse', existingAdoId: 42 } },
      });
      expect(screen.getByRole('button', { name: /move this feature to a different parent/i })).toBeEnabled();
    });
  });
});
