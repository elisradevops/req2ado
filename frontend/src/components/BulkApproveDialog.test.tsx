import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BulkApproveDialog } from './BulkApproveDialog';

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  count: 12,
  lowestScore: 61,
  highestScore: 97,
  leftOut: { flagged: 3, unscored: 0, stale: 0 },
  sampleSize: 3,
  checkedCount: 0,
  notice: '',
  onStartSpotCheck: vi.fn(),
  onShowList: vi.fn(),
  onApprove: vi.fn(),
};

describe('BulkApproveDialog', () => {
  it('states the count, the rule and the score range, and never calls the items verified', () => {
    render(<BulkApproveDialog {...BASE} />);
    const dialog = screen.getByRole('dialog', { name: 'Approve 12 clean items?' });
    expect(dialog).toHaveTextContent('not flagged');
    expect(dialog).toHaveTextContent('61 to 97');
    expect(dialog).toHaveTextContent(/nothing is written to azure devops/i);
    expect(dialog.textContent).not.toMatch(/verified|correct|safe/i);
  });

  it('says how many items are left out and why, only for the reasons that apply', () => {
    const { rerender } = render(<BulkApproveDialog {...BASE} leftOut={{ flagged: 3, unscored: 2, stale: 1 }} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('3 flagged or with warnings');
    expect(dialog).toHaveTextContent('2 not scored');
    expect(dialog).toHaveTextContent('1 with an out-of-date score');
    rerender(<BulkApproveDialog {...BASE} leftOut={{ flagged: 0, unscored: 0, stale: 0 }} />);
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/left out/i);
  });

  it('uses the singular for one item', () => {
    render(<BulkApproveDialog {...BASE} count={1} lowestScore={80} highestScore={80} sampleSize={1} />);
    expect(screen.getByRole('dialog', { name: 'Approve 1 clean item?' })).toHaveTextContent('score 80');
  });

  it('puts focus on Cancel, not on any approving action', () => {
    render(<BulkApproveDialog {...BASE} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('keeps the approve button disabled until every sampled item is checked', async () => {
    const { rerender } = render(<BulkApproveDialog {...BASE} checkedCount={2} />);
    expect(screen.getByRole('button', { name: 'Approve 12 clean items' })).toBeDisabled();
    expect(screen.getByText(/2 of 3 checked/i)).toBeInTheDocument();
    rerender(<BulkApproveDialog {...BASE} checkedCount={3} />);
    const approve = screen.getByRole('button', { name: 'Approve 12 clean items' });
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(BASE.onApprove).toHaveBeenCalledTimes(1);
  });

  it('names the spot-check button by progress and starts it', async () => {
    const { rerender } = render(<BulkApproveDialog {...BASE} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start spot-check' }));
    expect(BASE.onStartSpotCheck).toHaveBeenCalledTimes(1);
    rerender(<BulkApproveDialog {...BASE} checkedCount={1} />);
    expect(screen.getByRole('button', { name: 'Continue spot-check' })).toBeInTheDocument();
    rerender(<BulkApproveDialog {...BASE} checkedCount={3} />);
    expect(screen.queryByRole('button', { name: /spot-check/i })).not.toBeInTheDocument();
  });

  it('offers the list in the tree', async () => {
    render(<BulkApproveDialog {...BASE} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show these items in the tree' }));
    expect(BASE.onShowList).toHaveBeenCalledTimes(1);
  });

  it('shows a failure notice as an alert, so it is read even when the dialog reopens with it', () => {
    render(<BulkApproveDialog {...BASE} checkedCount={3} notice="Couldn't approve 12 clean items. Try again." />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't approve 12 clean items. Try again.");
  });

  it('ties the approve button to the spot-check progress, which says why it is disabled', () => {
    render(<BulkApproveDialog {...BASE} checkedCount={1} />);
    const approve = screen.getByRole('button', { name: 'Approve 12 clean items' });
    expect(approve).toHaveAccessibleDescription('Spot-check: 1 of 3 checked');
  });
});
