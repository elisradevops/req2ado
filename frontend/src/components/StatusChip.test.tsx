import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusChip } from './StatusChip';

describe('StatusChip', () => {
  it.each(['pending', 'running', 'diff_ready', 'writing', 'succeeded', 'failed', 'rejected', 'cancelled'])('renders a label for status %s', (status) => {
    render(<StatusChip status={status} />);
    expect(screen.getByText(new RegExp(status.replace('_', ' '), 'i'))).toBeInTheDocument();
  });

  it('shows an explanatory tooltip for diff_ready on hover', async () => {
    render(<StatusChip status="diff_ready" />);
    await userEvent.hover(screen.getByText(/diff ready/i));
    await waitFor(() => expect(screen.getByText(/review the proposed work items/i)).toBeInTheDocument());
  });

  it('renders no tooltip trigger for an unknown status (empty description)', () => {
    render(<StatusChip status="some_future_status" />);
    expect(screen.getByText('some_future_status')).toBeInTheDocument();
  });
});
