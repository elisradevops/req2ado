import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodeDetailPanel } from './NodeDetailPanel';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';
import * as chatApi from '../api/chat';

// NodeDetailPanel now renders ChatPanel (Task 11) whenever entry is non-null,
// which calls useToast() unconditionally and hits the chat API/WS on mount.
// Mock both so these pre-existing tests stay focused on NodeDetailPanel's own
// title/description/tags/quality-score/Edit behavior.
vi.mock('../api/chat');
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

function renderPanel(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('NodeDetailPanel', () => {
  beforeEach(() => {
    // Clear accumulated mock call history/implementations between tests --
    // previously absent, meaning e.g. sendChatTurn's call count carried
    // over across `it()` blocks. Only surfaced once a test asserted an
    // ABSOLUTE call count (see "does not fire a second sendChatTurn call");
    // clearing here is the correct general fix, not a one-off workaround.
    vi.clearAllMocks();
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue([]);
  });

  it('renders a placeholder when nothing is selected', () => {
    renderPanel(<NodeDetailPanel jobId="job-1" entry={null} />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it('renders the entry title, description, type, and tags when selected', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: ['functional'] }}
      />,
    );
    expect(screen.getByText('Req Title')).toBeInTheDocument();
    expect(screen.getByText('Req body')).toBeInTheDocument();
    expect(screen.getByText('functional')).toBeInTheDocument();
  });

  it('renders the quality score and issue chips when present', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        entry={{
          localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body',
          action: 'create', customerId: null, tags: [], qualityScore: 72, qualityIssues: ['vague_term'],
        }}
      />,
    );
    expect(screen.getByText(/72\s*\/\s*100/)).toBeInTheDocument();
    expect(screen.getByText('vague_term')).toBeInTheDocument();
  });

  it('renders no score line when qualityScore is absent', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
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
        jobId="job-1"
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
        jobId="job-1"
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

    const { rerender } = renderPanel(<NodeDetailPanel jobId="job-1" entry={nodeA} onSave={vi.fn()} />);

    // Start editing node A and dirty the draft without saving/cancelling.
    await user.click(screen.getByRole('button', { name: /edit/i }));
    const titleField = screen.getByDisplayValue('Node A Title');
    await user.clear(titleField);
    await user.type(titleField, 'Stale unsaved draft');

    // Select a different node (JobDetail.tsx passes a new entry prop into this
    // still-mounted component) without the user clicking Save or Cancel first.
    rerender(
      <ToastProvider>
        <NodeDetailPanel jobId="job-1" entry={nodeB} onSave={vi.fn()} />
      </ToastProvider>,
    );

    // Edit mode must be exited: no leftover draft textfield for A's stale text,
    // and node B's data is shown read-only with a fresh Edit button available.
    expect(screen.queryByDisplayValue('Stale unsaved draft')).not.toBeInTheDocument();
    expect(screen.getByText('Node B Title')).toBeInTheDocument();
    expect(screen.getByText('Node B body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });

  it('does not show an Edit button for a reuse entry', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('shows the standards line and KB references for a SURVEY create entry with citations', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        jobMode="survey"
        kbCitations={[
          { sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' },
          { sourceFile: 'doc-b.pdf', similarity: 0.7, relevance: 'unknown' },
        ]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.getByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).toBeInTheDocument();
    expect(screen.getByText('doc-a.docx')).toBeInTheDocument();
    expect(screen.getByText('doc-b.pdf')).toBeInTheDocument();
  });

  it('shows the standards line but no KB references line when kbCitations is empty', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        jobMode="survey"
        kbCitations={[]}
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.getByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).toBeInTheDocument();
    expect(screen.queryByText(/KB references/i)).not.toBeInTheDocument();
  });

  it('does not show the Sources section for a BASELINE job', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
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
        jobId="job-1"
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
        jobId="job-1"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByText(/EARS, INCOSE, ISO\/IEC\/IEEE 29148/)).not.toBeInTheDocument();
  });

  it('shows a "Suggest a title" button for a create entry and sends a fixed prompt via chat when clicked, for a BASELINE job', async () => {
    // Correction to a prior report claim: ChatPanel (and the chat backend)
    // have no SURVEY-only gate -- the propose/accept mechanism already runs
    // for BASELINE nodes today. This proves the new button isn't
    // accidentally mode-gated: no jobMode prop is passed at all here.
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    vi.mocked(chatApi.sendChatTurn).mockResolvedValue(undefined);

    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /suggest a title/i }));

    expect(chatApi.sendChatTurn).toHaveBeenCalledWith(
      'job-1',
      'e1',
      expect.stringMatching(/title/i),
    );
  });

  it('shows an error toast and re-enables the button when sendChatTurn rejects', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    vi.mocked(chatApi.sendChatTurn).mockRejectedValue(new Error('network down'));

    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    const button = screen.getByRole('button', { name: /suggest a title/i });
    await user.click(button);

    await waitFor(() => expect(screen.getByText(/failed to request a title suggestion/i)).toBeInTheDocument());
    expect(button).not.toBeDisabled();
  });

  it('does not fire a second sendChatTurn call while the first request is still in flight', async () => {
    // Uses fireEvent (not userEvent) deliberately: userEvent correctly
    // refuses to click a button once React has committed disabled=true
    // (confirming the UI-level guard works), but the useRef guard exists
    // specifically for the narrower case userEvent can't simulate --
    // several synchronous clicks landing BEFORE the first re-render, where
    // a useState-only guard would still read its stale `false` closure
    // value and let every click through. fireEvent dispatches directly,
    // bypassing the pointer-events/disabled check, to exercise exactly that.
    const { fireEvent } = await import('@testing-library/react');
    let resolveTurn: () => void = () => {};
    vi.mocked(chatApi.sendChatTurn).mockImplementation(
      () => new Promise((resolve) => { resolveTurn = () => resolve(undefined); }),
    );

    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'create', customerId: null, tags: [] }}
      />,
    );
    const button = screen.getByRole('button', { name: /suggest a title/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(chatApi.sendChatTurn).toHaveBeenCalledTimes(1);
    resolveTurn();
  });

  it('does not show a "Suggest a title" button for a reuse entry', () => {
    renderPanel(
      <NodeDetailPanel
        jobId="job-1"
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'reuse', existingAdoId: 42, customerId: null, tags: [] }}
      />,
    );
    expect(screen.queryByRole('button', { name: /suggest a title/i })).not.toBeInTheDocument();
  });

  it('shows the full trace link list for the selected node', () => {
    const entry: DryRunDiffEntry = {
      localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Sys Req', description: 'd', action: 'create', customerId: null,
      traceLinks: [
        { sourceLocalId: 'n0', referenceName: 'System.LinkTypes.Affects-Forward', displayName: 'Affects', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-099', resolutionStatus: 'unresolved' },
      ],
    };

    renderPanel(<NodeDetailPanel jobId="job-1" entry={entry} />);

    expect(screen.getByText(/Affects/i)).toBeInTheDocument();
    expect(screen.getByText(/REQ-SYS-099/i)).toBeInTheDocument();
  });
});
