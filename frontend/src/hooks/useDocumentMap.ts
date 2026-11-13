import { useEffect, useState } from 'react';
import { getRunMap } from '../api/runMap';
import type { DocumentMap } from '../api/liveTypes';

// One map per job, cached for the page's lifetime. The server publishes it only
// after it has parsed the document, which can take minutes for a figure-heavy
// file, so a 404 early in a run is not a final answer:
//  - until the live stream has shown the feature is on, ask exactly once (a
//    server with the feature off answers 404 every time, so asking again only
//    fills the console and the access log);
//  - once it has (the first progress or live event), ask again at once and then
//    keep asking, with growing gaps (8 s, then 15 s, then 30 s), until the run
//    ends: a figure-heavy document can still be parsing for many minutes, and a
//    fixed number of tries ran out before the map existed.
const cache = new Map<string, DocumentMap>();
export const RETRY_MS = 8000;
export const MAX_RETRY_MS = 30000;

/** The wait before the next ask, after `misses` misses in a row: 8 s for the first three, then 15 s twice, then 30 s. */
export function retryDelay(misses: number): number {
  if (misses <= 3) return RETRY_MS;
  if (misses <= 5) return 15000;
  return MAX_RETRY_MS;
}

/**
 * 'loading' lasts for the whole run once the live stream has shown the feature is on and no map exists yet (and, with a request
 * that keeps failing, for the whole run too: failures are retried like misses). A consumer must not show a spinner for it.
 */
export type DocumentMapState = 'loading' | 'ready' | 'off';

export function useDocumentMap(
  jobId: string | undefined,
  // True once the live stream has shown the feature is on for this run.
  liveSeen: boolean,
  // False once the run has finished: stop asking.
  running: boolean,
): { map: DocumentMap | null; state: DocumentMapState } {
  const [map, setMap] = useState<DocumentMap | null>(jobId ? (cache.get(jobId) ?? null) : null);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    setGaveUp(false);
    setMap(jobId ? (cache.get(jobId) ?? null) : null);
  }, [jobId]);

  useEffect(() => {
    if (!jobId || map || !running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0; // misses since this effect started (restarts when liveSeen flips)

    const attempt = (): void => {
      getRunMap(jobId)
        .then((result) => (cancelled ? undefined : result), () => null)
        .then((result) => {
          if (cancelled || result === undefined) return;
          if (result) {
            cache.set(jobId, result);
            setMap(result);
            return;
          }
          misses += 1;
          if (liveSeen) {
            timer = setTimeout(attempt, retryDelay(misses));
          } else {
            // The one early ask missed; the effect restarts when the live stream shows the feature.
            setGaveUp(true);
          }
        });
    };
    setGaveUp(false);
    attempt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, map, running, liveSeen]);

  const state: DocumentMapState = map ? 'ready' : gaveUp || !running ? 'off' : 'loading';
  return { map, state };
}

/** Test seam: forget cached maps. */
export function clearDocumentMapCache(): void {
  cache.clear();
}
