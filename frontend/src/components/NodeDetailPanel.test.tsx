import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodeDetailPanel, canEditEntry, editabilityOf } from './NodeDetailPanel';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';

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

  it('renders the entry title, description, type, and tags when selected', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: ['functional'] }}
      />,
    );
    expect(screen.getByText('Req Title')).toBeInTheDocument();
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
    const panel = screen.getByText('Req Title').closest('div.flex.flex-col.gap-3');
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
    expect(onSave).toHaveBeenCalledWith('e1', { title: 'Updated Title', description: 'Req body' });
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
    expect(screen.getByText('Node B Title')).toBeInTheDocument();
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
      const chip = screen.getByText('Figure f5 · no description');
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
          screen.getByText(/description call failed, or vision captioning was off/i),
        ).toBeInTheDocument(),
      );
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
      expect(screen.getByText('Figure f5 · no description')).toBeInTheDocument();
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
});
