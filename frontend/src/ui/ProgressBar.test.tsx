import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('exposes its label as the accessible name', () => {
    render(<ProgressBar value={40} label="Upload progress" />);
    expect(screen.getByRole('progressbar', { name: 'Upload progress' })).toHaveAttribute('aria-valuenow', '40');
  });

  it('clamps the value and passes valuetext through', () => {
    render(<ProgressBar value={140} label="Upload progress" valueText="Almost done" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar).toHaveAttribute('aria-valuetext', 'Almost done');
  });

  it('has no valuenow when indeterminate, and still has a name', () => {
    render(<ProgressBar label="Upload progress" />);
    const bar = screen.getByRole('progressbar', { name: 'Upload progress' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
  });

  it('fills with a scale transform, not a width, so a progress tick never relays out the page', () => {
    render(<ProgressBar value={38} label="Run" />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.style.transform).toBe('scaleX(0.38)');
    expect(fill.style.width).toBe('');
    expect(fill.className).toContain('origin-left');
  });

  it('fills from the right in right-to-left layouts', () => {
    render(<ProgressBar value={50} label="Run" />);
    expect(screen.getByRole('progressbar').firstElementChild?.className).toContain('rtl:origin-right');
  });

  it('eases a forward jump with the progress token, and ease-out so the update shows at once', () => {
    const { rerender } = render(<ProgressBar value={20} label="Run" />);
    rerender(<ProgressBar value={60} label="Run" />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.style.transition).toContain('var(--duration-progress)');
    expect(fill.style.transition).toContain('var(--ease-out)');
  });

  it('snaps a change under one percent and never animates backwards', () => {
    const { rerender } = render(<ProgressBar value={50} label="Run" />);
    const fill = () => screen.getByRole('progressbar').firstElementChild as HTMLElement;
    rerender(<ProgressBar value={50.4} label="Run" />);
    expect(fill().style.transition).toBe('none');
    rerender(<ProgressBar value={30} label="Run" />);
    expect(fill().style.transition).toBe('none');
    expect(fill().style.transform).toBe('scaleX(0.3)');
  });

  it('draws no looping sheen: a bar that is legitimately idle stays still (WCAG 2.2.2)', () => {
    const { container } = render(<ProgressBar value={38} label="Run" />);
    expect(container.querySelector('[data-testid="progress-active"]')).toBeNull();
    expect(container.innerHTML).not.toContain('shimmer');
  });

  it('keeps the indeterminate bar as a travelling segment', () => {
    render(<ProgressBar label="Run" />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.style.animation).toContain('indeterminate-progress');
    expect(fill.style.width).toBe('34%');
  });
});
