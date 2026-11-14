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

  it('announces a message the page hands it, such as the arrival of a new job, and a changed one again', () => {
    const { rerender } = render(<LiveStatusRegion message="" />);
    expect(screen.getByTestId('live-status-region')).toHaveTextContent('');
    rerender(<LiveStatusRegion message="Job started. It is queued." />);
    expect(screen.getByTestId('live-status-region')).toHaveTextContent('Job started. It is queued.');
    rerender(<LiveStatusRegion message="Job is now running." />);
    expect(screen.getByTestId('live-status-region')).toHaveTextContent('Job is now running.');
    // and a message that is withdrawn takes its announcement with it
    rerender(<LiveStatusRegion message="" />);
    expect(screen.getByTestId('live-status-region')).toHaveTextContent('');
  });

  it('announces a long wait once, with fixed text that never carries the ticking time, and clears it when the wait ends', () => {
    render(<LiveStatusRegion />);
    act(() => useLiveRunStore.getState().setWaiting(true));
    const region = screen.getByTestId('live-status-region');
    expect(region).toHaveTextContent('No update for over a minute. The job is still working.');
    expect(region.textContent).not.toMatch(/\d+s/);
    act(() => useLiveRunStore.getState().setWaiting(false));
    expect(region).toHaveTextContent('');
  });

  it('forgets a wait when the store is reset for another job', () => {
    render(<LiveStatusRegion />);
    act(() => useLiveRunStore.getState().setWaiting(true));
    act(() => useLiveRunStore.getState().reset());
    expect(screen.getByTestId('live-status-region')).toHaveTextContent('');
  });

  it('says a stage has gone quiet once, at the 20 s threshold, with no ticking number, and clears it on the next event', () => {
    render(<LiveStatusRegion />);
    const region = screen.getByTestId('live-status-region');
    act(() => useLiveRunStore.getState().setStillWorkingOn('Score'));
    expect(region).toHaveTextContent('Still working on Score');
    expect(region.textContent).not.toMatch(/\d/);
    act(() => useLiveRunStore.getState().setStillWorkingOn(null));
    expect(region).toHaveTextContent('');
  });

  it('lets the one-minute wait take over from the quiet-stage line', () => {
    render(<LiveStatusRegion />);
    const region = screen.getByTestId('live-status-region');
    act(() => useLiveRunStore.getState().setStillWorkingOn('Score'));
    act(() => {
      useLiveRunStore.getState().setWaiting(true);
      useLiveRunStore.getState().setStillWorkingOn(null);
    });
    expect(region).toHaveTextContent('No update for over a minute. The job is still working.');
  });
});
