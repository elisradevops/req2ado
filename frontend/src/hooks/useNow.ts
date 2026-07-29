import { useEffect, useState } from 'react';

// Shared 1s clock ticker -- previously duplicated identically in
// ProgressBanner.tsx (useTickingNow) and ElapsedTimer.tsx, meaning a running
// job page could hold 2-3 unsynchronized setInterval(1000)s at once (each
// correctly cleaned up, no leak -- just visibly-different-instant ticks
// between the elapsed timer and the "last update Ns ago" counter).
export function useNow(intervalMs: number | null = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
