import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeDetailPanel } from './NodeDetailPanel';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';

// P9d review gate: a generated acceptance-criteria proposal is shown apart from the description and reaches ADO only once accepted.
const CRITERIA_HTML =
  '<div data-r2a="criteria"><p><b>Proposed acceptance criteria</b></p><ul><li>Given 7 slots, when the unit boots, then all 7 are detected</li><li>Given a fault &amp; reset, then it recovers</li></ul></div>';
const NEEDS_INPUT_HTML =
  '<div data-r2a="needs-input"><p><b>Needs author input</b></p><p>Unresolved value(s) in this requirement: TBD. Acceptance criteria were not proposed.</p></div>';

const base: DryRunDiffEntry = {
  localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'The unit shall boot.', action: 'create', customerId: null,
};

function renderPanel(entry: DryRunDiffEntry, props: Partial<React.ComponentProps<typeof NodeDetailPanel>> = {}) {
  return render(
    <ToastProvider>
      <NodeDetailPanel entry={entry} jobStatus="diff_ready" {...props} />
    </ToastProvider>,
  );
}

describe('NodeDetailPanel proposal card', () => {
  it('shows nothing for an entry without a proposal', () => {
    renderPanel(base);
    expect(screen.queryByText(/proposed acceptance criteria/i)).not.toBeInTheDocument();
  });

  it('shows the criteria as text, says they are not written unless accepted, and accepts on click', async () => {
    const onSetProposalAccepted = vi.fn().mockResolvedValue(undefined);
    renderPanel({ ...base, proposal: { kind: 'criteria', html: CRITERIA_HTML } }, { onSetProposalAccepted });
    expect(screen.getByText('Proposed acceptance criteria')).toBeInTheDocument();
    expect(screen.getByText('Given 7 slots, when the unit boots, then all 7 are detected')).toBeInTheDocument();
    expect(screen.getByText('Given a fault & reset, then it recovers')).toBeInTheDocument();
    expect(screen.getByText(/not written to azure devops unless you accept/i)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /accept criteria/i }));
    expect(onSetProposalAccepted).toHaveBeenCalledWith('e1', true);
  });

  it('when accepted, says it will be written and offers Undo', async () => {
    const onSetProposalAccepted = vi.fn().mockResolvedValue(undefined);
    renderPanel({ ...base, proposal: { kind: 'criteria', html: CRITERIA_HTML }, proposalAccepted: true }, { onSetProposalAccepted });
    expect(screen.getByText(/will be written to azure devops/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept criteria/i })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /undo/i }));
    expect(onSetProposalAccepted).toHaveBeenCalledWith('e1', false);
  });

  it('shows a needs-input note as information only, with no accept button', () => {
    renderPanel({ ...base, proposal: { kind: 'needs-input', html: NEEDS_INPUT_HTML } });
    expect(screen.getByText('Needs author input')).toBeInTheDocument();
    expect(screen.getByText(/unresolved value/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();
  });

  it('offers no accept button for an entry that will not be written (reuse) or once the job left review', () => {
    const { unmount } = renderPanel({ ...base, action: 'reuse', existingAdoId: 5, proposal: { kind: 'criteria', html: CRITERIA_HTML } }, { onSetProposalAccepted: vi.fn() });
    expect(screen.queryByRole('button', { name: /accept criteria/i })).not.toBeInTheDocument();
    unmount();
    renderPanel({ ...base, proposal: { kind: 'criteria', html: CRITERIA_HTML } }, { jobStatus: 'succeeded', onSetProposalAccepted: vi.fn() });
    expect(screen.queryByRole('button', { name: /accept criteria/i })).not.toBeInTheDocument();
  });

  it('never renders the proposal markup as HTML (no injected elements)', () => {
    const evil = '<div data-r2a="criteria"><ul><li>ok</li></ul><img src=x onerror="alert(1)"><script>alert(1)</script></div>';
    const { container } = renderPanel({ ...base, proposal: { kind: 'criteria', html: evil } });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('announces the state in a status region', () => {
    renderPanel({ ...base, proposal: { kind: 'criteria', html: CRITERIA_HTML } }, { onSetProposalAccepted: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent(/not written to azure devops unless you accept/i);
  });

  it('keeps one enabled button while the request is in flight (focus is not lost) and marks it busy', async () => {
    renderPanel({ ...base, proposal: { kind: 'criteria', html: CRITERIA_HTML } }, { onSetProposalAccepted: vi.fn(() => new Promise<void>(() => {})) });
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: /accept criteria/i });
    await user.click(button);
    const after = screen.getByRole('button', { name: /accept criteria|saving/i });
    expect(after).toBe(button);
    expect(after).not.toBeDisabled();
    expect(after).toHaveAttribute('aria-busy', 'true');
  });

  it('does not carry the pending state over to the next entry', async () => {
    const onSet = vi.fn(() => new Promise<void>(() => {}));
    const first = { ...base, proposal: { kind: 'criteria' as const, html: CRITERIA_HTML } };
    const { rerender } = render(
      <ToastProvider>
        <NodeDetailPanel entry={first} jobStatus="diff_ready" onSetProposalAccepted={onSet} />
      </ToastProvider>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: /accept criteria/i }));
    rerender(
      <ToastProvider>
        <NodeDetailPanel entry={{ ...first, localId: 'e2' }} jobStatus="diff_ready" onSetProposalAccepted={onSet} />
      </ToastProvider>,
    );
    expect(screen.getByRole('button', { name: /accept criteria/i })).not.toHaveAttribute('aria-busy', 'true');
  });

  it('does not say an accepted proposal "will be written" when the item cannot be written any more', () => {
    renderPanel({ ...base, proposal: { kind: 'criteria', html: CRITERIA_HTML }, proposalAccepted: true }, { jobStatus: 'succeeded', onSetProposalAccepted: vi.fn() });
    expect(screen.queryByText(/will be written/i)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/no longer in review/i);
  });

  it('explains why a reuse entry cannot take the proposal', () => {
    renderPanel({ ...base, action: 'reuse', existingAdoId: 5, proposal: { kind: 'criteria', html: CRITERIA_HTML } }, { onSetProposalAccepted: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent(/already exists in azure devops/i);
  });

  it('cannot accept a criteria proposal it could not read any criteria from', () => {
    renderPanel({ ...base, proposal: { kind: 'criteria', html: '<div data-r2a="criteria"></div>' } }, { onSetProposalAccepted: vi.fn() });
    expect(screen.queryByRole('button', { name: /accept criteria/i })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/could not read/i);
  });

  it('keeps the Assumptions label above its own list, after the criteria (real proposal shape)', () => {
    const real =
      '<div data-r2a="criteria"><p><b>Proposed acceptance criteria</b></p><ul><li>Verify the menu shows Favorites.</li><li>Verify exactly five items are listed.</li></ul><p><i>Assumptions</i></p><ul><li>Usage history tracking is not specified.</li></ul></div>';
    renderPanel({ ...base, proposal: { kind: 'criteria', html: real } }, { onSetProposalAccepted: vi.fn() });
    const criterion = screen.getByText('Verify exactly five items are listed.');
    const label = screen.getByText('Assumptions');
    const assumption = screen.getByText('Usage history tracking is not specified.');
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(criterion, label)).toBe(true);
    expect(before(label, assumption)).toBe(true);
    expect(criterion.closest('ul')).not.toBe(assumption.closest('ul'));
  });
});

describe('NodeDetailPanel written entry', () => {
  const accepted: DryRunDiffEntry = { ...base, proposal: { kind: 'criteria', html: CRITERIA_HTML }, proposalAccepted: true };

  it('shows the written lock note instead of Accepted will be written for a written entry', () => {
    renderPanel(accepted, { written: true, onSetProposalAccepted: vi.fn(), onSave: vi.fn() });
    expect(screen.getByText('Already written to Azure DevOps by an earlier attempt, so this can no longer change.')).toBeInTheDocument();
    expect(screen.queryByText(/will be written to azure devops with this item/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo|accept criteria/i })).not.toBeInTheDocument();
  });

  it('hides Edit for a written entry', () => {
    renderPanel(base, { written: true, onSave: vi.fn() });
    expect(screen.queryByRole('button', { name: /^edit/i })).not.toBeInTheDocument();
  });

  it('unwritten entries behave as before', () => {
    renderPanel(accepted, { written: false, onSetProposalAccepted: vi.fn(), onSave: vi.fn() });
    expect(screen.getByText(/accepted — will be written to azure devops with this item/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
  });
});
