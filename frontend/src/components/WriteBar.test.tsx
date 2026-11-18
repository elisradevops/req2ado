import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WriteBar } from './WriteBar';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const renderBar = (overrides: Partial<React.ComponentProps<typeof WriteBar>> = {}) =>
  render(<WriteBar blockedCount={0} onWrite={vi.fn()} onReject={vi.fn()} busy={false} canWriteToAdo {...overrides} />);

describe('WriteBar', () => {
  it('is its own panel at the end of the review (not sticky), inset from the edges of the card above it, with a full border, rounded corners and its own shadow (DESIGN.md section 5)', () => {
    renderBar();
    const classes = screen.getByRole('region', { name: 'Review decision' }).className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(['mx-2', 'md:mx-4', 'rounded-md', 'border', 'border-hairline-strong', 'bg-surface', 'shadow-dock']),
    );
    // it used to float over the tabs and the last rows
    expect(classes).not.toContain('sticky');
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
    const write = screen.getByRole('button', { name: /write to azure devops/i });
    expect(write).toBeDisabled();
    expect(write.getAttribute('aria-describedby')).toContain(reason.id);
  });

  it('shows no such text when Azure DevOps is set up, and names the blocker count and the reason together when both apply', () => {
    const { unmount } = renderBar();
    expect(screen.queryByText(/Sign in with an Azure DevOps org URL/)).toBeNull();
    unmount();
    renderBar({ canWriteToAdo: false, blockedCount: 2 });
    const write = screen.getByRole('button', { name: /write to azure devops/i });
    const described = (write.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described).toEqual(expect.arrayContaining(['write-blocked-reason', 'write-ado-reason']));
  });
});
