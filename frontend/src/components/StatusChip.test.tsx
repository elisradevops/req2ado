import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusChip } from './StatusChip';

describe('StatusChip', () => {
  it.each(['pending', 'running', 'diff_ready', 'writing', 'failed', 'rejected', 'cancelled'])('renders a label for status %s', (status) => {
    render(<StatusChip status={status} />);
    expect(screen.getByText(new RegExp(status.replace('_', ' '), 'i'))).toBeInTheDocument();
  });

  it('calls a written job "Written", the one word for the committed state (DESIGN.md §0 item 3), not "Succeeded"', () => {
    render(<StatusChip status="succeeded" />);
    expect(screen.getByText('Written')).toBeInTheDocument();
    expect(screen.queryByText(/succeeded/i)).not.toBeInTheDocument();
  });

  it('shows an explanatory tooltip for diff_ready on hover', async () => {
    render(<StatusChip status="diff_ready" />);
    await userEvent.hover(screen.getByText(/diff ready/i));
    await waitFor(() => expect(screen.getByText(/review the proposed work items/i)).toBeInTheDocument());
  });

  it('renders no tooltip trigger for an unknown status (empty description)', () => {
    render(<StatusChip status="some_future_status" />);
    expect(screen.getByText('some_future_status')).toBeInTheDocument();
  });

  // DESIGN.md §7, Chip / Badge: soft fill, tinted ink, no solid fill with white text. The Knowledge Base chips already follow this; the
  // Jobs list and the job header used solid fills, so one status looked different in different places.
  describe('tone', () => {
    const toneOf = (status: string, partial = false) => {
      const { container, unmount } = render(<StatusChip status={status} partial={partial} />);
      const chip = container.querySelector('span[style]') as HTMLElement;
      const tone = { bg: chip.style.backgroundColor, ink: chip.style.color };
      unmount();
      return tone;
    };

    it.each([
      ['diff_ready', 'var(--color-job-proposed-soft)', 'var(--color-job-proposed)'],
      ['succeeded', 'var(--color-job-written-soft)', 'var(--color-job-written)'],
      ['failed', 'var(--color-job-failed-soft)', 'var(--color-job-failed)'],
      ['pending', 'var(--color-surface-alt)', 'var(--color-ink-2)'],
      ['rejected', 'var(--color-surface-alt)', 'var(--color-ink-2)'],
    ])('draws %s as a soft chip with tinted ink', (status, bg, ink) => {
      expect(toneOf(status)).toEqual({ bg, ink });
    });

    it('never uses a solid fill with white text', () => {
      for (const status of ['pending', 'running', 'diff_ready', 'writing', 'succeeded', 'failed', 'rejected', 'cancelled', 'queued', 'invalid', 'submit_failed', 'deleted']) {
        expect(toneOf(status).ink).not.toBe('var(--color-white)');
      }
    });
  });

  // DESIGN.md §2 job states: proposed, written, partly written and failed each carry an icon and words, never colour alone.
  describe('job states', () => {
    it.each([
      ['diff_ready', false, 'Diff ready', 'lucide-circle-dashed'],
      ['diff_ready', true, 'Partly written', 'lucide-circle-dot-dashed'],
      ['succeeded', false, 'Written', 'lucide-circle-check'],
      ['failed', false, 'Failed', 'lucide-circle-x'],
    ])('draws %s (partial: %s) as "%s" with its own icon', (status, partial, label, icon) => {
      const { container } = render(<StatusChip status={status} partial={partial} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('class')).toContain(icon);
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });

    it('draws a partly written job in the partial colours, not the proposed ones', () => {
      const { container } = render(<StatusChip status="diff_ready" partial />);
      const chip = container.querySelector('span[style]') as HTMLElement;
      expect(chip.style.backgroundColor).toBe('var(--color-job-partial-soft)');
      expect(chip.style.color).toBe('var(--color-job-partial)');
    });

    it('keeps other statuses as they were, without an icon', () => {
      const { container } = render(<StatusChip status="running" />);
      expect(container.querySelector('svg')).toBeNull();
    });
  });
});
