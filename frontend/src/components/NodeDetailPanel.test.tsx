import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodeDetailPanel, canEditEntry, editabilityOf } from './NodeDetailPanel';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';

vi.mock('./FigureImage', () => ({
  FigureImage: ({ alt, figureId }: { alt: string; figureId: string }) => <img alt={alt} data-figure-id={figureId} />,
}));

// NodeDetailPanel is item-details ONLY -- chat lives in NodeDetailDialog's
// own right pane (ChatPanel, a sibling not a child) since the dialog
// redesign put details and chat in separate panes side by side. Chat's own
// behavior (disabled message, Suggest-a-title, etc.) is covered in
// ChatPanel.test.tsx; canEditEntry's status-gating rule is covered directly
// below and in NodeDetailDialog.test.tsx.
function renderPanel(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('canEditEntry', () => {
  const baseEntry: DryRunDiffEntry = {
    localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', customerId: null,
  };

  it('is true for a create entry while diff_ready, or when jobStatus is omitted (backward compatible)', () => {
    expect(canEditEntry(baseEntry, 'diff_ready')).toBe(true);
    expect(canEditEntry(baseEntry, undefined)).toBe(true);
  });

  it('is false once the job leaves diff_ready', () => {
    expect(canEditEntry(baseEntry, 'succeeded')).toBe(false);
  });

  it('is false for a reuse entry or an excluded entry regardless of status', () => {
    expect(canEditEntry({ ...baseEntry, action: 'reuse' }, 'diff_ready')).toBe(false);
    expect(canEditEntry({ ...baseEntry, excluded: true }, 'diff_ready')).toBe(false);
  });
});

describe('editabilityOf', () => {
  const baseEntry: DryRunDiffEntry = {
    localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', customerId: null,
  };

  it('reports "matched" for a reuse/dedup_skip entry, not just false', () => {
    expect(editabilityOf({ ...baseEntry, action: 'reuse' }, 'diff_ready')).toEqual({ editable: false, reason: 'matched' });
    expect(editabilityOf({ ...baseEntry, action: 'dedup_skip' }, 'diff_ready')).toEqual({ editable: false, reason: 'matched' });
  });

  it('reports "excluded" for an excluded create entry', () => {
    expect(editabilityOf({ ...baseEntry, excluded: true }, 'diff_ready')).toEqual({ editable: false, reason: 'excluded' });
  });

  it('reports "job_locked" once the job leaves diff_ready, even for a create entry', () => {
    expect(editabilityOf(baseEntry, 'writing')).toEqual({ editable: false, reason: 'job_locked' });
  });

  it('reports editable:true for a create entry while diff_ready', () => {
    expect(editabilityOf(baseEntry, 'diff_ready')).toEqual({ editable: true });
  });
});

describe('NodeDetailPanel', () => {
  it('renders a placeholder when nothing is selected', () => {
    renderPanel(<NodeDetailPanel entry={null} />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it('renders the entry description and tags when selected (title and type live in the dialog header)', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: ['functional'] }}
      />,
    );
    expect(screen.queryByText('Req Title')).not.toBeInTheDocument();
    expect(screen.getByText('Req body')).toBeInTheDocument();
    expect(screen.getByText('Functional')).toBeInTheDocument();
  });

  it('renders the description as real markdown -- bold/lists show as formatted elements, not literal ** or -', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{
          localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title',
          description: '**Bold** rule:\n- one\n- two',
          action: 'create', customerId: null, tags: [],
        }}
      />,
    );
    expect(screen.getByText('Bold').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders the quality score and issue chips when present', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{
          localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
          action: 'create', customerId: null, tags: [],
          qualityScore: 72, qualityIssues: ['vague_term'], qualityCategoryScores: { clarity: 40, testability: 80, atomicity: 90, style: 85, rationale: 70 },
        }}
      />,
    );
    expect(screen.getByText('72')).toBeInTheDocument();
    // Real bug fixed here (confirmed against the agreed mockup, which has no
    // "Active Flags" chip-cloud block at all): "Vague term" used to appear
    // TWICE -- once in a standalone Active Flags chip row (IssueChips,
    // showing only the bare label), once as the fix-oriented remedy text
    // under Clarity's own row (QualityGauge's per-category breakdown). The
    // chip row was pure duplication of what the category row already says,
    // with less information (no remedy text) -- removed, so this now
    // appears exactly once, under Clarity, where the real remedy text lives.
    expect(screen.getAllByText(/Vague term\.?$/i).length).toBe(1);
  });

  it('renders Classification as its own block (no paired Active Flags block -- removed as pure duplication of QualityGauge), and Add Child last (DESIGN.md Track B, phase B13)', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{
          localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
          action: 'create', customerId: null, tags: ['functional'], qualityScore: 72, qualityIssues: ['vague_term'],
        }}
        addChildSlot={<div data-testid="add-child-slot">Add child</div>}
      />,
    );
    expect(screen.getByText('Classification')).toBeInTheDocument();
    expect(screen.queryByText('Active Flags')).not.toBeInTheDocument();

    // Add Child renders after everything else in document order, not near
    // the title (where it used to sit, disconnected from what it acts on).
    const panel = screen.getByText('Classification').closest('div.flex.flex-col.gap-3');
    const addChildSlot = screen.getByTestId('add-child-slot');
    expect(panel?.lastElementChild).toBe(addChildSlot);
  });

  it('renders no score line when qualityScore is absent', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/\/\s*100/)).not.toBeInTheDocument();
    // DESIGN.md §11.4.1 -- the gate distinguishes "no rubric for this type"
    // from "this Requirement hasn't been scored yet"; the latter gets its
    // own visible empty state, not silence indistinguishable from an Epic.
    expect(screen.getByText('Not scored yet.')).toBeInTheDocument();
  });

  it('shows a Score this item button next to "Not scored yet." for an editable, never-scored Requirement, when onRescore is supplied', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        onRescore={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /score this item/i })).toBeInTheDocument();
  });

  it('never shows Score this item without an onRescore handler, or for a read-only (reuse/dedup_skip) never-scored entry', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByRole('button', { name: /score this item/i })).not.toBeInTheDocument();

    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e2', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
        onRescore={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /score this item/i })).not.toBeInTheDocument();
  });

  it('clicking Score this item calls onRescore with the entry localId -- reuses the exact same rescore action a stale item\'s Re-check quality button uses', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onRescore = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        onRescore={onRescore}
      />,
    );
    await user.click(screen.getByRole('button', { name: /score this item/i }));
    expect(onRescore).toHaveBeenCalledWith('e1');
    // A first-ever score has no "previous" value to render a delta
    // against -- must never show a fabricated "Rescored." confirmation.
    expect(screen.queryByText('Rescored.')).not.toBeInTheDocument();
  });

  it('shows no gauge for an Epic even when it carries a non-null qualityScore (stale/leftover data) -- the gate is the real ADO type, never score presence', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic Title', description: 'Epic body', action: 'create', customerId: null, tags: [], qualityScore: 55 }}
      />,
    );
    expect(screen.queryByText('55')).not.toBeInTheDocument();
    expect(screen.queryByText('Not scored yet.')).not.toBeInTheDocument();
  });

  // DESIGN.md §11.4.1 -- in place of the absent gauge, an Epic/Feature
  // shows a Scope group: real descendant counts + why there's no score.
  describe('Epic/Feature Scope group', () => {
    it('shows real descendant counts and states plainly why there is no score', () => {
      renderPanel(
        <NodeDetailPanel
          entry={{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic Title', description: 'Epic body', action: 'create', customerId: null, tags: [] }}
          descendantCounts={{ epics: 0, features: 6, requirements: 41 }}
        />,
      );
      expect(screen.getByText('Covers 6 features, 41 requirements.')).toBeInTheDocument();
      expect(screen.getByText(/aren't scored/i)).toBeInTheDocument();
    });

    it('uses singular wording for exactly one descendant of a kind', () => {
      renderPanel(
        <NodeDetailPanel
          entry={{ localId: 'e1', parentLocalId: null, type: 'Feature', title: 'F', description: 'D', action: 'create', customerId: null, tags: [] }}
          descendantCounts={{ epics: 0, features: 0, requirements: 1 }}
        />,
      );
      expect(screen.getByText('Covers 0 features, 1 requirement.')).toBeInTheDocument();
    });

    it('includes nested epics in the covered count, not just features/requirements', () => {
      renderPanel(
        <NodeDetailPanel
          entry={{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic Title', description: 'Epic body', action: 'create', customerId: null, tags: [] }}
          descendantCounts={{ epics: 2, features: 6, requirements: 41 }}
        />,
      );
      expect(screen.getByText('Covers 2 epics, 6 features, 41 requirements.')).toBeInTheDocument();
    });

    it('shows a real empty state, not a fabricated count, when there are no descendants yet', () => {
      renderPanel(
        <NodeDetailPanel
          entry={{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic Title', description: 'D', action: 'create', customerId: null, tags: [] }}
        />,
      );
      expect(screen.getByText('No child items under this Epic yet.')).toBeInTheDocument();
    });

    it('never shows a Scope group for a Requirement, or a gauge for an Epic/Feature', () => {
      renderPanel(
        <NodeDetailPanel
          entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'R', description: 'D', action: 'create', customerId: null, tags: [], qualityScore: 80 }}
        />,
      );
      expect(screen.queryByText('Scope')).not.toBeInTheDocument();
    });
  });

  // CR-7d rescore: Scored / Stale / Re-checking / Rescored.
  describe('rescore', () => {
    const staleEntry: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
      action: 'create', customerId: null, tags: [],
      qualityScore: 40, qualityIssues: ['vague_term'], qualityCategoryScores: { clarity: 20 }, qualityStale: true,
    };

    it('shows no Stale message or Rescore button on a freshly-scored (non-stale) entry', () => {
      renderPanel(
        <NodeDetailPanel entry={{ ...staleEntry, qualityStale: false }} onRescore={vi.fn()} />,
      );
      expect(screen.queryByText(/edited since this was scored/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /re-check/i })).not.toBeInTheDocument();
    });

    it('dims the gauge and shows a Rescore button when the entry is stale', () => {
      renderPanel(<NodeDetailPanel entry={staleEntry} onRescore={vi.fn()} />);
      expect(screen.getByText(/edited since this was scored/i)).toBeInTheDocument();
      // The last-known score is KEPT on screen, never zeroed -- only its
      // freshness is in question.
      expect(screen.getByText('40')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /re-check/i })).toBeInTheDocument();
    });

    it('never shows a Rescore button when the caller supplies no onRescore handler', () => {
      renderPanel(<NodeDetailPanel entry={staleEntry} />);
      expect(screen.getByText(/edited since this was scored/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /re-check/i })).not.toBeInTheDocument();
    });

    it('shows a loading state while rescoring, calls onRescore with the entry localId', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const { waitFor } = await import('@testing-library/react');
      const user = userEvent.setup();
      let resolveRescore: () => void = () => {};
      const onRescore = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveRescore = resolve; }),
      );
      renderPanel(<NodeDetailPanel entry={staleEntry} onRescore={onRescore} />);

      await user.click(screen.getByRole('button', { name: /re-check/i }));

      expect(onRescore).toHaveBeenCalledWith('e1');
      expect(screen.getByRole('button', { name: /re-check/i })).toBeDisabled();

      resolveRescore();
      await waitFor(() => expect(screen.getByRole('button', { name: /re-check/i })).not.toBeDisabled());
    });

    it('never touches the gauge locally on a rejected rescore -- reflects only what the server actually persisted', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      const onRescore = vi.fn().mockRejectedValue(new Error('ingestion unreachable'));
      renderPanel(<NodeDetailPanel entry={staleEntry} onRescore={onRescore} />);

      await user.click(screen.getByRole('button', { name: /re-check/i }));

      // The entry prop itself never changes (this component doesn't own
      // persistence) -- it's still stale, the button is usable again, and
      // no fabricated "Rescored" confirmation appears.
      expect(screen.getByText(/edited since this was scored/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /re-check/i })).not.toBeDisabled();
      expect(screen.queryByText('Rescored.')).not.toBeInTheDocument();
    });

    it('resets rescoring state when a different node is selected mid-flight', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      const onRescore = vi.fn().mockImplementation(() => new Promise<void>(() => {})); // never resolves
      const { rerender } = renderPanel(<NodeDetailPanel entry={staleEntry} onRescore={onRescore} />);

      await user.click(screen.getByRole('button', { name: /re-check/i }));
      expect(screen.getByRole('button', { name: /re-check/i })).toBeDisabled();

      rerender(
        <ToastProvider>
          <NodeDetailPanel entry={{ ...staleEntry, localId: 'e2' }} onRescore={onRescore} />
        </ToastProvider>,
      );

      expect(screen.getByRole('button', { name: /re-check/i })).not.toBeDisabled();
    });

    // Confirmed real bug found+fixed during the review-fix pass: the
    // "resets rescoring state" test above only exercises a promise that
    // NEVER resolves, so it never proved what happens when node A's
    // rescore actually completes after the user has already switched to
    // node B -- this test resolves it and checks B's own gauge/toast area
    // never shows A's leftover data.
    it('never applies a rescore response to the wrong node when the selection changed while the request was in flight', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const { waitFor } = await import('@testing-library/react');
      const user = userEvent.setup();
      let resolveRescore: () => void = () => {};
      const onRescore = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveRescore = resolve; }),
      );
      const entryB: DryRunDiffEntry = { ...staleEntry, localId: 'e2', qualityStale: false };
      const { rerender } = renderPanel(<NodeDetailPanel entry={staleEntry} onRescore={onRescore} />);

      await user.click(screen.getByRole('button', { name: /re-check/i }));

      rerender(
        <ToastProvider>
          <NodeDetailPanel entry={entryB} onRescore={onRescore} />
        </ToastProvider>,
      );
      // entryB is not stale, so it shows no Re-check button at all -- confirms we're
      // really looking at B's own render, not a leftover A-shaped one.
      expect(screen.queryByRole('button', { name: /re-check/i })).not.toBeInTheDocument();

      // NOW resolve node A's original (now-stale-relative-to-selection) request.
      resolveRescore();
      await waitFor(() => expect(onRescore).toHaveBeenCalledTimes(1));

      // B's pane must never show a delta or a "Rescored." confirmation built
      // from A's numbers -- there is nothing for B to have a delta against.
      expect(screen.queryByText('Rescored.')).not.toBeInTheDocument();
      expect(screen.queryByText(/^was /)).not.toBeInTheDocument();
    });
  });

  it('does not leak an expanded category disclosure from one node onto a different node with an identically-named category (QualityGauge must remount, not reuse state, on node switch)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const entryA: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'A', description: 'A body',
      action: 'create', customerId: null, tags: [], qualityScore: 40,
      qualityCategoryScores: { clarity: 20 }, qualityIssues: ['vague_term'],
    };
    const entryB: DryRunDiffEntry = { ...entryA, localId: 'e2', title: 'B', qualityScore: 90, qualityCategoryScores: { clarity: 90 } };
    const { rerender } = renderPanel(<NodeDetailPanel entry={entryA} />);

    await user.click(screen.getByRole('button', { name: /clarity/i }));
    expect(screen.getByRole('button', { name: /clarity/i })).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <ToastProvider>
        <NodeDetailPanel entry={entryB} />
      </ToastProvider>,
    );

    // entryB's clarity row still has vague_term mapped to it (inherited via
    // the fixture's spread), so it still HAS an expand affordance -- the
    // real assertion is that switching nodes reset it to collapsed, not
    // that the affordance vanished.
    const clarityRow = screen.getByText('Clarity').closest('button')!;
    expect(clarityRow).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows an Edit button for a create entry and switches to editable fields on click', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        onSave={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByDisplayValue('Req Title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Req body')).toBeInTheDocument();
  });

  it('opens the edit form when editRequest changes, only for an editable entry, not on mount', () => {
    const entry: DryRunDiffEntry = { localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] };
    const { rerender } = renderPanel(<NodeDetailPanel entry={entry} onSave={vi.fn()} editRequest={3} />);
    // A non-zero counter present at mount is not a request.
    expect(screen.queryByDisplayValue('Req Title')).not.toBeInTheDocument();
    rerender(
      <ToastProvider>
        <NodeDetailPanel entry={entry} onSave={vi.fn()} editRequest={4} />
      </ToastProvider>,
    );
    expect(screen.getByDisplayValue('Req Title')).toBeInTheDocument();
  });

  it('ignores an edit request for an entry that cannot be edited', () => {
    const entry: DryRunDiffEntry = { localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', customerId: null, tags: [] };
    const { rerender } = renderPanel(<NodeDetailPanel entry={entry} onSave={vi.fn()} editRequest={0} />);
    rerender(
      <ToastProvider>
        <NodeDetailPanel entry={entry} onSave={vi.fn()} editRequest={1} />
      </ToastProvider>,
    );
    expect(screen.queryByDisplayValue('Req Title')).not.toBeInTheDocument();
  });

  it('calls onSave with the edited title/description', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    const titleField = screen.getByDisplayValue('Req Title');
    await user.clear(titleField);
    await user.type(titleField, 'Updated Title');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith('e1', { title: 'Updated Title', description: 'Req body', customerId: null, tags: [], seCoverageRef: null });
  });

  it('shows an editable Customer ID field for a Requirement, and includes the edited value on save', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    const customerIdField = screen.getByLabelText(/customer id/i);
    await user.type(customerIdField, '1.1.2.2');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith('e1', { title: 'Req Title', description: 'Req body', customerId: '1.1.2.2', tags: [], seCoverageRef: null });
  });

  it('clears an existing Customer ID to null when the field is emptied before saving', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: '1.1.2.2', tags: [] }}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    const customerIdField = screen.getByDisplayValue('1.1.2.2');
    await user.clear(customerIdField);
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith('e1', { title: 'Req Title', description: 'Req body', customerId: null, tags: [], seCoverageRef: null });
  });

  it('shows an editable SE Coverage Reference field for a Requirement, and includes the edited value on save', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    const seCoverageRefField = screen.getByLabelText(/se coverage reference/i);
    await user.type(seCoverageRefField, 'SYS-REQ-42');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      'e1',
      expect.objectContaining({ seCoverageRef: 'SYS-REQ-42' }),
    );
  });

  it('does not render an SE Coverage Reference field for an Epic or Feature -- only Requirement carries one', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Feature', title: 'Feat Title', description: 'Feat body', action: 'create', customerId: null, tags: [] }}
        onSave={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.queryByLabelText(/se coverage reference/i)).not.toBeInTheDocument();
  });

  it('does not render a Customer ID field for an Epic or Feature -- only Requirement carries one', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Feature', title: 'Feat Title', description: 'Feat body', action: 'create', customerId: null, tags: [] }}
        onSave={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.queryByLabelText(/customer id/i)).not.toBeInTheDocument();
  });

  it('shows the classification control for a Requirement, pre-selected from its existing tags, and includes edits on save', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: ['functional'] }}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    const functionalButton = screen.getByRole('button', { name: /functional/i, pressed: true });
    expect(functionalButton).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^safety$/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      'e1',
      expect.objectContaining({ tags: expect.arrayContaining(['functional', 'safety']) }),
    );
  });

  it('does not render the classification control for an Epic or Feature -- only Requirement carries tags', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Feature', title: 'Feat Title', description: 'Feat body', action: 'create', customerId: null, tags: [] }}
        onSave={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.queryByText('Classification')).not.toBeInTheDocument();
  });

  it('marks the tag that would actually be written to ADO when requirementClassificationField allows it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: ['functional', 'safety'] }}
        onSave={vi.fn()}
        requirementClassificationField={{ referenceName: 'Microsoft.VSTS.CMMI.RequirementType', allowedValues: ['Functional', 'Safety'] }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /edit/i }));
    // safety outranks functional -- see utils/requirementClassification.ts.
    expect(screen.getByText(/"Safety".*written to ADO/i)).toBeInTheDocument();
  });

  it('exits edit mode and drops the stale draft when the selected entry changes mid-edit', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    const nodeA: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Node A Title', description: 'Node A body',
      action: 'create', customerId: null, tags: [],
    };
    const nodeB: DryRunDiffEntry = {
      localId: 'e2', parentLocalId: null, type: 'Requirement', title: 'Node B Title', description: 'Node B body',
      action: 'create', customerId: null, tags: [],
    };

    const { rerender } = renderPanel(<NodeDetailPanel entry={nodeA} onSave={vi.fn()} />);

    // Start editing node A and dirty the draft without saving/cancelling.
    await user.click(screen.getByRole('button', { name: /edit/i }));
    const titleField = screen.getByDisplayValue('Node A Title');
    await user.clear(titleField);
    await user.type(titleField, 'Stale unsaved draft');

    // Select a different node (JobDetail.tsx passes a new entry prop into this
    // still-mounted component) without the user clicking Save or Cancel first.
    rerender(
      <ToastProvider>
        <NodeDetailPanel entry={nodeB} onSave={vi.fn()} />
      </ToastProvider>,
    );

    // Edit mode must be exited: no leftover draft textfield for A's stale text,
    // and node B's data is shown read-only with a fresh Edit button available.
    expect(screen.queryByDisplayValue('Stale unsaved draft')).not.toBeInTheDocument();
    expect(screen.getByText('Node B body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });

  it('renders the source document provenance when sourceRef is present', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{
          localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
          action: 'create', customerId: null, tags: [],
          sourceRef: { documentPath: 'spec.docx', startOffset: 100, endOffset: 200, page: 3 },
        }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('spec.docx')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders no provenance line for a manually-added entry (sourceRef null)', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{
          localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
          action: 'create', customerId: null, tags: [], sourceRef: null,
        }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  describe('Tables and figures (Phase 5 provenance)', () => {
    const tableEntry = (patch: Partial<DryRunDiffEntry> = {}): DryRunDiffEntry => ({
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
      action: 'create', customerId: null, tags: [],
      ...patch,
    });

    it('renders a friendly 1-based ordinal fallback per tableId when no caption is available', () => {
      // t3/t7 are the loader's own 0-based ids -- the fallback must never
      // show the raw internal id, per the resolved "what is even means?!"
      // finding.
      renderPanel(<NodeDetailPanel entry={tableEntry({ tableIds: ['t3', 't7'] })} />);
      expect(screen.getByText('Tables')).toBeInTheDocument();
      expect(screen.getByText('Table 4')).toBeInTheDocument();
      expect(screen.getByText('Table 8')).toBeInTheDocument();
    });

    it('renders the real caption instead of the ordinal fallback when captionByTableId has an entry', () => {
      renderPanel(
        <NodeDetailPanel
          entry={tableEntry({ tableIds: ['t3', 't7'] })}
          captionByTableId={{ t3: 'Summary of CubeADCS Variants' }}
        />,
      );
      expect(screen.getByText('Summary of CubeADCS Variants')).toBeInTheDocument();
      expect(screen.getByText('Table 8')).toBeInTheDocument();
    });

    it('renders no Tables block when tableIds is absent or empty', () => {
      renderPanel(<NodeDetailPanel entry={tableEntry({ tableIds: [] })} />);
      expect(screen.queryByText('Tables')).not.toBeInTheDocument();
    });

    it('renders an amber, distinctly-labeled chip for a genuinely-failed uncaptioned figure, with a narrowed tooltip', async () => {
      // f5 is uncaptioned but NOT in insignificantFigureIds -- a genuine
      // vision_failed case (or vision-off-for-the-whole-run, covered
      // separately by the tree-level vision_captioning_disabled warning).
      renderPanel(<NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f5'] })} />);
      const chip = screen.getByText('Figure f5: no description');
      expect(chip).toBeInTheDocument();
      // Same warning-band token QualityGauge's "Needs review" chip uses --
      // not a one-off color, so "amber" reads consistently everywhere.
      expect(chip.className).toContain('warning');

      const { default: userEvent } = await import('@testing-library/user-event');
      await userEvent.hover(chip);
      // Final whole-branch review finding: the Task 4b narrowed copy asserted
      // a specific failure ("failed or timed out") even in BASELINE/vision-off
      // runs, where caption_status is always null because vision simply never
      // ran -- restored to a disjunctive, honest phrasing that doesn't assert
      // a cause this chip alone can't actually know.
      await waitFor(() =>
        expect(
          screen.getByText(/It will be attached to this item when you write/i),
        ).toBeInTheDocument(),
      );
    });

    it('renders an image card for an uncaptioned figure that is not insignificant', () => {
      renderPanel(
        <NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f5'], title: 'Req Title' })} jobId="job-1" />,
      );
      expect(screen.getByAltText('Figure 1 of 1 for this item')).toBeInTheDocument();
      expect(screen.getByText('No description')).toBeInTheDocument();
      expect(screen.queryByText('Figure f5: no description')).not.toBeInTheDocument();
    });

    it('alt text is Figure n of m', () => {
      renderPanel(
        <NodeDetailPanel
          entry={tableEntry({ figureIds: ['f0'], uncaptionedFigureIds: ['f5', 'f6'], title: 'Req Title' })}
          jobId="job-1"
          nameByFigureId={{ f0: 'Block diagram' }}
        />,
      );
      expect(screen.getByAltText('Block diagram')).toBeInTheDocument();
      expect(screen.getByAltText('Figure 2 of 3 for this item')).toBeInTheDocument();
      expect(screen.getByAltText('Figure 3 of 3 for this item')).toBeInTheDocument();
      expect(screen.queryByAltText(/Req Title/)).not.toBeInTheDocument();
    });

    it('shows the visible hint for an uncaptioned figure', () => {
      renderPanel(<NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f5'] })} jobId="job-1" />);
      expect(
        screen.getByText(
          'No description. It will be attached to this item when you write. If it belongs to another item, upload it there after writing.',
        ),
      ).toBeInTheDocument();
    });

    it('shows the hint once for several uncaptioned figures, with a chip on each card', () => {
      renderPanel(<NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f5', 'f6'] })} jobId="job-1" />);
      expect(
        screen.getAllByText(
          'No description. It will be attached to this item when you write. If it belongs to another item, upload it there after writing.',
        ),
      ).toHaveLength(1);
      expect(screen.getAllByText('No description')).toHaveLength(2);
    });

    it.each(['reuse', 'dedup_skip'])('says figures are not attached automatically for a %s item', (action) => {
      renderPanel(<NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f5', 'f6'], action } as any)} jobId="job-1" />);
      expect(
        screen.getAllByText(
          'No description. Figures are not attached automatically to items that already exist. You can upload it to this item yourself.',
        ),
      ).toHaveLength(1);
      expect(screen.queryByText(/It will be attached to this item when you write/)).not.toBeInTheDocument();
    });

    it('shows an upload failed line', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const onAttachFigure = vi.fn().mockRejectedValue(new Error('x'));
      renderPanel(
        <NodeDetailPanel
          entry={tableEntry({ figureIds: ['f0'], action: 'reuse', existingAdoId: 42 })}
          jobId="job-1"
          onAttachFigure={onAttachFigure}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /Upload to ADO \(WI-42\)/ }));
      expect(await screen.findByText('Upload failed. Try again.')).toBeInTheDocument();
      onAttachFigure.mockResolvedValue(undefined);
      await userEvent.click(screen.getByRole('button', { name: /Upload to ADO \(WI-42\)/ }));
      await waitFor(() => expect(screen.queryByText('Upload failed. Try again.')).not.toBeInTheDocument());
    });

    it('fallback text before the item is written', () => {
      renderPanel(
        <NodeDetailPanel entry={tableEntry({ figureIds: ['f0'] })} jobId="job-1" onAttachFigure={vi.fn()} />,
      );
      expect(screen.getByText('You can upload this figure after the item is written to Azure DevOps.')).toBeInTheDocument();
      expect(screen.queryByText(/resolved ADO work item id/)).not.toBeInTheDocument();
    });

    it('still renders only the chip when there is no job id', () => {
      renderPanel(<NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f5'] })} />);
      expect(screen.getByText('Figure f5: no description')).toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('insignificant figures are not rendered', () => {
      renderPanel(
        <NodeDetailPanel
          entry={tableEntry({ uncaptionedFigureIds: ['f5', 'f6'], insignificantFigureIds: ['f6'] })}
          jobId="job-1"
        />,
      );
      expect(screen.getAllByRole('img')).toHaveLength(1);
      expect(screen.getByRole('img')).toHaveAttribute('data-figure-id', 'f5');
    });

    it('the upload button on an uncaptioned figure calls onAttachFigure with its id when the item has an ADO id', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const onAttachFigure = vi.fn().mockResolvedValue(undefined);
      renderPanel(
        <NodeDetailPanel
          entry={tableEntry({ uncaptionedFigureIds: ['f5'], action: 'reuse', existingAdoId: 42 })}
          jobId="job-1"
          onAttachFigure={onAttachFigure}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /Upload to ADO \(WI-42\)/ }));
      expect(onAttachFigure).toHaveBeenCalledWith('e1', 'f5');
    });

    it('renders no chip at all for an insignificant uncaptioned figure -- hidden from the item view entirely', () => {
      // f6 is uncaptioned AND in insignificantFigureIds -- the vision model
      // correctly judged it decorative/non-technical, not a failure. Per
      // the resolved figure-chip-noise finding, this is now surfaced only
      // in the document-wide "N figures excluded as decorative" summary
      // (JobDetail.tsx), never repeated on every item near it.
      renderPanel(
        <NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f6'], insignificantFigureIds: ['f6'] })} />,
      );
      expect(screen.queryByText(/not significant/)).not.toBeInTheDocument();
    });

    it('renders only the genuinely-failed chip when uncaptionedFigureIds has a mix of insignificant and genuinely-failed figures', () => {
      renderPanel(
        <NodeDetailPanel
          entry={tableEntry({ uncaptionedFigureIds: ['f5', 'f6'], insignificantFigureIds: ['f6'] })}
        />,
      );
      expect(screen.getByText('Figure f5: no description')).toBeInTheDocument();
      expect(screen.queryByText(/not significant/)).not.toBeInTheDocument();
    });

    it('renders the "Figures" section for an uncaptioned figure even with no jobId/figureIds supplied', () => {
      renderPanel(<NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f2'] })} />);
      expect(screen.getByText('Figures')).toBeInTheDocument();
    });

    it('renders no "Figures" section at all when the only figure present is insignificant', () => {
      renderPanel(
        <NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: ['f6'], insignificantFigureIds: ['f6'] })} />,
      );
      expect(screen.queryByText('Figures')).not.toBeInTheDocument();
    });

    it('renders no uncaptioned-figure chip when uncaptionedFigureIds is absent or empty', () => {
      renderPanel(<NodeDetailPanel entry={tableEntry({ uncaptionedFigureIds: [] })} />);
      expect(screen.queryByText(/no description/)).not.toBeInTheDocument();
    });

    it('renders caption markdown as real elements -- bold and italic text render as <strong> and <em>, not literal ** or _', () => {
      renderPanel(
        <NodeDetailPanel
          entry={tableEntry({ figureIds: ['f0'], action: 'reuse', existingAdoId: 42 })}
          jobId="job-1"
          captionByFigureId={{ f0: 'A **bold** term and _italic_ text' }}
        />,
      );
      const strong = screen.getByText('bold');
      const em = screen.getByText('italic');
      expect(strong.tagName).toBe('STRONG');
      expect(em.tagName).toBe('EM');
      // Final whole-branch review finding: a bare `!text-xs !text-ink-2` on
      // the wrapper <div> never actually overrides Markdown's own
      // `text-sm text-ink-1` classes on the rendered <p> -- !important only
      // wins between declarations on the SAME element, so the <p>'s own
      // explicit classes always apply directly to itself regardless of what
      // an ancestor declares. The real fix is `[&_p]:` arbitrary-variant
      // classes, which Tailwind necessarily compiles onto this SAME ancestor
      // <div> (compiled to `... p { ... !important }` descendant-selector
      // rules -- verified directly against the built CSS output, not
      // assumed), so asserting the class here is correct, but the class
      // names themselves now prove they target the <p>, unlike the old
      // self-referential-looking `!text-xs !text-ink-2`.
      const p = screen.getByText('italic').closest('p');
      const wrapper = p?.parentElement;
      expect(wrapper).toHaveClass('[&_p]:!text-xs');
      expect(wrapper).toHaveClass('[&_p]:!text-ink-2');
      // The <p> itself keeps Markdown's own text-sm/text-ink-1 classes in the
      // DOM (the override happens via CSS cascade, not by removing them) --
      // jsdom has no CSS engine to assert the winning size/color directly, so
      // this pins the actual DOM shape the compiled selector depends on.
      expect(p).toHaveClass('text-sm');
      expect(p).toHaveClass('text-ink-1');
    });
  });

  it('does not show an Edit button for a reuse entry, and explains why instead of rendering nothing', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText('WI-42')).toBeInTheDocument();
  });

  it('explains the read-only reason for a dedup_skip entry too', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'dedup_skip', existingAdoId: 7, customerId: null, tags: [] }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText('WI-7')).toBeInTheDocument();
  });

  // Investigation finding: fields being read-only said nothing about
  // POSITION -- a reviewer reparenting this row (drag or the "Move to..."
  // control) sees the move persist with no indication it never reaches
  // ADO. Extends the same read-only message rather than adding a second one.
  it('also explains that a matched entry\'s position in the tree is read-only in ADO, distinct from its fields', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(/its position in this tree is also read-only in ado/i)).toBeInTheDocument();
  });

  it('explains "job no longer editable" for a create entry once the job leaves diff_ready', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        jobStatus="writing"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(/no longer editable/i)).toBeInTheDocument();
    expect(screen.getByText(/writing/i)).toBeInTheDocument();
  });

  it('hides the Edit button once the job leaves diff_ready', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        jobStatus="succeeded"
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it('still shows Edit while diff_ready, and when jobStatus is omitted entirely (backward compatible)', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
        jobStatus="diff_ready"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
  });

  it('shows the scoring note and KB references for a SURVEY create entry with citations', () => {
    renderPanel(
      <NodeDetailPanel
        jobMode="survey"
        kbCitations={[
          { sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' },
          { sourceFile: 'doc-b.pdf', similarity: 0.7, relevance: 'unknown' },
        ]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [], qualityScore: 80 }}
      />,
    );
    // DESIGN.md §11.4.3 -- no standard's name (EARS/INCOSE/
    // ISO/IEC/IEEE 29148) appears anywhere in this copy, glossed or not;
    // an earlier version of this test asserted the opposite and was wrong.
    expect(screen.getByText('Scored on wording only, not engineering content.')).toBeInTheDocument();
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
    expect(screen.getByText('Unverified · doc-b.pdf')).toBeInTheDocument();
  });

  it('keeps its Sources block unless the caller says it shows provenance itself (hideSources)', () => {
    const entry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'B', action: 'create' as const, customerId: null, tags: [],
      sourceRef: { documentPath: 'spec.docx', startOffset: 0, endOffset: 5, page: 2 },
    };
    const { unmount } = renderPanel(<NodeDetailPanel jobMode="survey" entry={entry} />);
    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.getByText('spec.docx')).toBeInTheDocument();
    unmount();
    renderPanel(<NodeDetailPanel jobMode="survey" entry={entry} hideSources />);
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
    expect(screen.queryByText('spec.docx')).not.toBeInTheDocument();
  });

  it('shows the scoring note but no KB references when kbCitations is empty', () => {
    renderPanel(
      <NodeDetailPanel
        jobMode="survey"
        kbCitations={[]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [], qualityScore: 80 }}
      />,
    );
    expect(screen.getByText('Scored on wording only, not engineering content.')).toBeInTheDocument();
    expect(screen.queryByText(/KB references/i)).not.toBeInTheDocument();
  });

  it('does not claim a judgment happened for a node whose type has no scoring rubric (e.g. an Epic), regardless of qualityScore', () => {
    renderPanel(
      <NodeDetailPanel
        jobMode="survey"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic Title', description: 'Epic body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText('Scored on wording only, not engineering content.')).not.toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  it('does not show the Sources section for a BASELINE job', () => {
    renderPanel(
      <NodeDetailPanel
        jobMode="baseline"
        kbCitations={[]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText('Scored on wording only, not engineering content.')).not.toBeInTheDocument();
  });

  it('does not show the Sources section for a reuse entry, even in a SURVEY job', () => {
    renderPanel(
      <NodeDetailPanel
        jobMode="survey"
        kbCitations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText('Scored on wording only, not engineering content.')).not.toBeInTheDocument();
  });

  it('does not show the Sources section when jobMode is omitted (backward compatible with pre-existing callers)', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText('Scored on wording only, not engineering content.')).not.toBeInTheDocument();
  });

  it('shows the full trace link list for the selected node', () => {
    const entry: DryRunDiffEntry = {
      localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Sys Req', description: 'd', action: 'create', customerId: null,
      traceLinks: [
        { sourceLocalId: 'n0', referenceName: 'System.LinkTypes.Affects-Forward', displayName: 'Affects', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-099', resolutionStatus: 'unresolved' },
      ],
    };

    renderPanel(<NodeDetailPanel entry={entry} />);

    expect(screen.getByText(/Affects/i)).toBeInTheDocument();
    expect(screen.getByText(/REQ-SYS-099/i)).toBeInTheDocument();
  });

  describe('trace-link retry (Task 4)', () => {
    const entry: DryRunDiffEntry = {
      localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Sys Req', description: 'd', action: 'create', customerId: null,
      traceLinks: [
        { sourceLocalId: 'n0', referenceName: 'System.LinkTypes.Affects-Forward', displayName: 'Affects', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-099', resolutionStatus: 'unresolved' },
      ],
    };

    it('renders a retry control when a traceLinkFailures row matches this entry\'s own link', () => {
      renderPanel(
        <NodeDetailPanel
          entry={entry}
          traceLinkFailures={[{ id: 'failure-1', sourceLocalId: 'n0', sourceAdoId: 100, targetAdoId: 200, referenceName: 'System.LinkTypes.Affects-Forward' }]}
          onRetryTraceLink={vi.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: /retry writing "affects" trace link/i })).toBeInTheDocument();
    });

    it('filters traceLinkFailures down to THIS entry -- a failure row for a different sourceLocalId renders no retry control', () => {
      renderPanel(
        <NodeDetailPanel
          entry={entry}
          traceLinkFailures={[{ id: 'failure-1', sourceLocalId: 'some-other-node', sourceAdoId: 100, targetAdoId: 200, referenceName: 'System.LinkTypes.Affects-Forward' }]}
          onRetryTraceLink={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });

    it('calls onRetryTraceLink with the failure row id when the retry control is clicked, and shows a done state on success', async () => {
      const onRetryTraceLink = vi.fn().mockResolvedValue(undefined);
      renderPanel(
        <NodeDetailPanel
          entry={entry}
          traceLinkFailures={[{ id: 'failure-1', sourceLocalId: 'n0', sourceAdoId: 100, targetAdoId: 200, referenceName: 'System.LinkTypes.Affects-Forward' }]}
          onRetryTraceLink={onRetryTraceLink}
        />,
      );
      const { default: userEvent } = await import('@testing-library/user-event');

      const button = screen.getByRole('button', { name: /retry writing "affects" trace link/i });
      await userEvent.click(button);

      expect(onRetryTraceLink).toHaveBeenCalledWith('failure-1');
      await waitFor(() => expect(screen.getByRole('button', { name: /retry writing "affects" trace link/i })).toBeDisabled());
    });

    it('reverts to a clickable control (not stuck) when onRetryTraceLink rejects', async () => {
      const onRetryTraceLink = vi.fn().mockRejectedValue(new Error('write failed'));
      renderPanel(
        <NodeDetailPanel
          entry={entry}
          traceLinkFailures={[{ id: 'failure-1', sourceLocalId: 'n0', sourceAdoId: 100, targetAdoId: 200, referenceName: 'System.LinkTypes.Affects-Forward' }]}
          onRetryTraceLink={onRetryTraceLink}
        />,
      );
      const { default: userEvent } = await import('@testing-library/user-event');

      await userEvent.click(screen.getByRole('button', { name: /retry writing "affects" trace link/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /retry writing "affects" trace link/i })).toBeEnabled());
    });
  });

  it('resolves an intraJob trace link target to its real title when traceTargetTitles is supplied', () => {
    const entry: DryRunDiffEntry = {
      localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Sys Req', description: 'd', action: 'create', customerId: null,
      traceLinks: [
        { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'br0_n7', resolutionStatus: 'pending' },
      ],
    };

    renderPanel(<NodeDetailPanel entry={entry} traceTargetTitles={{ br0_n7: 'Power supply shall regulate output voltage' }} />);

    expect(screen.getByText(/Power supply shall regulate output voltage/i)).toBeInTheDocument();
    expect(screen.queryByText(/br0_n7/i)).not.toBeInTheDocument();
  });

  it('falls back to the raw internal id when no title is available for an intraJob link', () => {
    const entry: DryRunDiffEntry = {
      localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Sys Req', description: 'd', action: 'create', customerId: null,
      traceLinks: [
        { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'br0_n7', resolutionStatus: 'pending' },
      ],
    };

    renderPanel(<NodeDetailPanel entry={entry} />);

    expect(screen.getByText(/br0_n7/i)).toBeInTheDocument();
  });

  it('tells the reviewer a similar parent already exists when a create child\'s parent resolved to dedup_skip', () => {
    const child: DryRunDiffEntry = {
      localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd', action: 'create', customerId: null,
    };
    const parent: DryRunDiffEntry = {
      localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd', action: 'dedup_skip',
      existingAdoId: 4242, similarity: 0.86, customerId: null,
    };

    renderPanel(<NodeDetailPanel entry={child} parentEntry={parent} />);

    expect(screen.getByText(/similar parent item already exists/i)).toBeInTheDocument();
    expect(screen.getByText(/WI-4242/)).toBeInTheDocument();
    expect(screen.getByText(/near-duplicate/i)).toBeInTheDocument();
  });

  it('tells the reviewer a parent already exists (exact match) when the parent resolved to reuse', () => {
    const child: DryRunDiffEntry = {
      localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd', action: 'create', customerId: null,
    };
    const parent: DryRunDiffEntry = {
      localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd', action: 'reuse',
      existingAdoId: 99, similarity: null, customerId: null,
    };

    renderPanel(<NodeDetailPanel entry={child} parentEntry={parent} />);

    expect(screen.getByText(/similar parent item already exists/i)).toBeInTheDocument();
    expect(screen.getByText(/exact match/i)).toBeInTheDocument();
  });

  it('shows no parent-exists notice when the parent is itself a plain create (nothing already exists)', () => {
    const child: DryRunDiffEntry = {
      localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd', action: 'create', customerId: null,
    };
    const parent: DryRunDiffEntry = {
      localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd', action: 'create', customerId: null,
    };

    renderPanel(<NodeDetailPanel entry={child} parentEntry={parent} />);

    expect(screen.queryByText(/similar parent item already exists/i)).not.toBeInTheDocument();
  });

  it('renders a Grounding metric when groundingScore is present, marked low below 0.2', () => {
    const baseRequirementEntry: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
      action: 'create', customerId: null, tags: [],
    };
    renderPanel(
      <NodeDetailPanel
        entry={{ ...baseRequirementEntry, groundingScore: 0.14 }}
      />,
    );
    expect(screen.getByText('Loosely')).toBeInTheDocument();
    expect(screen.getByText(/matches source wording/i)).toBeInTheDocument();
    expect(screen.getByText(/worth checking against the source/i)).toBeInTheDocument();
  });

  it('omits the Grounding metric when groundingScore is null (e.g. a BASELINE node)', () => {
    const baseRequirementEntry: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
      action: 'create', customerId: null, tags: [],
    };
    renderPanel(
      <NodeDetailPanel
        entry={{ ...baseRequirementEntry, groundingScore: null }}
      />,
    );
    expect(screen.queryByText(/matches source wording/i)).not.toBeInTheDocument();
  });

  it('marks an Epic Grounding metric as low using the higher 0.35 parent threshold, not the base 0.2 threshold', () => {
    // M3: NodeDetailPanel must use the same isFlaggedDiffEntry threshold
    // logic as the diff tree/list view -- a hardcoded 0.2 here would let a
    // synthesized Epic/Feature that the diff tree flags "Needs review"
    // (under the 0.35 parent threshold) render as healthy in its own
    // detail panel.
    const epicEntry: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic Title', description: 'Epic body',
      action: 'create', customerId: null, groundingScore: 0.3,
    };
    renderPanel(<NodeDetailPanel entry={epicEntry} />);
    expect(screen.getByText('Loosely')).toBeInTheDocument();
    expect(screen.getByText(/worth checking against the source/i)).toBeInTheDocument();
  });

  it('does not mark a Requirement Grounding metric as low at the same score that would flag an Epic', () => {
    const requirementEntry: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
      action: 'create', customerId: null, groundingScore: 0.3,
    };
    renderPanel(<NodeDetailPanel entry={requirementEntry} />);
    expect(screen.getByText('Partly')).toBeInTheDocument();
    expect(screen.queryByText(/worth checking/i)).not.toBeInTheDocument();
  });

  it('states why an item needs review as visible text, not only a tooltip', () => {
    const flagged: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
      action: 'create', customerId: null, groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'low',
    };
    const { unmount } = renderPanel(<NodeDetailPanel entry={flagged} />);
    expect(screen.getByTestId('review-reason')).toHaveTextContent('Needs review: Model was unsure about this score');
    unmount();
    renderPanel(<NodeDetailPanel entry={{ ...flagged, qualityConfidence: 'high' }} />);
    expect(screen.queryByTestId('review-reason')).not.toBeInTheDocument();
  });

  it('does not mark the Grounding metric low just because qualityConfidence is low', () => {
    // NodeDetailPanel:285 intentionally nulls qualityScore when reusing
    // isFlaggedDiffEntry to compute isLowGrounding -- it wants ONLY the
    // Epic/Feature-aware grounding threshold. qualityConfidence must stay
    // out of that object literal for the same reason: a well-grounded node
    // must not render its Grounding number as low because the model was
    // unsure about the item's quality score.
    const requirementEntry: DryRunDiffEntry = {
      localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
      action: 'create', customerId: null, groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'low',
    };
    renderPanel(<NodeDetailPanel entry={requirementEntry} />);
    expect(screen.getByText('Closely')).toBeInTheDocument();
    expect(screen.queryByText(/worth checking/i)).not.toBeInTheDocument();
  });
});

describe('NodeDetailPanel figure move', () => {
  const figEntry = (patch: Partial<DryRunDiffEntry> = {}): DryRunDiffEntry => ({
    localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
    action: 'create', customerId: null, tags: [], figureIds: ['f0'], uncaptionedFigureIds: ['f5'], attachFigureIds: ['f0', 'f5'],
    ...patch,
  });
  const targets = [
    { localId: 'e1', type: 'Requirement', title: 'Req Title', customerId: null },
    { localId: 'e2', type: 'Requirement', title: 'Other item', customerId: null },
  ];

  it('shows Move to and Do not attach on an editable entry figure card', () => {
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" onMoveFigure={vi.fn()} figureMoveTargets={targets} />);
    expect(screen.getAllByRole('button', { name: /^Move to…, figure \d of \d$/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Don't attach, figure \d of \d$/ })).toHaveLength(2);
  });

  it('hides them for a written entry and for a finished job', () => {
    const { unmount } = renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" written onMoveFigure={vi.fn()} figureMoveTargets={targets} />);
    expect(screen.queryByRole('button', { name: /^Move to…, figure \d of \d$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Don't attach, figure \d of \d$/ })).not.toBeInTheDocument();
    unmount();
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="succeeded" onMoveFigure={vi.fn()} figureMoveTargets={targets} />);
    expect(screen.queryByRole('button', { name: /^Move to…, figure \d of \d$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Don't attach, figure \d of \d$/ })).not.toBeInTheDocument();
  });

  it('Do not attach calls onMoveFigure with null', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onMoveFigure = vi.fn().mockResolvedValue(undefined);
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" onMoveFigure={onMoveFigure} figureMoveTargets={targets} />);
    await userEvent.click(screen.getAllByRole('button', { name: /^Don't attach, figure \d of \d$/ })[0]);
    expect(onMoveFigure).toHaveBeenCalledWith('f0', null);
  });

  it('choosing a target calls onMoveFigure with its localId', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onMoveFigure = vi.fn().mockResolvedValue(undefined);
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" onMoveFigure={onMoveFigure} figureMoveTargets={targets} />);
    await userEvent.click(screen.getAllByRole('button', { name: /^Move to…, figure \d of \d$/ })[0]);
    expect(screen.queryByRole('button', { name: /Req Title/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Other item/ }));
    expect(onMoveFigure).toHaveBeenCalledWith('f0', 'e2');
  });

  it('shows the server message when the move fails and keeps the card', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onMoveFigure = vi.fn().mockRejectedValue(new Error('Target is already written'));
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" onMoveFigure={onMoveFigure} figureMoveTargets={targets} />);
    await userEvent.click(screen.getAllByRole('button', { name: /^Don't attach, figure \d of \d$/ })[0]);
    expect(await screen.findByText('Could not change the figure: Target is already written')).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Don't attach, figure \d of \d$/ })[0]).toBeEnabled();
  });

  it('a detached figure shows Not attached and Attach again', () => {
    renderPanel(<NodeDetailPanel entry={figEntry({ detachedFigureIds: ['f5'], attachFigureIds: ['f0'] })} jobId="job-1" jobStatus="diff_ready" onMoveFigure={vi.fn()} figureMoveTargets={targets} />);
    expect(screen.getByText('Not attached')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Attach again, figure 2 of 2$/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Don't attach, figure/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Move to…, figure/ })).toHaveLength(2);
    expect(screen.queryByText(/No description/)).not.toBeInTheDocument();
  });

  it('Attach again calls onMoveFigure with the entry own localId', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onMoveFigure = vi.fn().mockResolvedValue(undefined);
    renderPanel(<NodeDetailPanel entry={figEntry({ detachedFigureIds: ['f5'], attachFigureIds: ['f0'] })} jobId="job-1" jobStatus="diff_ready" onMoveFigure={onMoveFigure} figureMoveTargets={targets} />);
    await userEvent.click(screen.getByRole('button', { name: /^Attach again, figure 2 of 2$/ }));
    expect(onMoveFigure).toHaveBeenCalledWith('f5', 'e1');
  });

  it('reuse entries show only Move to', () => {
    renderPanel(<NodeDetailPanel entry={figEntry({ action: 'reuse', attachFigureIds: [] })} jobId="job-1" jobStatus="diff_ready" onMoveFigure={vi.fn()} figureMoveTargets={targets} />);
    expect(screen.getAllByRole('button', { name: /^Move to…, figure/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Don't attach/ })).not.toBeInTheDocument();
  });

  it('aria names include the visible text and the figure position', () => {
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" onMoveFigure={vi.fn()} figureMoveTargets={targets} />);
    expect(screen.getByRole('button', { name: 'Move to…, figure 1 of 2' })).toHaveTextContent('Move to…');
    expect(screen.getByRole('button', { name: 'Move to…, figure 2 of 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Don't attach, figure 1 of 2" })).toHaveTextContent("Don't attach");
    expect(screen.getByRole('button', { name: "Don't attach, figure 2 of 2" })).toBeInTheDocument();
  });

  it('focus moves to the Figures heading after a move', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onMoveFigure = vi.fn().mockResolvedValue(undefined);
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" onMoveFigure={onMoveFigure} figureMoveTargets={targets} />);
    await userEvent.click(screen.getByRole('button', { name: "Don't attach, figure 1 of 2" }));
    await waitFor(() => expect(screen.getByText('Figures')).toHaveFocus());
  });

  it('a detached card explains that it will not be written and shows no upload line', () => {
    renderPanel(<NodeDetailPanel entry={figEntry({ detachedFigureIds: ['f5'], attachFigureIds: ['f0'] })} jobId="job-1" jobStatus="diff_ready" onAttachFigure={vi.fn()} onMoveFigure={vi.fn()} figureMoveTargets={targets} />);
    expect(screen.getByText('This figure will not be written to Azure DevOps unless you attach it again or move it to another item.')).toBeInTheDocument();
    expect(screen.getAllByText(/You can upload this figure after the item is written/)).toHaveLength(1);
  });

  it('focus moves to the panel when the last figure leaves the item', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onMoveFigure = vi.fn().mockResolvedValue(undefined);
    const one = figEntry({ figureIds: ['f0'], uncaptionedFigureIds: [], attachFigureIds: ['f0'] });
    const view = renderPanel(<NodeDetailPanel entry={one} jobId="job-1" jobStatus="diff_ready" onMoveFigure={onMoveFigure} figureMoveTargets={targets} />);
    await userEvent.click(screen.getByRole('button', { name: "Don't attach, figure 1 of 1" }));
    view.rerender(<ToastProvider><NodeDetailPanel entry={{ ...one, figureIds: [], attachFigureIds: [] }} jobId="job-1" jobStatus="diff_ready" onMoveFigure={onMoveFigure} figureMoveTargets={targets} /></ToastProvider>);
    await waitFor(() => expect(screen.queryByText('Figures')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toHaveAttribute('data-node-detail-panel');
  });

  it('the error text differs for detach and move', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onMoveFigure = vi.fn().mockRejectedValue(new Error('Nope'));
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" onMoveFigure={onMoveFigure} figureMoveTargets={targets} />);
    await userEvent.click(screen.getByRole('button', { name: "Don't attach, figure 1 of 2" }));
    expect(await screen.findByText('Could not change the figure: Nope')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move to…, figure 2 of 2' }));
    await userEvent.click(await screen.findByRole('button', { name: /Other item/ }));
    expect(await screen.findByText('Could not move the figure: Nope')).toBeInTheDocument();
  });

  it('uses a plain fallback when the failure has no message', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    renderPanel(<NodeDetailPanel entry={figEntry()} jobId="job-1" jobStatus="diff_ready" onMoveFigure={vi.fn().mockRejectedValue({})} figureMoveTargets={targets} />);
    await userEvent.click(screen.getByRole('button', { name: "Don't attach, figure 1 of 2" }));
    expect(await screen.findByText('Could not change the figure. Please try again.')).toBeInTheDocument();
  });
});
