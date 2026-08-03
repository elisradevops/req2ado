import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
          action: 'create', customerId: null, tags: [], qualityScore: 72, qualityIssues: ['vague_term'],
        }}
      />,
    );
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText(/Vague term/i)).toBeInTheDocument();
  });

  it('renders no score line when qualityScore is absent', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/\/\s*100/)).not.toBeInTheDocument();
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
    expect(screen.getByText('spec.docx · p. 3 · chars 100–200')).toBeInTheDocument();
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
    expect(screen.queryByText(/chars \d/)).not.toBeInTheDocument();
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

  it('shows the standards line and KB references for a SURVEY create entry with citations', () => {
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
    // Mentions the knowledge base by name when it actually contributed --
    // "Judged against EARS/INCOSE/ISO" alone would be misleading here.
    expect(screen.getByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148, and your knowledge base/)).toBeInTheDocument();
    expect(screen.getByText('doc-a.docx')).toBeInTheDocument();
    expect(screen.getByText('doc-b.pdf')).toBeInTheDocument();
  });

  it('shows the standards line but no KB references line when kbCitations is empty', () => {
    renderPanel(
      <NodeDetailPanel
        jobMode="survey"
        kbCitations={[]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [], qualityScore: 80 }}
      />,
    );
    expect(screen.getByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).toBeInTheDocument();
    expect(screen.queryByText(/, and your knowledge base/)).not.toBeInTheDocument();
    expect(screen.queryByText(/KB references/i)).not.toBeInTheDocument();
  });

  it('does not claim a judgment happened for a node that was never scored (e.g. an Epic with no qualityScore set)', () => {
    renderPanel(
      <NodeDetailPanel
        jobMode="survey"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic Title', description: 'Epic body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/Judged against/)).not.toBeInTheDocument();
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
    expect(screen.queryByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).not.toBeInTheDocument();
  });

  it('does not show the Sources section for a reuse entry, even in a SURVEY job', () => {
    renderPanel(
      <NodeDetailPanel
        jobMode="survey"
        kbCitations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).not.toBeInTheDocument();
  });

  it('does not show the Sources section when jobMode is omitted (backward compatible with pre-existing callers)', () => {
    renderPanel(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).not.toBeInTheDocument();
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
