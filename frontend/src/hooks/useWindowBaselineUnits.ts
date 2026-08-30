import { useEffect, useRef } from 'react';

function readStored(storageKey: string): number | null {
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// Companion to useWindowStartedAt: snapshots `currentUnits` at the moment
// THIS window (identified by `identity`, matching whatever identity
// useWindowStartedAt was given for the same window) started being
// observed, and holds that snapshot fixed across later renders with the
// same identity -- even as `currentUnits` itself climbs.
//
// Real regression this closes (confirmed live, on top of
// useWindowStartedAt's own sessionStorage fix): a rate-based ETA built
// from "elapsed time I've observed" divided by "completedUnits" is only
// honest if completedUnits also only counts work I've personally watched
// happen. A tab that starts observing an ALREADY-in-flight chunk (a
// genuinely first-time page load arriving mid-chunk, or -- exactly what
// happened live -- a frontend redeploy mid-run, so the fixed bundle's
// first render of a window is mid-chunk even though sessionStorage
// correctly recovered the window's TRUE start time) still divided the
// real elapsed time by the FULL completedUnits value, including work that
// finished before this tab ever started watching -- producing a briefly,
// confidently wrong small ETA that then grows worse the longer that same
// chunk keeps running. Subtracting this baseline from completedUnits
// before computing a rate means only genuinely-witnessed progress ever
// feeds the rate; until at least one full unit of witnessed progress
// exists, the honest "Estimating time left…" fallback holds instead.
//
// `prevIdentityRef` starts at `undefined` regardless of `identity`'s
// first-render value, same reasoning as useWindowStartedAt: narration
// data loads asynchronously, so treating the switch from "not
// observed yet" to "first real identity" as its own recover-from-storage
// case (not a reset) is required unconditionally, not just for races.
export function useWindowBaselineUnits(
  identity: string | undefined,
  currentUnits: number | undefined,
  storageKey?: string,
): number | undefined {
  // Synchronous recovery for the common case: storageKey is already known
  // on the very first render (no async gap) -- see useWindowStartedAt's
  // identical comment for why this alone isn't enough for the async case.
  const baselineRef = useRef<number | undefined>(
    storageKey ? (readStored(storageKey) ?? currentUnits) : currentUnits,
  );
  const prevIdentityRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (identity === undefined) return;
    if (prevIdentityRef.current === undefined) {
      prevIdentityRef.current = identity;
      const stored = storageKey ? readStored(storageKey) : null;
      if (stored !== null) {
        baselineRef.current = stored;
        return;
      }
      // baselineRef's own initial value can be stale `undefined` -- locked
      // in by useRef on an EARLIER render where identity/currentUnits were
      // still unknown (the async-gap case this whole branch exists for).
      // currentUnits from THIS render's closure is authoritative here, not
      // whatever the ref already holds. Real bug this fixes (confirmed
      // live): checking `baselineRef.current !== undefined` here instead
      // silently skipped the write forever, since that stale ref value
      // really was `undefined` even though real data had since arrived.
      baselineRef.current = currentUnits;
      if (storageKey && currentUnits !== undefined) sessionStorage.setItem(storageKey, String(currentUnits));
      return;
    }
    if (identity !== prevIdentityRef.current) {
      prevIdentityRef.current = identity;
      baselineRef.current = currentUnits;
      if (storageKey && currentUnits !== undefined) sessionStorage.setItem(storageKey, String(currentUnits));
    } else if (storageKey && baselineRef.current !== undefined && readStored(storageKey) === null) {
      sessionStorage.setItem(storageKey, String(baselineRef.current));
    }
    // Deliberately re-runs only when the window's identity changes --
    // `currentUnits` is read from this same render's closure exactly when
    // that happens, not tracked as its own trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, storageKey]);

  return baselineRef.current;
}
