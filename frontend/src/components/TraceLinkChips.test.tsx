import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TraceLinkChips } from './TraceLinkChips';

// Base link shape reused across tests -- resolutionStatus stays 'resolved'
// throughout (the write-failure styling this file mostly tests is
// orthogonal to whether the trace link's TARGET was resolved during diff
// generation, see TraceLinkChips.tsx's own doc comment).
const LINK = {
  referenceName: 'Elisra.CoveredBy-Forward',
  displayName: 'Covers',
  targetKind: 'crossJob' as const,
  targetCustomerId: 'REQ-SYS-099',
  resolutionStatus: 'resolved' as const,
};

describe('TraceLinkChips', () => {
  it('renders nothing for an empty or undefined links list', () => {
    const { container: emptyContainer } = render(<TraceLinkChips links={[]} />);
    expect(emptyContainer.querySelectorAll('span').length).toBe(0);
    const { container: undefinedContainer } = render(<TraceLinkChips links={undefined} />);
    expect(undefinedContainer.querySelectorAll('span').length).toBe(0);
  });

  it('renders a plain (non-failed) chip with no retry control when no failure matches the link', () => {
    render(<TraceLinkChips links={[LINK]} failures={[]} onRetry={vi.fn()} />);
    const chip = screen.getByText(/REQ-SYS-099/).closest('[data-resolution-status]');
    expect(chip).not.toHaveAttribute('data-write-status');
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('renders a link distinctly (danger styling + data-write-status="failed") and a retry control when a matching failure row exists', () => {
    render(
      <TraceLinkChips
        links={[LINK]}
        failures={[{ id: 'failure-1', referenceName: 'Elisra.CoveredBy-Forward' }]}
        onRetry={vi.fn()}
      />,
    );
    const chip = screen.getByText(/REQ-SYS-099/).closest('[data-resolution-status]');
    expect(chip).toHaveAttribute('data-write-status', 'failed');
    expect(chip).toHaveStyle({ backgroundColor: 'var(--color-danger-soft)', color: 'var(--color-danger-ink)' });
    expect(screen.getByRole('button', { name: /retry writing "covers" trace link/i })).toBeInTheDocument();
  });

  it('does not match a failure whose referenceName differs from the link\'s', () => {
    render(
      <TraceLinkChips
        links={[LINK]}
        failures={[{ id: 'failure-1', referenceName: 'System.LinkTypes.Affects-Forward' }]}
        onRetry={vi.fn()}
      />,
    );
    const chip = screen.getByText(/REQ-SYS-099/).closest('[data-resolution-status]');
    expect(chip).not.toHaveAttribute('data-write-status');
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('calls onRetry with the failure row id when the retry control is clicked', async () => {
    const onRetry = vi.fn();
    render(
      <TraceLinkChips
        links={[LINK]}
        failures={[{ id: 'failure-1', referenceName: 'Elisra.CoveredBy-Forward' }]}
        onRetry={onRetry}
      />,
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /retry writing "covers" trace link/i }));
    expect(onRetry).toHaveBeenCalledWith('failure-1');
  });

  it('shows a spinning retry icon while retrying, and disables the control', () => {
    render(
      <TraceLinkChips
        links={[LINK]}
        failures={[{ id: 'failure-1', referenceName: 'Elisra.CoveredBy-Forward' }]}
        retryStatus={{ 'failure-1': 'retrying' }}
        onRetry={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: /retry writing "covers" trace link/i });
    expect(button).toBeDisabled();
  });

  it('shows a done checkmark, disables the control, and drops the failed styling once retryStatus is "done"', () => {
    render(
      <TraceLinkChips
        links={[LINK]}
        failures={[{ id: 'failure-1', referenceName: 'Elisra.CoveredBy-Forward' }]}
        retryStatus={{ 'failure-1': 'done' }}
        onRetry={vi.fn()}
      />,
    );
    const chip = screen.getByText(/REQ-SYS-099/).closest('[data-resolution-status]');
    expect(chip).toHaveAttribute('data-write-status', 'retried');
    expect(chip).not.toHaveStyle({ backgroundColor: 'var(--color-danger-soft)' });
    const button = screen.getByRole('button', { name: /retry writing "covers" trace link/i });
    expect(button).toBeDisabled();
  });

  it('renders no retry control at all when onRetry is not supplied, even with a matching failure', () => {
    render(<TraceLinkChips links={[LINK]} failures={[{ id: 'failure-1', referenceName: 'Elisra.CoveredBy-Forward' }]} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('still varies styling on resolutionStatus === "unresolved" for a link with no failure row (pre-existing behavior)', () => {
    render(<TraceLinkChips links={[{ ...LINK, resolutionStatus: 'unresolved' }]} />);
    const chip = screen.getByText(/REQ-SYS-099/).closest('[data-resolution-status]');
    expect(chip).toHaveAttribute('data-resolution-status', 'unresolved');
    expect(chip).toHaveStyle({ backgroundColor: 'var(--color-warning)' });
  });
});
