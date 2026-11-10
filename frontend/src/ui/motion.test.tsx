import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderHook } from '@testing-library/react';
import { ARRIVE, BEAT, MOTION, scrollBehavior, useArrivedLate, useReplayOnChange, useSettled } from './motion';

afterEach(() => vi.restoreAllMocks());

describe('motion tokens', () => {
  it('only references design tokens, never bare durations or curves (DESIGN.md section 8)', () => {
    const everything = [...Object.values(MOTION.duration), ...Object.values(MOTION.ease), ...Object.values(ARRIVE)].join(' ');
    expect(everything).not.toMatch(/\d+ms/);
    expect(everything).not.toMatch(/cubic-bezier/);
  });

  it('has an exit that is shorter than its entrance', () => {
    expect(MOTION.durationMs.exit).toBeLessThan(MOTION.durationMs.base);
  });
});

describe('motion tokens mirror index.css', () => {
  const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
  it.each(Object.entries(MOTION.durationMs))('--duration-%s is %ims', (name, ms) => {
    expect(css).toMatch(new RegExp(`--duration-${name}:\\s*${ms}ms`));
  });
});


describe('useReplayOnChange', () => {
  it('leaves the first render alone and restarts the animation when the key changes', () => {
    const element = document.createElement('main');
    const ref = { current: element };
    const { rerender } = renderHook(({ route }) => useReplayOnChange(ref, route, 'enter'), { initialProps: { route: '/jobs' } });
    expect(element.classList.contains('enter')).toBe(false);

    rerender({ route: '/jobs' });
    expect(element.classList.contains('enter')).toBe(false);

    rerender({ route: '/help' });
    expect(element.classList.contains('enter')).toBe(true);
  });

  it('restarts a class that is already present instead of leaving it running', () => {
    const element = document.createElement('main');
    element.classList.add('enter');
    const remove = vi.spyOn(element.classList, 'remove');
    const ref = { current: element };
    const { rerender } = renderHook(({ route }) => useReplayOnChange(ref, route, 'enter'), { initialProps: { route: '/a' } });
    rerender({ route: '/b' });
    expect(remove).toHaveBeenCalledWith('enter');
    expect(element.classList.contains('enter')).toBe(true);
  });

  it('does nothing when there is no element yet', () => {
    const ref = { current: null };
    const { rerender } = renderHook(({ route }) => useReplayOnChange(ref, route, 'enter'), { initialProps: { route: '/a' } });
    expect(() => rerender({ route: '/b' })).not.toThrow();
  });
});


describe('ARRIVE', () => {
  it('uses the fast token for frequent arrivals and the medium token for a rare one', () => {
    expect(ARRIVE.fade).toContain('var(--duration-fast)');
    expect(ARRIVE.fadeMedium).toContain('var(--duration-medium)');
  });
});

describe('scrollBehavior', () => {
  const stub = (matches: boolean) =>
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);

  it('is smooth by default and instant when the person asks for reduced motion', () => {
    stub(false);
    expect(scrollBehavior()).toBe('smooth');
    vi.restoreAllMocks();
    stub(true);
    expect(scrollBehavior()).toBe('auto');
  });

  it('falls back to smooth where matchMedia does not exist', () => {
    const original = window.matchMedia;
    // @ts-expect-error simulate an environment without matchMedia
    window.matchMedia = undefined;
    expect(scrollBehavior()).toBe('smooth');
    window.matchMedia = original;
  });
});

describe('BEAT', () => {
  it('is an opacity-only fade out, so a pulse never counts as motion (WCAG 2.3.3) and never loops (2.2.2)', () => {
    expect(BEAT).toContain('fadeOut');
    expect(BEAT).toContain('var(--duration-slow)');
    expect(BEAT).not.toContain('infinite');
  });
});

describe('useSettled / useArrivedLate', () => {
  it('turns true after the first commit', () => {
    const { result } = renderHook(() => useSettled());
    expect(result.current.current).toBe(true);
  });

  it('is false for what was there on first render and true for what mounts afterwards, and keeps its answer', () => {
    const early = renderHook(() => useArrivedLate(false));
    const late = renderHook(() => useArrivedLate(true));
    expect(early.result.current).toBe(false);
    expect(late.result.current).toBe(true);
    // the owner settling later must not flip an early child into an arrival
    early.rerender();
    expect(early.result.current).toBe(false);
  });
});
