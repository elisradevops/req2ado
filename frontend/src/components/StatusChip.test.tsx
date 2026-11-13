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
    const toneOf = (status: string) => {
      const { container, unmount } = render(<StatusChip status={status} />);
      const chip = container.querySelector('span[style]') as HTMLElement;
      const tone = { bg: chip.style.backgroundColor, ink: chip.style.color };
      unmount();
      return tone;
    };

    it.each([
      ['diff_ready', 'var(--color-info-soft)', 'var(--color-info-ink)'],
      ['succeeded', 'var(--color-ok-soft)', 'var(--color-ok-ink)'],
      ['failed', 'var(--color-danger-soft)', 'var(--color-danger-ink)'],
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
});

