import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TagChips } from './TagChips';

describe('TagChips', () => {
  it('renders one chip per tag', () => {
    render(<TagChips tags={['functional', 'safety']} />);
    expect(screen.getByText('functional')).toBeInTheDocument();
    expect(screen.getByText('safety')).toBeInTheDocument();
  });
});
