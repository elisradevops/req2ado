import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('shows the evidence strip once, and not a second Sources block in the details', () => {
    renderDialog({ entry: { ...ENTRY, sourceRef: { documentPath: 'spec.docx', startOffset: 0, endOffset: 5, page: 2 } } });
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeInTheDocument();
    expect(screen.getAllByText('spec.docx')).toHaveLength(1);
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
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
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: true, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
    const props = { onSave: vi.fn(), jobMode: 'survey' as const, jobStatus: 'diff_ready' };
    try {
      const fresh = renderDialog({ entry: { ...ENTRY, qualityIssues: ['compound'] } as DryRunDiffEntry, ...props });
      expect(await screen.findByRole('button', { name: /split into separate requirements/i })).toBeInTheDocument();
      fresh.unmount();

      const stale = renderDialog({ entry: { ...ENTRY, qualityIssues: ['compound'], qualityStale: true } as DryRunDiffEntry, ...props });
      await screen.findByText(/i have read this requirement/i);
      expect(screen.queryByRole('button', { name: /split into separate requirements/i })).not.toBeInTheDocument();
      stale.unmount();

      renderDialog({ entry: { ...ENTRY, type: 'Feature', qualityIssues: ['compound'] } as DryRunDiffEntry, ...props });
      await screen.findByText(/i have read this feature/i);
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

    it('words the mark as "Looks right and next" for a spot-check, on the button, the key hint and A or R', async () => {
      const onMark = vi.fn();
      renderDialog({
        onNavigate: vi.fn(),
        reason: { title: 'No flags', todo: 'Read it.', group: 'info' },
        review: { reviewed: false, onMark, onUnmark: vi.fn(), markLabel: 'Looks right and next', markHint: 'looks right' },
      });
      const { default: userEvent } = await import('@testing-library/user-event');

      expect(screen.queryByRole('button', { name: 'Mark reviewed and next' })).not.toBeInTheDocument();
      expect(screen.getByRole('note')).toHaveTextContent(/A\s*looks right/);
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

      it('ignores a held key: A, R and X act once per press, not once per key repeat', () => {
        const onMark = vi.fn();
        const onReject = vi.fn();
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark, onUnmark: vi.fn(), onReject } });

        fireEvent.keyDown(window, { key: 'a', repeat: true });
        fireEvent.keyDown(window, { key: 'r', repeat: true });
        fireEvent.keyDown(window, { key: 'x', repeat: true });
        expect(onMark).not.toHaveBeenCalled();
        expect(onReject).not.toHaveBeenCalled();

        fireEvent.keyDown(window, { key: 'a' });
        expect(onMark).toHaveBeenCalledTimes(1);
      });

      it('lets the key hints wrap onto the next line, keeping each key with its label', () => {
        renderDialog({
          onNavigate: vi.fn(),
          reason,
          review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onReject: vi.fn(), onUndo: vi.fn() },
        });
        const keys = Array.from(screen.getByRole('note').querySelectorAll('kbd'));
        expect(keys.map((k) => k.textContent)).toEqual(['J', 'K', 'A', 'X', 'U', 'E']);
        for (const key of keys) {
          // One wrapper per key, so a break can only fall between pairs.
          expect(key.parentElement).toHaveClass('whitespace-nowrap');
          expect(key.parentElement?.querySelectorAll('kbd')).toHaveLength(1);
          // The space that lets the line break sits outside the pair: inside a nowrap span it cannot break.
          expect(key.parentElement?.textContent).toMatch(/^\S/);
          // A logical margin, so the hints keep their gap from the text in a right-to-left layout too.
          expect(key.parentElement?.parentElement).toHaveClass('ms-2');
          expect(key.parentElement?.parentElement).not.toHaveClass('ml-2');
          // A line that cannot wrap runs past the dialog edge on a phone.
          expect(key.parentElement?.parentElement).not.toHaveClass('whitespace-nowrap');
        }
      });

      it('names the actions the way the buttons do', () => {
        renderDialog({ onNavigate: vi.fn(), reason, review: { reviewed: false, onMark: vi.fn(), onUnmark: vi.fn(), onReject: vi.fn() } });
        const note = screen.getByRole('note');
        expect(note).toHaveTextContent(/A\s*mark reviewed/);
        expect(note).toHaveTextContent(/X\s*exclude/);
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

        expect(screen.getByRole('note')).toHaveTextContent(/U\s*undo/);
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
        expect(screen.getByRole('note')).toHaveTextContent(/E\s*edit/);
        await userEvent.keyboard('e');
        expect(await screen.findByDisplayValue('Req Title')).toBeInTheDocument();
        unmount();

        renderDialog({ onNavigate: vi.fn(), reason, jobStatus: 'succeeded' });
        expect(screen.getByRole('note')).not.toHaveTextContent(/E\s*edit/);
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
