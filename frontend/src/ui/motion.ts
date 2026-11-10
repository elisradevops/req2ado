import { useEffect, useRef, useState, type RefObject } from 'react';

// The one place a component asks "how should this move?" (DESIGN.md section
// 8). Durations and curves are the index.css tokens, never bare numbers; the
// class strings below are written out in full so Tailwind can see them.
// Every CSS animation is already neutralised by the reduced-motion
// kill-switch in index.css, so a component never re-implements the clamp; JS
// that starts its own motion (a WAAPI call) checks the media query itself.

export const MOTION = {
  duration: {
    micro: 'var(--duration-micro)',
    instant: 'var(--duration-instant)',
    fast: 'var(--duration-fast)',
    base: 'var(--duration-base)',
    exit: 'var(--duration-exit)',
    medium: 'var(--duration-medium)',
    slow: 'var(--duration-slow)',
  },
  ease: {
    out: 'var(--ease-out)',
    in: 'var(--ease-in)',
    inOut: 'var(--ease-in-out)',
  },
  // Mirrors the tokens for the rare JS-side timing decision (a timeout that
  // must outlast an animation). Kept next to the tokens, and asserted to
  // match index.css in motion.test.tsx.
  durationMs: { micro: 50, instant: 90, fast: 140, base: 190, exit: 120, medium: 240, slow: 320 },
} as const;

// Entrance role (DESIGN.md section 8): an element that did not exist now
// exists. `backwards` holds the first frame during any delay. Opacity only:
// frequent arrivals (route, wizard step, a table's first rows) take `fade` at
// --duration-fast; a rare arrival (a finished result) takes `fadeMedium`.
export const ARRIVE = {
  fade: 'animate-[fadeIn_var(--duration-fast)_var(--ease-out)_backwards]',
  fadeMedium: 'animate-[fadeIn_var(--duration-medium)_var(--ease-out)_backwards]',
} as const;

// One brief fade-out for an event heartbeat (a halo around a status dot that fades once each time the server reports
// progress). Opacity only, so it is not "motion animation" under WCAG 2.3.3, and it plays once per event, never in a loop.
export const BEAT = 'animate-[fadeOut_var(--duration-slow)_var(--ease-out)_both]';

// A list or group owner calls useSettled() once: its ref turns true after the first commit. Each child calls
// useArrivedLate(settled.current) during its first render and keeps the answer, so only a child that mounts AFTER the
// owner settled (a new line, a newly finished step) animates in, and one that was there on first paint never does.
export function useSettled(): RefObject<boolean> {
  const settled = useRef(false);
  useEffect(() => {
    settled.current = true;
  }, []);
  return settled;
}

export function useArrivedLate(settledNow: boolean): boolean {
  const [late] = useState(settledNow);
  return late;
}

// Replays a CSS entrance on an element that stays mounted -- a route change
// reuses the same <main>, so the animation has to be restarted rather than
// triggered by a mount. Skipped on first render (the page's own load is not
// an arrival) and whenever `key` has not changed. Reduced motion needs no
// branch here: the kill-switch in index.css clamps the animation.
export function useReplayOnChange(ref: RefObject<HTMLElement | null>, key: string, animationClass: string): void {
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    const element = ref.current;
    if (!element) return;
    element.classList.remove(animationClass);
    // Reading offsetWidth flushes style so re-adding the class restarts it.
    void element.offsetWidth;
    element.classList.add(animationClass);
  }, [ref, key, animationClass]);
}

// Smooth scrolling is JavaScript motion, so the CSS kill-switch cannot reach it: ask the media query directly
// (DESIGN.md section 8.1). Falls back to smooth where there is no matchMedia.
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
