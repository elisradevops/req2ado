import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WriteBar } from './WriteBar';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const renderBar = (overrides: Partial<React.ComponentProps<typeof WriteBar>> = {}) =>
  render(<WriteBar blockedCount={0} onWrite={vi.fn()} onReject={vi.fn()} busy={false} canWriteToAdo {...overrides} />);

describe('WriteBar', () => {
  it('is its own panel at the end of the review, sticky to the bottom of the screen (owner decision, 2026-11-25), inset from the edges of the card above it, with a full border, rounded corners and its own shadow (DESIGN.md section 5)', () => {
    renderBar();
    const classes = screen.getByRole('region', { name: 'Review decision' }).className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(['mx-2', 'md:mx-4', 'rounded-md', 'border', 'border-hairline-strong', 'bg-surface', 'shadow-dock']),
    );
    // in reach while the tree scrolls; above the rows it docks over, and positioned so its screen-reader text cannot stretch the page
    expect(classes).toEqual(expect.arrayContaining(['sticky', 'bottom-0', 'z-10']));
    // marked as a docked bar, so toasts rise above it (ToastProvider)
    expect(screen.getByRole('region', { name: 'Review decision' })).toHaveAttribute('data-dock');
    // the flat footer it replaced: a top border only, square corners, edge to edge with the card
    expect(classes).not.toContain('border-t');
    expect(classes).not.toContain('rounded-t-md');
    expect(classes).not.toContain('border-b-0');
  });

  it('is full width on a phone, where the page gutter already insets it', () => {
    renderBar();
    expect(screen.getByRole('region', { name: 'Review decision' }).className.split(/\s+/)).toContain('max-md:mx-0');
  });

  it('says what will be written: how many items are in and how many are left out, and where they go', () => {
    renderBar({ includedCount: 23, leftOutCount: 1, destination: 'elisradevops-project\\Customer Requirements' });
    expect(screen.getByText('23 included · 1 left out')).toBeInTheDocument();
    expect(screen.getByText('elisradevops-project\\Customer Requirements')).toBeInTheDocument();
    expect(screen.getByText(/^to\b/)).toBeInTheDocument();
  });

  it('says only the count when nothing is left out, and nothing when there is no summary to give', () => {
    const { unmount } = renderBar({ includedCount: 5, leftOutCount: 0 });
    expect(screen.getByText('5 included')).toBeInTheDocument();
    unmount();
    renderBar();
    expect(screen.queryByText(/included/)).toBeNull();
  });

  it('says how many of the items to review are reviewed, as plain text beside the summary', () => {
    renderBar({ includedCount: 14, leftOutCount: 1, reviewedCount: 4, reviewableCount: 12 });
    expect(screen.getByText('14 included · 1 left out')).toHaveTextContent('14 included · 1 left out · 4 of 12 reviewed');
    expect(screen.getByText('· 4 of 12 reviewed', { exact: false })).toBeInTheDocument();
  });

  it('says nothing about review progress when nothing is left to review', () => {
    renderBar({ includedCount: 3, reviewedCount: 0, reviewableCount: 0 });
    expect(screen.queryByText(/reviewed/)).toBeNull();
  });

  it('keeps clear of the home indicator on a phone', () => {
    renderBar();
    expect(screen.getByRole('region', { name: 'Review decision' }).className).toContain('env(safe-area-inset-bottom)');
  });

  it('defines the upward shadow token it uses', () => {
    const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
    expect(css).toMatch(/--shadow-dock:\s*[^;]*-\d+px/);
  });

  it('says in text, not only in a hover tooltip, why Write is unavailable when Azure DevOps is not set up', () => {
    renderBar({ canWriteToAdo: false });
    const reason = screen.getByText('Sign in with an Azure DevOps org URL and PAT to write');
    expect(reason).toBeVisible();
    const write = screen.getByRole('button', { name: /^Write\b.*Azure DevOps$/i });
    expect(write).toBeDisabled();
    expect(write.getAttribute('aria-describedby')).toContain(reason.id);
  });

  it('shows no such text when Azure DevOps is set up, and names the blocker count and the reason together when both apply', () => {
    const { unmount } = renderBar();
    expect(screen.queryByText(/Sign in with an Azure DevOps org URL/)).toBeNull();
    unmount();
    renderBar({ canWriteToAdo: false, blockedCount: 2 });
    const write = screen.getByRole('button', { name: 'Fix 2 items' }); // blocked: the bar names the next step
    const described = (write.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described).toEqual(expect.arrayContaining(['write-blocked-reason', 'write-ado-reason']));
  });

  it('says there is nothing left to write when no new item remains, and keeps Write available for the dialog to confirm', () => {
    const onWrite = vi.fn();
    renderBar({ nothingToWrite: true, includedCount: 0, leftOutCount: 3, onWrite });
    const note = screen.getByText('Nothing left to write: every item is excluded or already exists.');
    const write = screen.getByRole('button', { name: /^Write\b.*Azure DevOps$/i });
    expect(write).toBeEnabled();
    expect(write.getAttribute('aria-describedby')).toContain(note.id);
    write.click();
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it('does not say it while Write is blocked or Azure DevOps is not set up: that reason comes first', () => {
    const { unmount } = renderBar({ nothingToWrite: true, blockedCount: 2 });
    expect(screen.queryByText(/Nothing left to write/)).toBeNull();
    unmount();
    renderBar({ nothingToWrite: true, canWriteToAdo: false });
    expect(screen.queryByText(/Nothing left to write/)).toBeNull();
  });

  it('names the next step: "Fix N items" while blocked (not the yellow control), then the yellow "Write N items", "N of M" when some are left out', () => {
    const { rerender } = renderBar({ blockedCount: 1, includedCount: 156 });
    expect(screen.getByRole('button', { name: 'Fix 1 item' })).not.toHaveClass('bg-signal');
    expect(screen.queryByRole('button', { name: /^Write /i })).toBeNull();
    rerender(<WriteBar blockedCount={0} onWrite={vi.fn()} onReject={vi.fn()} busy={false} canWriteToAdo includedCount={156} />);
    const write = screen.getByRole('button', { name: 'Write 156 items to Azure DevOps' });
    expect(write).toHaveTextContent('Write 156 items');
    rerender(<WriteBar blockedCount={0} onWrite={vi.fn()} onReject={vi.fn()} busy={false} canWriteToAdo includedCount={155} leftOutCount={1} />);
    expect(screen.getByRole('button', { name: 'Write 155 of 156 items to Azure DevOps' })).toBeInTheDocument();
  });
});
