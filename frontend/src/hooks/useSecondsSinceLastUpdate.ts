import { useEffect, useRef } from 'react';

// A live "last update Ns ago" ticker -- distinct from a real stall-detection
// heuristic (which would need a judgment call about what counts as "too
// long" per phase, easy to get wrong and cry wolf). This is deliberately
// honest instead: it never claims something is stuck, it just answers "is
// this still moving" with a real, ticking number, so a quiet phase (e.g. a
// real vision-LLM call that itself takes a while) reads as "still working"
// rather than leaving the user to guess.
//
// Keyed on the latest narration's IDENTITY, not the list length: JobDetail
// caps the list at 50 (`.slice(-50)`), so once full the length never
// changes again and a length-keyed counter stopped resetting -- climbing to
// "updated 900s ago" while events were still arriving. Each live event is a
// new object, so the reference changes exactly once per real event.
export function useSecondsSinceLastUpdate(latestNarration: unknown, now: number): number {
  const lastUpdateAtRef = useRef<number>(Date.now());

  useEffect(() => {
    lastUpdateAtRef.current = Date.now();
    // Deliberately re-runs only when a NEW narration actually arrives, not
    // on every parent re-render.
  }, [latestNarration]);

  return Math.max(0, Math.floor((now - lastUpdateAtRef.current) / 1000));
}
