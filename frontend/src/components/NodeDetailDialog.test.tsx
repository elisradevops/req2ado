import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NodeDetailDialog } from './NodeDetailDialog';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';
import * as chatApi from '../api/chat';
import { useChatSocket } from '../hooks/useChatSocket';
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

// The shortcut keys now live in a popover behind the keyboard button (DESIGN.md §11.4.5): open it and read them.
async function shortcutKeys(): Promise<Array<[string, string]>> {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.click(screen.getByRole('button', { name: /keyboard shortcuts/i }));
  const popover = (await screen.findByText('Keyboard shortcuts')).parentElement as HTMLElement;
  return Array.from(popover.querySelectorAll('li')).map((li) => [li.querySelector('kbd')!.textContent!, li.querySelector('span')!.textContent!] as [string, string]);
}
const desktopViewport = () =>
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: true, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
async function openAssistant(): Promise<void> {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.click(screen.getByRole('button', { name: /^ask/i }));
}

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

  it('shows the source once, in its own Source column beside the proposed text, and not a second Sources block', () => {
    renderDialog({ entry: { ...ENTRY, sourceRef: { documentPath: 'spec.docx', startOffset: 0, endOffset: 5, page: 2 } } });
    const source = screen.getByRole('region', { name: 'Source' });
    expect(source).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Proposed' })).toBeInTheDocument();
    expect(screen.getAllByText('spec.docx')).toHaveLength(1);
    expect(source).toHaveTextContent('spec.docx');
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  it('keeps the reading order the screen shows: the proposed text first, then the source (no CSS reordering)', () => {
    renderDialog({ entry: { ...ENTRY, sourceRef: { documentPath: 'spec.docx', startOffset: 0, endOffset: 5, page: 2 } } });
    const text = screen.getByText('Req body');
    const source = screen.getByRole('region', { name: 'Source' });
    expect(text.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the decision in one footer bar, present even when there is no reason banner, with the wording the caller gives', async () => {
    const onMark = vi.fn();
    const onReject = vi.fn();
    renderDialog({ review: { reviewed: false, onMark, onUnmark: vi.fn(), onReject, markLabel: 'Mark reviewed', rejectLabel: 'Exclude' } });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    const bar = screen.getByRole('group', { name: 'Review decision' });
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(within(bar).getByRole('button', { name: 'Mark reviewed' }));
    await userEvent.click(within(bar).getByRole('button', { name: 'Exclude' }));
    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('shows "Mark not reviewed" in the bar once reviewed, and no bar when the caller offers no review', () => {
    const { unmount } = renderDialog({ review: { reviewed: true, onMark: vi.fn(), onUnmark: vi.fn() } });
    expect(within(screen.getByRole('group', { name: 'Review decision' })).getByRole('button', { name: 'Mark not reviewed' })).toBeInTheDocument();
    unmount();
    renderDialog();
    expect(screen.queryByRole('group', { name: 'Review decision' })).not.toBeInTheDocument();
  });

  it('puts Edit in the header with its key, opens the edit form from there, and has no second Edit button in the body', async () => {
    renderDialog({ jobStatus: 'diff_ready' });
    const edits = screen.getAllByRole('button', { name: /^edit/i });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toHaveAttribute('aria-keyshortcuts', 'E');
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(edits[0]);
    expect(await screen.findByDisplayValue('Req Title')).toBeInTheDocument();
  });

  it('does not repeat an Epic title as its description', () => {
    renderDialog({ entry: { ...ENTRY, type: 'Epic', title: 'Functional and Performance', description: 'Functional and Performance' } });
    expect(screen.getAllByText('Functional and Performance')).toHaveLength(1);
  });

  it('says "No issues flagged." for a scored new Requirement with nothing wrong, so the text keeps its place', () => {
    renderDialog({ entry: { ...ENTRY, qualityScore: 90, qualityCategoryScores: { clarity: 90 } }, jobStatus: 'diff_ready' });
    expect(screen.getByTestId('issues-clean')).toHaveTextContent('No issues flagged.');
  });

  it('does not call an item that was never scored clean: the scoring row says it is not scored, and an Epic has no such line', () => {
    const { unmount } = renderDialog({ entry: { ...ENTRY, qualityScore: null }, jobStatus: 'diff_ready', jobMode: 'baseline' });
    expect(screen.queryByTestId('issues-clean')).not.toBeInTheDocument();
    expect(screen.getByText('Not scored yet.')).toBeInTheDocument();
    unmount();
    renderDialog({ entry: { ...ENTRY, type: 'Epic', qualityScore: 90 }, jobStatus: 'diff_ready' });
    expect(screen.queryByTestId('issues-clean')).not.toBeInTheDocument();
  });

  it('hides the keyboard button on a phone and points to Settings to turn the shortcuts off', async () => {
    renderDialog({ onNavigate: vi.fn() });
    const button = screen.getByRole('button', { name: /keyboard shortcuts/i });
    expect(button).toHaveClass('max-md:hidden');
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(button);
    const link = await screen.findByRole('link', { name: 'Settings' });
    expect(link).toHaveAttribute('href', '/settings');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('has no Source column for an item without a source location, or for an Epic', () => {
    const { unmount } = renderDialog({ entry: { ...ENTRY, sourceRef: undefined } });
    expect(screen.queryByRole('region', { name: 'Source' })).not.toBeInTheDocument();
    unmount();
    renderDialog({ entry: { ...ENTRY, type: 'Epic', sourceRef: { documentPath: 'spec.docx', startOffset: 0, endOffset: 5, page: 2 } } });
    expect(screen.queryByRole('region', { name: 'Source' })).not.toBeInTheDocument();
  });

  describe('the Quality panel folds into "How this was scored" (one closed disclosure, one level)', () => {
    const scored: DryRunDiffEntry = {
      ...ENTRY,
      sourceRef: { documentPath: 'spec.docx', startOffset: 0, endOffset: 5, page: 2 },
      qualityScore: 40,
      qualityCategoryScores: { testability: 35, clarity: 80 },
      qualityIssues: ['not_testable'],
      groundingScore: 0.9,
    };

    it('starts closed: no gauge, no grounding line, no score explanation in the dialog until it is opened', () => {
      renderDialog({ entry: scored, jobMode: 'survey' });
      expect(screen.getByRole('button', { name: /how this was scored/i })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Quality')).not.toBeInTheDocument();
      expect(screen.queryByText(/matches source wording/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /why this score/i })).not.toBeInTheDocument();
    });

    it('says the score and the weakest area in its closed summary line when the score is not low', () => {
      renderDialog({ entry: { ...scored, qualityScore: 60 }, jobMode: 'survey' });
      const toggle = screen.getByRole('button', { name: /how this was scored/i });
      expect(toggle).toHaveTextContent('Quality 60 of 100');
      expect(toggle).toHaveTextContent(/weakest area: .*35 of 100/i);
    });

    it('says a low score once, in the issues list, and not again on the closed summary line', () => {
      renderDialog({ entry: scored, jobMode: 'survey' });
      expect(screen.getByTestId('issue-quality-low')).toHaveTextContent('Quality 40 of 100. Weakest: testability (35).');
      expect(screen.getByRole('button', { name: /how this was scored/i })).not.toHaveTextContent(/Quality 40/);
    });

    it('holds the whole Quality panel once opened, after the evidence, with no disclosure nested inside it', () => {
      renderDialog({ entry: scored, jobMode: 'survey' });
      fireEvent.click(screen.getByRole('button', { name: /how this was scored/i }));
      const region = screen.getByRole('region', { name: /how this was scored/i });
      expect(within(region).getByText('Quality')).toBeInTheDocument();
      expect(within(region).getByText(/matches source wording/i)).toBeInTheDocument();
      expect(within(region).getByRole('button', { name: /why this score/i })).toBeInTheDocument();
      // nothing inside opens and closes: every category's definition and fixes are shown flat
      expect(region.querySelectorAll('[aria-expanded]')).toHaveLength(0);
      expect(within(region).getAllByText(/testab/i).length).toBeGreaterThan(0);
      const text = screen.getByText('Req body');
      expect(text.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('says the score is out of date once, in the issues list, with Re-check quality outside the closed disclosure as a reachable button', () => {
      renderDialog({ entry: { ...scored, qualityStale: true }, jobMode: 'survey', jobStatus: 'diff_ready', onRescore: vi.fn() } as any);
      expect(screen.getByRole('button', { name: /how this was scored/i })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getAllByText(/edited since (it|this) was scored/i)).toHaveLength(1);
      expect(screen.getByTestId('issue-stale')).toHaveTextContent('Edited since it was scored. The score may be out of date.');
      const recheck = screen.getByRole('button', { name: /re-check quality/i });
      recheck.focus();
      expect(recheck).toHaveFocus();
      expect(screen.getByRole('button', { name: /how this was scored/i })).not.toHaveTextContent(/before your edit/i);
    });

    it('keeps "Score this item" outside the disclosure for an item that has no score', () => {
      renderDialog({ entry: { ...ENTRY, qualityScore: null }, jobMode: 'survey', jobStatus: 'diff_ready', onRescore: vi.fn() } as any);
      expect(screen.getByText('Not scored yet.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /score this item/i })).toBeInTheDocument();
    });
  });

  it('renders nothing when entry is null', () => {
    const { container } = renderDialog({ entry: null });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the item title once: in the dialog header, not again as a heading in the body', () => {
    renderDialog();
    expect(screen.getAllByText('Req Title')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Req Title' })).not.toBeInTheDocument();
  });

  it('wraps the header title and keeps it readable in full via title, instead of truncating it', () => {
    renderDialog();
    const title = screen.getAllByText('Req Title')[0];
    expect(title).toHaveAttribute('title', 'Req Title');
    expect(title.className).not.toContain('truncate');
  });

  it('lets the browser pick the header title\'s direction, so a Hebrew title reads right to left', () => {
    renderDialog({ entry: { ...ENTRY, title: 'ממשק משתמש (UI) למערכת' } });
    expect(screen.getByText('ממשק משתמש (UI) למערכת')).toHaveAttribute('dir', 'auto');
  });

  it('renders the item title, type badge, and customer ID in the header', () => {
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

  it('offers the split starter in the chat only for a fresh compound-flagged Requirement', async () => {
    const matchMediaSpy = desktopViewport();
    const props = { onSave: vi.fn(), jobMode: 'survey' as const, jobStatus: 'diff_ready' };
    try {
      const fresh = renderDialog({ entry: { ...ENTRY, qualityIssues: ['compound'] } as DryRunDiffEntry, ...props });
      await openAssistant();
      expect(await screen.findByRole('button', { name: /split into separate requirements/i })).toBeInTheDocument();
      fresh.unmount();

      const stale = renderDialog({ entry: { ...ENTRY, qualityIssues: ['compound'], qualityStale: true } as DryRunDiffEntry, ...props });
      await openAssistant();
      await screen.findByText(/start from a suggestion/i);
      expect(screen.queryByRole('button', { name: /split into separate requirements/i })).not.toBeInTheDocument();
      stale.unmount();

      renderDialog({ entry: { ...ENTRY, type: 'Feature', qualityIssues: ['compound'] } as DryRunDiffEntry, ...props });
      await openAssistant();
      await screen.findByText(/ask for a change to this feature/i);
      expect(screen.queryByRole('button', { name: /split into separate requirements/i })).not.toBeInTheDocument();
    } finally {
      matchMediaSpy.mockRestore();
    }
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
    expect(screen.queryByRole('button', { name: /^add direct child item$/i })).not.toBeInTheDocument();

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
    expect(screen.getByRole('button', { name: /^add direct child item$/i })).toBeInTheDocument();
  });

  // class pin: jsdom has no layout
  it('gives the header chevrons a visible focus ring, 16px icons and a 24px hit area', () => {
    renderDialog({ onNavigate: vi.fn(), hasPrev: true, hasNext: true });
    for (const name of [/previous item/i, /next item/i]) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toContain('focus-visible:outline-2');
      expect(button.className).toContain('focus-visible:outline-focus');
      expect(button).toHaveClass('min-h-6', 'min-w-6');
      expect(button.querySelector('svg')).toHaveClass('h-4', 'w-4');
    }
  });

  it('calls onNavigate("next")/("prev") when the header chevrons are clicked, gated by hasNext/hasPrev', async () => {
    const onNavigate = vi.fn();
    renderDialog({ onNavigate, hasPrev: false, hasNext: true });
    const { default: userEvent } = await import('@testing-library/user-event');

    expect(screen.getByRole('button', { name: /previous item/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /next item/i }));
    expect(onNavigate).toHaveBeenCalledWith('next');
  });

  describe('keyboard stepping and warning reason', () => {
    it('J steps to the next item and K to the previous, gated by hasNext/hasPrev', async () => {
      const onNavigate = vi.fn();
      renderDialog({ onNavigate, hasPrev: true, hasNext: true });
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.keyboard('j');
      expect(onNavigate).toHaveBeenLastCalledWith('next');
      await userEvent.keyboard('k');
      expect(onNavigate).toHaveBeenLastCalledWith('prev');
    });

    it('ignores J/K at the ends of the list', async () => {
      const onNavigate = vi.fn();
      renderDialog({ onNavigate, hasPrev: false, hasNext: false });
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.keyboard('jk');
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('does not steal J/K while typing in a field, or with a modifier held', () => {
      const onNavigate = vi.fn();
      renderDialog({ onNavigate, hasPrev: true, hasNext: true });

      // fireEvent on the field itself: Radix's focus trap would pull a
      // real .focus() on an out-of-dialog input straight back inside.
      const input = document.createElement('input');
      screen.getByRole('dialog').appendChild(input);
      fireEvent.keyDown(input, { key: 'j' });
      fireEvent.keyDown(input, { key: 'k' });
      input.remove();
      fireEvent.keyDown(document.body, { key: 'j', ctrlKey: true });
      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('shows why the item is being reviewed when opened from a focused warning', () => {
      renderDialog({
        onNavigate: vi.fn(),
        reason: { title: 'Low grounding: possible fabrication', todo: 'Read each item against its source.', group: 'review' },
      });
      const note = screen.getByRole('note');
      expect(note).toHaveTextContent('Low grounding: possible fabrication.');
      expect(note).toHaveTextContent('Read each item against its source.');
    });

    it('says where the reviewer is in the queue: "3 of 17" in the note', () => {
      renderDialog({
        onNavigate: vi.fn(),
        reason: { title: 'Low quality score', todo: 'Read it.', group: 'review' },
        review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), position: { index: 3, total: 17 } },
      });
      expect(screen.getByRole('note')).toHaveTextContent('3 of 17');
    });

    it('offers Mark reviewed and next, and R does the same, while the item is unreviewed', async () => {
      const onMark = vi.fn();
      renderDialog({
        onNavigate: vi.fn(),
        reason: { title: 'Low grounding: possible fabrication', todo: 'Read it.', group: 'review' },
        review: { reviewed: false, onMark, onUnmark: vi.fn() },
      });
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed and next' }));
      expect(onMark).toHaveBeenCalledTimes(1);

      await userEvent.keyboard('r');
      expect(onMark).toHaveBeenCalledTimes(2);
    });

    it('on a Fix item, A and R do nothing and say why; only the deliberate "Keep as written and next" button decides it', async () => {
      const onMark = vi.fn();
      const onKeyBlocked = vi.fn();
      renderDialog({
        onNavigate: vi.fn(),
        reason: { title: 'Requirement has no Customer ID', todo: 'Add one, or keep it as written.', group: 'fix' },
        review: { reviewed: false, onMark, onUnmark: vi.fn(), markLabel: 'Keep as written and next', keepAsWritten: true, onKeyBlocked },
      });
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.keyboard('a');
      await userEvent.keyboard('r');
      expect(onMark).not.toHaveBeenCalled();
      expect(onKeyBlocked).toHaveBeenCalledTimes(2);

      expect(screen.getByRole('note')).not.toHaveTextContent(/A\/R/);
      const button = screen.getByRole('button', { name: 'Keep as written and next' });
      expect(button).not.toHaveAttribute('aria-keyshortcuts');
      await userEvent.click(button);
      expect(onMark).toHaveBeenCalledTimes(1);
    });

    it('words the mark as "Looks right and next" for a spot-check, on the button, the shortcut list and A or R', async () => {
      const onMark = vi.fn();
      renderDialog({
        onNavigate: vi.fn(),
        reason: { title: 'No flags', todo: 'Read it.', group: 'info' },
        review: { reviewed: false, onMark, onUnmark: vi.fn(), markLabel: 'Looks right and next', markHint: 'looks right' },
      });
      const { default: userEvent } = await import('@testing-library/user-event');

      expect(screen.queryByRole('button', { name: 'Mark reviewed and next' })).not.toBeInTheDocument();
      expect(await shortcutKeys()).toContainEqual(['A/R', 'looks right']);
      await userEvent.keyboard('{Escape}');
      await userEvent.click(screen.getByRole('button', { name: 'Looks right and next' }));
      await userEvent.keyboard('a');
      expect(onMark).toHaveBeenCalledTimes(2);
    });

    it('swaps to Mark not reviewed for a reviewed item, and R no longer marks', async () => {
      const onMark = vi.fn();
      const onUnmark = vi.fn();
      renderDialog({
        onNavigate: vi.fn(),
        reason: { title: 'Low grounding: possible fabrication', todo: 'Read it.', group: 'review' },
        review: { reviewed: true, onMark, onUnmark },
      });
      const { default: userEvent } = await import('@testing-library/user-event');

      expect(screen.queryByRole('button', { name: 'Mark reviewed and next' })).not.toBeInTheDocument();
      await userEvent.keyboard('r');
      expect(onMark).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Mark not reviewed' }));
      expect(onUnmark).toHaveBeenCalledTimes(1);
    });

    it('shows no reason banner by default', () => {
      renderDialog();
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    describe('accept / exclude keys (risk-ordered queue)', () => {
      const reason = { title: 'Review queue', todo: 'Riskiest first.', group: 'review' as const };

      it('A accepts the item, same as R', async () => {
        const onMark = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark, onUnmark: vi.fn() } });
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.keyboard('a');
        expect(onMark).toHaveBeenCalledTimes(1);
        await userEvent.keyboard('r');
        expect(onMark).toHaveBeenCalledTimes(2);
      });

      it('X excludes the item and the button does the same, only when the page offers it', async () => {
        const onReject = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onReject } });
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.keyboard('x');
        expect(onReject).toHaveBeenCalledTimes(1);
        await userEvent.click(screen.getByRole('button', { name: 'Exclude and next' }));
        expect(onReject).toHaveBeenCalledTimes(2);
      });

      it('offers no exclude control and ignores X when there is no onReject (the warning-focus review)', async () => {
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn() } });
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.keyboard('x');
        expect(screen.queryByRole('button', { name: 'Exclude and next' })).not.toBeInTheDocument();
      });

      it('ignores A and X on a reviewed item', async () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: true, onMark, onUnmark: vi.fn(), onReject } });
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.keyboard('ax');
        expect(onMark).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();
      });

      it('speaks its announcement from inside the dialog, since the page behind a modal is hidden from screen readers', () => {
        renderDialog({ onNavigate: vi.fn(), reason, announcement: 'Marked reviewed. 2 left.' });
        const status = within(screen.getByRole('dialog')).getByRole('status');
        expect(status).toHaveTextContent('Marked reviewed. 2 left.');
        expect(status).toHaveAttribute('aria-live', 'polite');
      });

      it('ignores a held key: A, R, X, U and E act once per press, not once per key repeat', () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        const onUndo = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark, onUnmark: vi.fn(), onReject, onUndo } });

        for (const key of ['a', 'r', 'x', 'u', 'e']) fireEvent.keyDown(window, { key, repeat: true });
        fireEvent.keyDown(window, { key: 'ש', code: 'KeyA', repeat: true });
        expect(onMark).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();
        expect(onUndo).not.toHaveBeenCalled();
        expect(screen.queryByRole('textbox', { name: /title/i })).not.toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'a' });
        expect(onMark).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(window, { key: 'u' });
        expect(onUndo).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(window, { key: 'ש', code: 'KeyA' });
        expect(onMark).toHaveBeenCalledTimes(2);
      });

      it('does not treat a dead, IME or unidentified key as a shortcut through the physical code', () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark, onUnmark: vi.fn(), onReject } });
        for (const key of ['Dead', 'Unidentified', 'Process']) {
          fireEvent.keyDown(window, { key, code: 'KeyA' });
          fireEvent.keyDown(window, { key, code: 'KeyX' });
        }
        expect(onMark).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();
      });

      it('ignores a key whose real origin (composedPath, e.g. inside a shadow root) is a text field', () => {
        const onMark = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark, onUnmark: vi.fn() } });
        const textarea = document.createElement('textarea');
        const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
        Object.defineProperty(event, 'composedPath', { value: () => [textarea, window] });
        window.dispatchEvent(event);
        expect(onMark).not.toHaveBeenCalled();
      });

      it('has no hint bar: the keys are in a popover behind a labelled keyboard button, and on the buttons as aria-keyshortcuts', async () => {
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onReject: vi.fn(), onUndo: vi.fn() } });
        expect(screen.queryByTestId('key-hints')).not.toBeInTheDocument();
        expect((await shortcutKeys()).map(([key]) => key)).toEqual(['J', 'K', 'A/R', 'X', 'U', 'E', 'C']);
        expect(screen.getByRole('button', { name: /^ask/i })).toHaveAttribute('aria-keyshortcuts', 'C');
      });

      it('names the actions the way the buttons do', () => {
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onReject: vi.fn() } });
        return shortcutKeys().then((keys) => {
          expect(keys).toContainEqual(['A/R', 'mark reviewed']);
          expect(keys).toContainEqual(['X', 'exclude']);
        });
      });

      it('does not act while typing in a field', async () => {
        const onMark = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark, onUnmark: vi.fn() } });
        const { default: userEvent } = await import('@testing-library/user-event');
        // Inside the dialog: Radix's focus trap would pull an outside field's focus back in.
        const input = document.createElement('input');
        screen.getByRole('dialog').appendChild(input);
        input.focus();

        await userEvent.keyboard('a');
        expect(onMark).not.toHaveBeenCalled();
        input.remove();
      });

      it('U runs the last undo, hint and key both gated by the shortcuts switch', async () => {
        const onUndo = vi.fn();
        const review = { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onUndo };
        const { unmount } = renderDialog({ onNavigate: vi.fn(), reason, review });
        const { default: userEvent } = await import('@testing-library/user-event');

        expect(await shortcutKeys()).toContainEqual(['U', 'undo']);
        await userEvent.keyboard('{Escape}');
        await userEvent.keyboard('u');
        expect(onUndo).toHaveBeenCalledTimes(1);
        unmount();

        const off = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, shortcutsEnabled: false, review: { ...review, onUndo: off } });
        await userEvent.keyboard('u');
        expect(off).not.toHaveBeenCalled();
      });

      it('shows no undo hint and ignores U when the page offers no undo', async () => {
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn() } });
        const { default: userEvent } = await import('@testing-library/user-event');
        expect(screen.getByRole('note')).not.toHaveTextContent(/undo/i);
        await userEvent.keyboard('u');
      });

      it('E opens the edit form of an editable item and shows the hint only then', async () => {
        const { default: userEvent } = await import('@testing-library/user-event');
        const { unmount } = renderDialog({ onNavigate: vi.fn(), reason, jobStatus: 'diff_ready' });
        expect(await shortcutKeys()).toContainEqual(['E', 'edit']);
        await userEvent.keyboard('{Escape}');
        await userEvent.keyboard('e');
        expect(await screen.findByDisplayValue('Req Title')).toBeInTheDocument();
        unmount();

        renderDialog({ onNavigate: vi.fn(), reason, jobStatus: 'succeeded' });
        expect((await shortcutKeys()).map(([key]) => key)).not.toContain('E');
        await userEvent.keyboard('{Escape}');
        await userEvent.keyboard('e');
        expect(screen.queryByDisplayValue('Req Title')).not.toBeInTheDocument();
      });

      it('E does nothing with shortcuts off and is not a request while typing', async () => {
        const { default: userEvent } = await import('@testing-library/user-event');
        const { unmount } = renderDialog({ onNavigate: vi.fn(), reason, shortcutsEnabled: false });
        await userEvent.keyboard('e');
        expect(screen.queryByDisplayValue('Req Title')).not.toBeInTheDocument();
        unmount();

        renderDialog({ onNavigate: vi.fn(), reason });
        const input = document.createElement('input');
        screen.getByRole('dialog').appendChild(input);
        input.focus();
        await userEvent.keyboard('e');
        expect(screen.queryByDisplayValue('Req Title')).not.toBeInTheDocument();
        input.remove();
      });

      it('ignores letters typed inside a listbox, option, menu, menuitem or combobox in the dialog', () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark, onUnmark: vi.fn(), onReject } });
        const dialog = screen.getByRole('dialog');
        for (const role of ['option', 'menuitem', 'combobox', 'listbox']) {
          const el = document.createElement('div');
          el.setAttribute('role', role);
          el.tabIndex = 0;
          dialog.appendChild(el);
          fireEvent.keyDown(el, { key: 'a' });
          fireEvent.keyDown(el, { key: 'x' });
        }
        expect(onMark).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();
      });

      it('ignores Shift+letter, IME composition and keyCode 229', () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark, onUnmark: vi.fn(), onReject } });
        fireEvent.keyDown(window, { key: 'A', shiftKey: true });
        fireEvent.keyDown(window, { key: 'X', shiftKey: true });
        fireEvent.keyDown(window, { key: 'a', isComposing: true });
        fireEvent.keyDown(window, { key: 'a', keyCode: 229 });
        expect(onMark).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();
      });

      it('works on a Hebrew layout through the physical key, and a Latin key still wins over the code', () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        const onNavigate = vi.fn();
        renderDialog({
          onNavigate,
          hasNext: true,
          hasPrev: true,
          reason,
          review: { reviewed: false, onMark, onUnmark: vi.fn(), onReject },
        });
        fireEvent.keyDown(window, { key: '\u05E9', code: 'KeyA' });
        expect(onMark).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(window, { key: '\u05E1', code: 'KeyX' });
        expect(onReject).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(window, { key: '\u05D7', code: 'KeyJ' });
        expect(onNavigate).toHaveBeenLastCalledWith('next');
        fireEvent.keyDown(window, { key: '\u05DC', code: 'KeyK' });
        expect(onNavigate).toHaveBeenLastCalledWith('prev');
        // AZERTY: the Latin key 'a' is on the physical Q position and still marks.
        fireEvent.keyDown(window, { key: 'a', code: 'KeyQ' });
        expect(onMark).toHaveBeenCalledTimes(2);
        // A Latin 'q' on the physical A position is not a shortcut.
        fireEvent.keyDown(window, { key: 'q', code: 'KeyA' });
        expect(onMark).toHaveBeenCalledTimes(2);
      });

      it('lists the keys in the popover when there is no reason, with A/R for the mark', async () => {
        renderDialog({
          onNavigate: vi.fn(),
          review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onReject: vi.fn() },
        });
        expect(screen.queryByRole('note')).not.toBeInTheDocument();
        expect((await shortcutKeys()).map(([key]) => key)).toEqual(['J', 'K', 'A/R', 'X', 'E', 'C']);
      });

      it('lists the keys a spot-check supports, worded as the button is', async () => {
        renderDialog({
          onNavigate: vi.fn(),
          review: {
            reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onReject: vi.fn(),
            markLabel: 'Looks right and next', markHint: 'looks right',
          },
        });
        const keys = await shortcutKeys();
        expect(keys).toContainEqual(['A/R', 'looks right']);
        expect(keys.map(([key]) => key)).toEqual(['J', 'K', 'A/R', 'X', 'E', 'C']);
      });

      it('declares aria-keyshortcuts on the buttons only while shortcuts are on', () => {
        const props = {
          onNavigate: vi.fn(),
          hasNext: true,
          hasPrev: true,
          reason,
          review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onReject: vi.fn() },
        };
        const { unmount } = renderDialog(props);
        expect(screen.getByRole('button', { name: 'Mark reviewed and next' })).toHaveAttribute('aria-keyshortcuts', 'A R');
        expect(screen.getByRole('button', { name: 'Exclude and next' })).toHaveAttribute('aria-keyshortcuts', 'X');
        expect(screen.getByRole('button', { name: /previous item/i })).toHaveAttribute('aria-keyshortcuts', 'K');
        expect(screen.getByRole('button', { name: /next item/i })).toHaveAttribute('aria-keyshortcuts', 'J');
        unmount();
        renderDialog({ ...props, shortcutsEnabled: false });
        for (const name of ['Mark reviewed and next', 'Exclude and next', /previous item/i, /next item/i]) {
          expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-keyshortcuts');
        }
      });

      it('marks the mode buttons busy without disabling them, and ignores clicks and keys while busy', async () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        const onBusyAttempt = vi.fn();
        renderDialog({
          onNavigate: vi.fn(),
          reason,
          review: { reviewed: false, busy: true, onMark, onUnmark: vi.fn(), onReject, onBusyAttempt },
        });
        const { default: userEvent } = await import('@testing-library/user-event');
        let attempts = 0;
        for (const name of ['Mark reviewed and next', 'Exclude and next']) {
          const button = screen.getByRole('button', { name });
          expect(button).toHaveAttribute('aria-busy', 'true');
          expect(button).toHaveAttribute('aria-disabled', 'true');
          expect(button).not.toBeDisabled();
          await userEvent.click(button);
          expect(onBusyAttempt).toHaveBeenCalledTimes(++attempts);
        }
        for (const key of ['a', 'r', 'x']) {
          await userEvent.keyboard(key);
          expect(onBusyAttempt).toHaveBeenCalledTimes(++attempts);
        }
        expect(onMark).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();
      });

      it('marks "Mark not reviewed" busy too, and acts normally when not busy', async () => {
        const onUnmark = vi.fn();
        const onBusyAttempt = vi.fn();
        const { unmount } = renderDialog({
          onNavigate: vi.fn(),
          reason,
          review: { reviewed: true, busy: true, onMark: vi.fn(), onUnmark, onBusyAttempt },
        });
        const { default: userEvent } = await import('@testing-library/user-event');
        const busyButton = screen.getByRole('button', { name: 'Mark not reviewed' });
        expect(busyButton).toHaveAttribute('aria-busy', 'true');
        await userEvent.click(busyButton);
        expect(onUnmark).not.toHaveBeenCalled();
        expect(onBusyAttempt).toHaveBeenCalledTimes(1);
        unmount();

        const onMark = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, busy: false, onMark, onUnmark } });
        const button = screen.getByRole('button', { name: 'Mark reviewed and next' });
        expect(button).not.toHaveAttribute('aria-busy', 'true');
        expect(button).not.toHaveAttribute('aria-disabled', 'true');
        await userEvent.click(button);
        await userEvent.keyboard('a');
        expect(onMark).toHaveBeenCalledTimes(2);
      });

      it('turns every single-key shortcut off, J and K included, and hides the key hints', async () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        const onNavigate = vi.fn();
        renderDialog({
          onNavigate,
          hasNext: true,
          hasPrev: true,
          shortcutsEnabled: false,
          reason,
          review: { reviewed: false, onMark, onUnmark: vi.fn(), onReject },
        });
        const { default: userEvent } = await import('@testing-library/user-event');

        await userEvent.keyboard('jkrax');
        expect(onMark).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.getByRole('note').querySelector('kbd')).toBeNull();
        // The buttons still work with the mouse or Enter.
        await userEvent.click(screen.getByRole('button', { name: 'Exclude and next' }));
        expect(onReject).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('keeps the assistant closed to begin with, and mounts it only while it is open (no chat history fetched for a closed one)', async () => {
    const matchMediaSpy = desktopViewport();
    renderDialog();
    expect(screen.getByText('Req body')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/ask the assistant/i)).not.toBeInTheDocument();
    expect(chatApi.getChatHistory).not.toHaveBeenCalled();
    await openAssistant();
    expect(await screen.findByPlaceholderText(/ask the assistant/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /chat/i })).not.toBeInTheDocument();
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^ask/i }));
    expect(screen.queryByPlaceholderText(/ask the assistant/i)).not.toBeInTheDocument();
    matchMediaSpy.mockRestore();
  });

  it('opens the assistant with C and puts focus in its composer, so a c typed there does not toggle it', async () => {
    renderDialog({ onNavigate: vi.fn() });
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.keyboard('c');
    const composer = await screen.findByPlaceholderText(/ask the assistant/i);
    expect(composer).toHaveFocus();
    await userEvent.keyboard('c');
    expect(screen.getByPlaceholderText(/ask the assistant/i)).toHaveValue('c');
  });

  it('ignores a held C (key repeat), so the drawer does not flicker open and closed', () => {
    renderDialog({ onNavigate: vi.fn() });
    fireEvent.keyDown(window, { key: 'c', repeat: true });
    expect(screen.queryByPlaceholderText(/ask the assistant/i)).not.toBeInTheDocument();
  });

  it('closes only the assistant on Escape, and the dialog on the next Escape', async () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^ask/i }));
    await screen.findByPlaceholderText(/ask the assistant/i);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText(/ask the assistant/i)).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables chat with a status-specific message once the job leaves diff_ready', async () => {
    renderDialog({ jobStatus: 'succeeded' });
    await openAssistant();
    expect(await screen.findByText(/this job's review is closed/i)).toBeInTheDocument();
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

    it('offers an enabled "Upload to Azure DevOps" action for a reuse entry with a resolved existingAdoId, and calls onAttachFigure on click', async () => {
      const onAttachFigure = vi.fn().mockResolvedValue(undefined);
      renderDialog({
        entry: { ...ENTRY, action: 'reuse', existingAdoId: 555, figureIds: ['f0'] },
        onAttachFigure,
      });
      const { default: userEvent } = await import('@testing-library/user-event');

      const button = screen.getByRole('button', { name: /upload to azure devops \(wi-555\)/i });
      expect(button).toBeEnabled();
      await userEvent.click(button);

      expect(onAttachFigure).toHaveBeenCalledWith('e1', 'f0');
      await waitFor(() => expect(screen.getByRole('button', { name: /uploaded/i })).toBeDisabled());
    });

    it('offers the action for a dedup_skip entry too (the case that never gets confirm()\'s automatic attachment)', () => {
      renderDialog({ entry: { ...ENTRY, action: 'dedup_skip', existingAdoId: 777, figureIds: ['f0'] }, onAttachFigure: vi.fn() });
      expect(screen.getByRole('button', { name: /upload to azure devops \(wi-777\)/i })).toBeEnabled();
    });

    it('does not offer the upload action for a "create" entry -- no resolved ADO id is available in this view', () => {
      renderDialog({ entry: { ...ENTRY, action: 'create', existingAdoId: null, figureIds: ['f0'] }, onAttachFigure: vi.fn() });
      expect(screen.queryByRole('button', { name: /upload to azure devops/i })).not.toBeInTheDocument();
      expect(screen.getByText(/after the item is written to Azure DevOps/i)).toBeInTheDocument();
    });

    it('reverts to a clickable button (not stuck) when onAttachFigure rejects', async () => {
      const onAttachFigure = vi.fn().mockRejectedValue(new Error('upload failed'));
      renderDialog({ entry: { ...ENTRY, action: 'reuse', existingAdoId: 555, figureIds: ['f0'] }, onAttachFigure });
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.click(screen.getByRole('button', { name: /upload to azure devops \(wi-555\)/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /upload to azure devops \(wi-555\)/i })).toBeEnabled());
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

describe('NodeDetailDialog: reviewing an assistant suggestion beside the original (DESIGN.md §11.4.6)', () => {
  type Emit = (event: import('../hooks/useChatSocket').StreamEvent) => void;
  let emit: Emit | undefined;
  const SOURCE = { documentPath: 'spec.docx', startOffset: 0, endOffset: 5, page: 2 };
  const comparison = {
    before: { score: 45, issues: [], categoryScores: { Testable: 35 }, confidence: 'high' },
    after: { score: 78, issues: [], categoryScores: { Testable: 80 }, confidence: 'high' },
    delta: 33,
    categoryDeltas: { Testable: 45 },
    warnings: [],
  };

  beforeEach(() => {
    emit = undefined;
    vi.mocked(useChatSocket).mockImplementation((_job, _node, onEvent) => {
      emit = onEvent;
    });
    vi.mocked(chatApi.checkRewrite).mockImplementation(async (_job, _node, proposal) =>
      (proposal.warningsOnly ? { before: { score: null }, after: { score: null }, delta: null, warnings: [] } : comparison) as never,
    );
  });

  // Opens the assistant and has it propose a rewrite of the description.
  async function openWithSuggestion(props: Partial<React.ComponentProps<typeof NodeDetailDialog>> = {}) {
    const user = (await import('@testing-library/user-event')).default.setup();
    const result = renderDialog({ entry: { ...ENTRY, sourceRef: SOURCE, qualityScore: 45 } as DryRunDiffEntry, jobStatus: 'diff_ready', onNavigate: vi.fn(), ...props });
    await user.click(screen.getByRole('button', { name: /^ask/i }));
    await screen.findByPlaceholderText(/ask the assistant/i);
    act(() => emit?.({ type: 'done', message: 'Here you go', model: 'm', proposedTitle: 'Receiver lock time', proposedDescription: 'The receiver shall acquire lock within 5 ms.' }));
    return { user, ...result };
  }

  it('shows only a summary in the drawer, and opens the comparison in place of the Proposed column, with the Source still beside it', async () => {
    const matchMedia = desktopViewport();
    try {
      const { user } = await openWithSuggestion();
      const summary = await screen.findByTestId('proposal-summary');
      expect(screen.queryByRole('button', { name: /^accept$/i })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Proposed' })).toBeInTheDocument();

      await user.click(within(summary).getByRole('button', { name: /review change/i }));
      expect(await screen.findByRole('region', { name: 'Suggested change' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Proposed' })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Source' })).toBeInTheDocument();
      expect(await within(screen.getByRole('region', { name: 'Suggested change' })).findByText(/predicted 45\s*→\s*78, up 33/i)).toBeInTheDocument();
    } finally {
      matchMedia.mockRestore();
    }
  });

  it('Escape leaves review mode and keeps the suggestion pending; the next Escape closes the assistant', async () => {
    const matchMedia = desktopViewport();
    try {
      const onOpenChange = vi.fn();
      const { user } = await openWithSuggestion({ onOpenChange });
      await user.click(within(await screen.findByTestId('proposal-summary')).getByRole('button', { name: /review change/i }));
      await screen.findByRole('region', { name: 'Suggested change' });

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('region', { name: 'Suggested change' })).not.toBeInTheDocument();
      expect(screen.getByTestId('proposal-summary')).toBeInTheDocument(); // still pending
      expect(onOpenChange).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');
      expect(screen.queryByPlaceholderText(/ask the assistant/i)).not.toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      matchMedia.mockRestore();
    }
  });

  it('keeps the suggestion when the assistant is closed and opened again', async () => {
    const matchMedia = desktopViewport();
    try {
      const { user } = await openWithSuggestion();
      await screen.findByTestId('proposal-summary');
      await user.click(screen.getByRole('button', { name: /^ask/i })); // closes the drawer: the chat panel unmounts
      expect(screen.queryByPlaceholderText(/ask the assistant/i)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /^ask/i }));
      expect(await screen.findByTestId('proposal-summary')).toBeInTheDocument();
    } finally {
      matchMedia.mockRestore();
    }
  });

  it('Accept saves the suggested title and text, and leaves review mode', async () => {
    const matchMedia = desktopViewport();
    try {
      const onSave = vi.fn();
      const { user } = await openWithSuggestion({ onSave });
      await user.click(within(await screen.findByTestId('proposal-summary')).getByRole('button', { name: /review change/i }));
      await user.click(await screen.findByRole('button', { name: /^accept$/i, hidden: false }));
      expect(onSave).toHaveBeenCalledWith('e1', { title: 'Receiver lock time', description: 'The receiver shall acquire lock within 5 ms.' });
      await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Suggested change' })).not.toBeInTheDocument());
      expect(screen.queryByTestId('proposal-summary')).not.toBeInTheDocument();
    } finally {
      matchMedia.mockRestore();
    }
  });

  it('"Edit first" opens the edit form filled with the suggestion', async () => {
    const matchMedia = desktopViewport();
    try {
      const { user } = await openWithSuggestion();
      await user.click(within(await screen.findByTestId('proposal-summary')).getByRole('button', { name: /review change/i }));
      await user.click(await screen.findByRole('button', { name: /edit first/i }));
      expect(await screen.findByDisplayValue('Receiver lock time')).toBeInTheDocument();
      expect(screen.getByDisplayValue('The receiver shall acquire lock within 5 ms.')).toBeInTheDocument();
    } finally {
      matchMedia.mockRestore();
    }
  });

  it('drops a pending suggestion when the dialog moves to another item', async () => {
    const matchMedia = desktopViewport();
    try {
      const { rerender } = await openWithSuggestion();
      await screen.findByTestId('proposal-summary');
      rerender(
        <ToastProvider>
          <NodeDetailDialog open onOpenChange={vi.fn()} jobId="job-1" entry={{ ...ENTRY, localId: 'e2', title: 'Another' } as DryRunDiffEntry} jobStatus="diff_ready" onAddChild={vi.fn()} />
        </ToastProvider>,
      );
      await vi.waitFor(() => expect(screen.queryByTestId('proposal-summary')).not.toBeInTheDocument());
    } finally {
      matchMedia.mockRestore();
    }
  });
});
