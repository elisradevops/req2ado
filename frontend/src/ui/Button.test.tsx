import { describe, it, expect } from 'vitest';
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
});
