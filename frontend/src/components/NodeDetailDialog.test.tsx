import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeDetailDialog } from './NodeDetailDialog';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';
import * as chatApi from '../api/chat';

vi.mock('../api/chat');
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
});
