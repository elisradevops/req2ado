import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from './Card';

describe('Card', () => {
  it('does not apply the hover-lift class by default', () => {
    render(<Card data-testid="card">content</Card>);
    expect(screen.getByTestId('card').className).not.toContain('liftable');
  });

  it('applies the hover-lift class when interactive', () => {
    // DESIGN.md §6 -- the hover/lift/shadow values now live in index.css's
    // `.liftable` (@layer components), not as spelled-out Tailwind utilities
    // on the element itself, so this only asserts the class hook is present.
    render(<Card interactive data-testid="card">content</Card>);
    expect(screen.getByTestId('card').className).toContain('liftable');
  });
});
