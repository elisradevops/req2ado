import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { BEAT } from '../ui/motion';
import { BEAT_MIN_GAP_MS, LivenessDot } from './LivenessDot';

// DESIGN.md section 8.3: the job's live dot beats once, as an opacity-only halo, each time the server really reports
// progress, instead of pinging forever. It turns amber, in text-free colour, when nothing has arrived for a while.
describe('LivenessDot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const halo = (container: HTMLElement) => container.querySelector('[aria-hidden="true"]') as HTMLElement;
  const beatClass = BEAT;

  it('does not beat on first render, and never loops', () => {
    const { container } = render(<LivenessDot beatKey="a" waiting={false} />);
    expect(halo(container).className).not.toContain(beatClass);
    expect(container.innerHTML).not.toMatch(/animate-ping|infinite/);
  });

  it('beats once for each new event', () => {
    const { container, rerender } = render(<LivenessDot beatKey="a" waiting={false} />);
    rerender(<LivenessDot beatKey="b" waiting={false} />);
    expect(halo(container).className).toContain(beatClass);
  });

  it('holds back events that arrive closer together than the minimum gap, so beats never chain into a long motion', () => {
    const { container, rerender } = render(<LivenessDot beatKey="a" waiting={false} />);
    rerender(<LivenessDot beatKey="b" waiting={false} />);
    const remove = vi.spyOn(halo(container).classList, 'remove');
    vi.setSystemTime(Date.now() + BEAT_MIN_GAP_MS - 1);
    rerender(<LivenessDot beatKey="c" waiting={false} />);
    expect(remove).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 2);
    rerender(<LivenessDot beatKey="d" waiting={false} />);
    expect(remove).toHaveBeenCalledWith(beatClass);
  });

  it('is a solid dot while updates arrive and a hollow ring while waiting: a quiet wait is normal, so it is never warning-coloured', () => {
    const { container, rerender } = render(<LivenessDot beatKey="a" waiting={false} />);
    expect(container.firstElementChild).toHaveAttribute('data-liveness', 'live');
    expect(container.innerHTML).toContain('bg-live');
    rerender(<LivenessDot beatKey="a" waiting />);
    expect(container.firstElementChild).toHaveAttribute('data-liveness', 'waiting');
    expect(container.innerHTML).toContain('border-live');
    expect(container.innerHTML).not.toMatch(/warning|danger/);
  });
});
