import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TagChips } from './TagChips';

describe('TagChips', () => {
  it('renders one chip per tag, humanized (not raw snake_case)', () => {
    render(<TagChips tags={['functional', 'safety']} />);
    expect(screen.getByText('Functional')).toBeInTheDocument();
    expect(screen.getByText('Safety')).toBeInTheDocument();
  });

  it('falls back to the raw tag string for an unknown tag', () => {
    render(<TagChips tags={['some_new_tag']} />);
    expect(screen.getByText('some_new_tag')).toBeInTheDocument();
  });

  it('renders nothing when tags is undefined', () => {
    const { container } = render(<TagChips tags={undefined} />);
    expect(container.querySelectorAll('span').length).toBe(0);
  });

  it('marks the winning tag distinctly and mentions the ADO write in its tooltip, leaving the others plain', () => {
    render(<TagChips tags={['functional', 'safety']} winningTag="safety" />);
    expect(screen.getByText(/Safety/).textContent).toContain('→');
    expect(screen.getByText('Functional').textContent).not.toContain('→');
  });

  it('marks no chip when winningTag is null (nothing representable in this org\'s field)', () => {
    render(<TagChips tags={['regulatory']} winningTag={null} />);
    expect(screen.getByText('Regulatory').textContent).not.toContain('→');
  });
});
