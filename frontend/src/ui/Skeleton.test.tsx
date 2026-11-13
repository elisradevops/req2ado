import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Skeleton, SKELETON_DELAY_MS, useSkeletonCrossfade } from './Skeleton';

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

  it('is a static placeholder once shown: no shimmer loop (research #7; ambient loops are not for placeholders)', () => {
    const { container } = render(<Skeleton />);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS));
    const el = container.firstElementChild as HTMLElement;
    expect(el).not.toHaveClass('invisible');
    expect(el.getAttribute('style') ?? '').not.toMatch(/animation|shimmer/);
    expect(el.className).not.toMatch(/animate-/);
  });
});

describe('useSkeletonCrossfade', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Probe({ loading }: { loading: boolean }): React.ReactElement {
    const fade = useSkeletonCrossfade(loading);
    return <span data-testid="probe" className={fade ?? ''} />;
  }

  it('fades the content in only when the placeholder was actually drawn (a load longer than the delay)', () => {
    const { rerender, getByTestId } = render(<Probe loading />);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS));
    rerender(<Probe loading={false} />);
    expect(getByTestId('probe').className).toContain('fadeIn');
  });

  it('does not fade content that arrived before the placeholder was drawn', () => {
    const { rerender, getByTestId } = render(<Probe loading />);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 1));
    rerender(<Probe loading={false} />);
    expect(getByTestId('probe').className).toBe('');
  });
});
