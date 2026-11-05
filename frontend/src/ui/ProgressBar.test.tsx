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
});
