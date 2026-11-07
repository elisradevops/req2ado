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
//
// `activityStamp` (optional) lets another source of real progress restart the
// counter too: the live run view's progress and live frames arrive between
// narration events, and "updated 40s ago" while items are finishing would be
// false. Omitted, behaviour is exactly as before.
// When the event carries the time it happened (`at`: the server's own record for history, the receipt time for a live
// event) the count starts there, so a page opened in the middle of a long silence knows how long it has already lasted
// instead of starting again from zero. Without `at` it counts from the moment the page saw the event, as before. A time in
// the future (the server's clock ahead of this one) counts as now.
function startOf(latestNarration: unknown): number {
  const recorded = Date.parse((latestNarration as { at?: string } | null)?.at ?? '');
  return Number.isFinite(recorded) ? Math.min(recorded, Date.now()) : Date.now();
}

export function useSecondsSinceLastUpdate(latestNarration: unknown, now: number, activityStamp?: unknown): number {
  const lastUpdateAtRef = useRef<number>(startOf(latestNarration));

  useEffect(() => {
    lastUpdateAtRef.current = startOf(latestNarration);
    // Deliberately re-runs only when a NEW narration (or activity stamp)
    // actually arrives, not on every parent re-render.
  }, [latestNarration, activityStamp]);

  return Math.max(0, Math.floor((now - lastUpdateAtRef.current) / 1000));
}
