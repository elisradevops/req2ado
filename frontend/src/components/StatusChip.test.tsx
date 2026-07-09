import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusChip } from './StatusChip';

describe('StatusChip', () => {
  it.each(['pending', 'running', 'diff_ready', 'writing', 'succeeded', 'failed'])('renders a label for status %s', (status) => {
    render(<StatusChip status={status} />);
    expect(screen.getByText(new RegExp(status.replace('_', ' '), 'i'))).toBeInTheDocument();
  });
});
