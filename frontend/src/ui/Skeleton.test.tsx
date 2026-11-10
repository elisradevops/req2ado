import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Skeleton, SKELETON_DELAY_MS } from './Skeleton';

// DESIGN.md section 8.3: under about a second a loading placeholder only flashes (Primer loading pattern, NN/g skeleton screens),
// so the placeholder is laid out at once, to keep the page from jumping, but only drawn after the delay.
describe('Skeleton', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('waits one second before it shows', () => {
    expect(SKELETON_DELAY_MS).toBe(1000);
    const { container } = render(<Skeleton className="h-9 w-full" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveClass('invisible'); // takes its space, draws nothing
    expect(el).toHaveClass('h-9');

    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 1));
    expect(el).toHaveClass('invisible');

    act(() => vi.advanceTimersByTime(1));
    expect(el).not.toHaveClass('invisible');
  });

  it('never shows if the content arrives first, and clears its timer when it unmounts', () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = render(<Skeleton />);
    unmount();
    expect(clear).toHaveBeenCalled();
    expect(() => vi.advanceTimersByTime(SKELETON_DELAY_MS * 2)).not.toThrow();
  });

  it('does not run the shimmer while it is hidden: nothing animates unseen', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild!.getAttribute('style') ?? '').not.toContain('shimmer');
  });

  it('keeps the shimmer on the placeholder once shown', () => {
    const { container } = render(<Skeleton />);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS));
    expect((container.firstElementChild as HTMLElement).getAttribute('style')).toContain('shimmer');
  });
});
