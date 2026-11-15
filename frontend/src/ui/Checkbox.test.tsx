import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Checkbox } from './Checkbox';

// DESIGN.md §13: the visible box is 15 px, but the pointer target must be at least 24 x 24 CSS px (WCAG 2.5.8). jsdom has no layout, so the
// target is read from the classes that produce it: the box size plus the ::before expander inset on every side.
function hitSizeOf(className: string): number {
  const box = Number(/\bh-\[(\d+(?:\.\d+)?)px\]/.exec(className)?.[1]);
  const inset = Number(/before:-inset-\[(\d+(?:\.\d+)?)px\]/.exec(className)?.[1]);
  return box + 2 * inset;
}

describe('Checkbox', () => {
  it('keeps a pointer target of at least 24 px around the 15 px box', () => {
    render(<Checkbox checked={false} onCheckedChange={() => {}} ariaLabel="Exclude" />);
    const box = screen.getByRole('checkbox', { name: 'Exclude' });
    expect(hitSizeOf(box.className)).toBeGreaterThanOrEqual(24);
    expect(box.className).toMatch(/\bw-\[15px\]/);
    expect(box.className).toContain('before:absolute');
  });

  it('reports the new value and respects disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox checked={false} onCheckedChange={onChange} ariaLabel="Exclude" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Exclude' }));
    expect(onChange).toHaveBeenCalledWith(true);
    onChange.mockClear();
    rerender(<Checkbox checked={false} onCheckedChange={onChange} ariaLabel="Exclude" disabled />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Exclude' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
