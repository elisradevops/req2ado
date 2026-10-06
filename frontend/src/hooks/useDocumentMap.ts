import { useEffect, useRef, useState } from 'react';
import { getRunMap } from '../api/runMap';
import type { DocumentMap } from '../api/liveTypes';

// One map per job, cached for the page's lifetime. The server publishes it only
// after it has parsed the document, which can take minutes for a figure-heavy
// file, so a 404 early in a run is not a final answer:
//  - until the live stream has shown the feature is on, keep asking with a
//    growing pause (8 s, 16 s ... up to 60 s), so a server with the feature off
//    costs almost nothing;
//  - once it has (the first progress or live event), ask again at once and then
//    every 8 s, a few times, because the map is about to exist.
const cache = new Map<string, DocumentMap>();
export const RETRY_MS = 8000;
export const MAX_PAUSE_MS = 60000;
export const MAX_ATTEMPTS_AFTER_LIVE = 6;

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
  const missesBeforeLive = useRef(0);

  useEffect(() => {
    missesBeforeLive.current = 0;
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
            if (misses >= MAX_ATTEMPTS_AFTER_LIVE) {
              setGaveUp(true);
              return;
            }
            timer = setTimeout(attempt, RETRY_MS);
          } else {
            missesBeforeLive.current += 1;
            const pause = Math.min(RETRY_MS * 2 ** (missesBeforeLive.current - 1), MAX_PAUSE_MS);
            timer = setTimeout(attempt, pause);
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
