import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatTile } from './StatTile';

// DESIGN.md section 8.3: a stat tile shows its number at once. Research found no support for a first-paint count-up in a
// professional tool (the wrong number is on screen for most of a second on every visit), so there is no motion here.
describe('StatTile', () => {
  it('renders its value as plain text in the first frame', () => {
    render(<StatTile value={50} label="Awaiting review" />);
    const value = screen.getByText('50');
    expect(value.tagName).toBe('P');
    expect(value.closest('[role="img"]')).toBeNull();
  });

  it('carries no animation class', () => {
    const { container } = render(<StatTile value={50} label="Awaiting review" />);
    expect(container.innerHTML).not.toMatch(/animate-|number-flow/);
  });

  it('lifts on hover only when it is made interactive', () => {
    const { container, rerender } = render(<StatTile value={1} label="Files" />);
    expect(container.firstElementChild).not.toHaveClass('liftable');
    rerender(<StatTile value={1} label="Files" interactive />);
    expect(container.firstElementChild).toHaveClass('liftable');
  });
});
