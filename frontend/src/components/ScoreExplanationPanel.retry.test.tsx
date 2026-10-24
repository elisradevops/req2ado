import { describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// Records every label the button is rendered with, including renders that an effect would correct before the next tick: a count left over
// from the failed try must never be painted, not even for one frame.
const labels: string[] = [];
vi.mock('../ui/Button', () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => {
    labels.push(String(Array.isArray(children) ? children.filter((c) => typeof c === 'string').join('') : children));
    return (
      <button onClick={onClick} disabled={disabled}>
        {children}
      </button>
    );
  },
}));

import { ScoreExplanationPanel } from './ScoreExplanationPanel';

describe('ScoreExplanationPanel retry', () => {
  it('never paints the count of the failed try on the next one', async () => {
    let fail: (reason: Error) => void = () => undefined;
    const load = vi
      .fn()
      .mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)))
      .mockReturnValueOnce(new Promise(() => undefined));
    render(<ScoreExplanationPanel load={load} resetKey="n0" />);
    vi.useFakeTimers(); // after the render: the polling of findBy* hangs under fake timers
    try {
      fireEvent.click(screen.getByRole('button', { name: /why this score/i }));
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(labels.at(-1)).toBe('Explaining… 5 s');
      await act(async () => fail(new Error('timeout')));
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      labels.length = 0;
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.filter((label) => /\d+ s/.test(label))).toEqual([]); // not 'Explaining… 5 s' for a frame, then 0
    } finally {
      vi.useRealTimers();
    }
  });
});
