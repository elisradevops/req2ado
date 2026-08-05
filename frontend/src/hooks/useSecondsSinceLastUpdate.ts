import { useEffect, useRef } from 'react';

// A live "last update Ns ago" ticker -- distinct from a real stall-detection
// heuristic (which would need a judgment call about what counts as "too
// long" per phase, easy to get wrong and cry wolf). This is deliberately
// honest instead: it never claims something is stuck, it just answers "is
// this still moving" with a real, ticking number, so a quiet phase (e.g. a
// real vision-LLM call that itself takes a while) reads as "still working"
// rather than leaving the user to guess.
export function useSecondsSinceLastUpdate(narrationCount: number, now: number): number {
  const lastUpdateAtRef = useRef<number>(Date.now());

  useEffect(() => {
    lastUpdateAtRef.current = Date.now();
    // Deliberately re-runs only when a NEW narration actually arrives
    // (count changes), not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrationCount]);

  return Math.max(0, Math.floor((now - lastUpdateAtRef.current) / 1000));
}
