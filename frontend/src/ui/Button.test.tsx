import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('disables the button and sets pointer-events-none when disabled', () => {
    render(<Button disabled>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button.className).toContain('pointer-events-none');
  });

  it('sets aria-busy and disables the button when loading, without hiding the label', () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(button.className).toContain('pointer-events-none');
  });

  it('does not set aria-busy when not loading', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-busy');
  });

  it('applies the active:scale-[0.98] press feedback class', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('active:scale-[0.98]');
  });

  it('answers a press in 90 ms: feedback on a frequent action is fast (DESIGN.md section 8.3)', () => {
    render(<Button>Save</Button>);
    const cls = screen.getByRole('button', { name: 'Save' }).className;
    expect(cls).toMatch(/(^| )duration-instant( |$)/);
    expect(cls).not.toMatch(/(^| )duration-fast( |$)/);
  });
  it('softDisabled is aria-disabled, stays focusable and clickable, and drops the variant colour (no signal yellow)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onClick = vi.fn();
    render(<Button variant="cta" softDisabled onClick={onClick}>Write</Button>);
    const button = screen.getByRole('button', { name: 'Write' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button.className).not.toContain('pointer-events-none');
    expect(button.className).not.toContain('bg-signal');
    expect(button.className).toContain('cursor-not-allowed');
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
