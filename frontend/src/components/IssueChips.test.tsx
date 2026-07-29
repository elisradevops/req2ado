import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssueChips } from './IssueChips';

describe('IssueChips', () => {
  it('renders one chip per issue', () => {
    render(<IssueChips issues={['vague_term', 'not_testable']} />);
    expect(screen.getByText(/Vague term/i)).toBeInTheDocument();
    expect(screen.getByText(/Not testable/i)).toBeInTheDocument();
  });

  it('renders nothing when issues is undefined', () => {
    const { container } = render(<IssueChips issues={undefined} />);
    expect(container.querySelectorAll('span').length).toBe(0);
  });

  it('renders nothing when issues is an empty array', () => {
    const { container } = render(<IssueChips issues={[]} />);
    expect(container.querySelectorAll('span').length).toBe(0);
  });
});
