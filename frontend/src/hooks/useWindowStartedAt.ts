import { useEffect, useRef } from 'react';

function readStored(storageKey: string): number | null {
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// Tracks when a given `key` last changed -- used to re-baseline an elapsed-
// time measurement at a real boundary (e.g. a phase or pass changing)
// instead of measuring from a fixed, unrelated start time. Mirrors
// useSecondsSinceLastUpdate's ref+effect pattern; distinct concern (this
// returns the boundary timestamp itself, not a live "seconds since" tick).
//
// `storageKey`, when given, persists the boundary timestamp to
// sessionStorage under that exact key -- real regression this fixes
// (confirmed live): without it, reopening the SAME running job in the
// SAME tab (the app's own "close and come back" promise) remounts this
// hook with a brand-new ref, silently re-baselining to the reload moment
// even though the window itself started minutes earlier server-side --
// producing a wildly optimistic ETA (~40s instead of ~5-6 real minutes
// left) the instant the page reloads mid-chunk. Scoped to sessionStorage,
// not localStorage -- this is this tab's view of one specific run, not a
// durable cross-session preference (same reasoning authStore already
// applies to its own sessionStorage use). Callers should compose
// `storageKey` to already embed `key` (e.g. `progress-window:${jobId}:
// ${key}`) so a genuinely different window never reads another window's
// stored start time.
//
// `prevIdentityRef` deliberately starts at `undefined` REGARDLESS of what
// `identity` already is on the first render -- not `useRef(identity)`.
// Real bug this fixes (confirmed live): the caller's narration data loads
// asynchronously, so `key`/`identity` is `undefined` on the first render
// or two and only becomes the real window key once that fetch resolves.
// Seeding `prevIdentityRef` from that first render's (still-undefined)
// identity made the LATER switch to the real key look exactly like a
// genuine window change, forcing a reset-to-now and skipping the storage
// recovery above entirely -- on every real page load, not just a race.
// Treating "no identity observed yet -> first real identity" as its own
// case (recover from storage, don't reset) fixes that unconditionally.
export function useWindowStartedAt(key: string | undefined, now: number, storageKey?: string): number {
  const identity = storageKey ?? key;
  // Synchronous recovery for the common case: storageKey is already known
  // on the very first render (no async gap), so this ref is correct
  // immediately -- no need to wait for the effect below to ever run.
  const startedAtRef = useRef<number>(storageKey ? (readStored(storageKey) ?? now) : now);
  const prevIdentityRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (identity === undefined) return;
    if (prevIdentityRef.current === undefined) {
      // First real identity this hook instance has ever seen. Handles the
      // ASYNC-gap case the synchronous read above cannot: storageKey was
      // still undefined at that first render, so recovery can only
      // happen here, once the real key is known. Idempotent/harmless in
      // the sync case -- re-reads the same value the ref already holds.
      prevIdentityRef.current = identity;
      const stored = storageKey ? readStored(storageKey) : null;
      if (stored !== null) {
        startedAtRef.current = stored;
        return;
      }
      if (storageKey) sessionStorage.setItem(storageKey, String(startedAtRef.current));
      return;
    }
    if (identity !== prevIdentityRef.current) {
      prevIdentityRef.current = identity;
      const nowMs = Date.now();
      startedAtRef.current = nowMs;
      if (storageKey) sessionStorage.setItem(storageKey, String(nowMs));
    } else if (storageKey && readStored(storageKey) === null) {
      // Same window as last render, but nothing stored yet under this
      // exact key -- persist the value this render already settled on so
      // a LATER reload of the same window has something real to recover.
      sessionStorage.setItem(storageKey, String(startedAtRef.current));
    }
    // Deliberately re-runs only when the window's identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, storageKey]);

  return startedAtRef.current;
}
