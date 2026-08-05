import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from './Card';

describe('Card', () => {
  it('does not apply the hover-lift class by default', () => {
    render(<Card data-testid="card">content</Card>);
    expect(screen.getByTestId('card').className).not.toContain('hover:-translate-y-px');
  });

  it('applies the hover-lift class when interactive', () => {
    render(<Card interactive data-testid="card">content</Card>);
    const className = screen.getByTestId('card').className;
    expect(className).toContain('hover:-translate-y-px');
    expect(className).toContain('hover:shadow-raised');
    expect(className).toContain('lift');
  });
});
