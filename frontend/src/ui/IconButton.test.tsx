import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Download } from 'lucide-react';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('is named by its label and calls onClick', async () => {
    const onClick = vi.fn();
    render(<IconButton label="Download summary" icon={Download} onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download summary' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is 32px at desktop widths and 44px below md', () => {
    render(<IconButton label="Download summary" icon={Download} onClick={() => {}} />);
    expect(screen.getByRole('button')).toHaveClass('h-8', 'w-8', 'max-md:h-11', 'max-md:min-w-11');
  });

  it('does not call onClick while disabled or loading, and shows a spinner instead of the glyph when loading', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<IconButton label="Validate" icon={Download} onClick={onClick} disabled />);
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }));
    rerender(<IconButton label="Validate" icon={Download} onClick={onClick} loading />);
    const button = screen.getByRole('button', { name: 'Validate' });
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.querySelector('.lucide-download')).toBeNull();
    // a spinner (aria-hidden) replaces the glyph
    expect(button.querySelector('span[aria-hidden="true"].animate-spin, span[aria-hidden="true"][style*="spin"]')).not.toBeNull();
  });

  it('shows a short visible label below md only, keeping the full label as the accessible name', () => {
    render(<IconButton label="Download summary" compactLabel="Download" icon={Download} onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'Download summary' });
    expect(screen.getByText('Download')).toHaveClass('hidden', 'max-md:inline');
    expect(screen.getByText('Download')).not.toHaveClass('md:hidden');
    expect(button).toHaveClass('max-md:flex');
  });

  it('hangs the tooltip off a wrapper, so it can still show while the button is disabled', () => {
    render(<IconButton label="Resubmit" icon={Download} onClick={() => {}} disabled />);
    expect(screen.getByRole('button', { name: 'Resubmit' }).parentElement).toHaveClass('inline-flex');
  });

  // text-danger on the page background is 4.1:1 once the compact label shows (axe color-contrast); the -ink token is readable.
  it('marks a destructive action in the danger colour', () => {
    render(<IconButton label="Delete" icon={Download} tone="danger" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('text-danger-ink');
  });
});
