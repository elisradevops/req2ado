import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ANNOUNCE_INTERVAL_MS, LiveStatusRegion } from './LiveStatusRegion';
import { FLUSH_INTERVAL_MS, useLiveRunStore } from '../../store/liveRunStore';
import type { Notice, ProgressEvent } from '../../api/liveTypes';

const progress = (seq: number, stage: ProgressEvent['stage']): ProgressEvent => ({
  type: 'progress', seq, pct: seq, stage, unit: 'items', done: seq, total: 100, estimated: true, emittedAt: 'x',
});

const push = (event: ProgressEvent): void => {
  act(() => {
    useLiveRunStore.getState().ingestProgress(event);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
  });
};

describe('LiveStatusRegion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLiveRunStore.getState().reset();
    useLiveRunStore.getState().begin('job-1');
  });
  afterEach(() => vi.useRealTimers());

  it('is a polite status region that exists, empty, from the first render', () => {
    render(<LiveStatusRegion />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('announces the step when it changes', () => {
    render(<LiveStatusRegion />);
    push(progress(1, 'improve'));
    expect(screen.getByRole('status')).toHaveTextContent('Writing titles and tags');
  });

  it('never announces counts, percentages or items as they move within a step', () => {
    render(<LiveStatusRegion />);
    push(progress(1, 'improve'));
    const before = screen.getByRole('status').textContent;
    for (let i = 2; i < 40; i++) push(progress(i, 'improve'));
    expect(screen.getByRole('status').textContent).toBe(before);
  });

  it('announces at most one change per 15 seconds and says the latest step', () => {
    render(<LiveStatusRegion />);
    push(progress(1, 'improve'));
    push(progress(2, 'summarize'));
    push(progress(3, 'score'));
    expect(screen.getByRole('status')).toHaveTextContent('Writing titles and tags');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Checking requirement wording');
  });

  it('announces a warning notice once, by its title, and not an informational one', () => {
    render(<LiveStatusRegion />);
    const send = (kind: Notice['kind'], severity: Notice['severity'], id: string, count = 1): void => {
      act(() => {
        useLiveRunStore.getState().ingestNotice({ type: 'notice', id, kind, severity, count, facts: {}, emittedAt: 'x' });
      });
    };
    send('context_assumed', 'info', 'a');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    send('output_limit_reached', 'warning', 'b');
    expect(screen.getByRole('status')).toHaveTextContent('The model reached its output limit');
    send('output_limit_reached', 'warning', 'c', 2);
    expect(screen.getByRole('status')).toHaveTextContent('The model reached its output limit');
  });
});
