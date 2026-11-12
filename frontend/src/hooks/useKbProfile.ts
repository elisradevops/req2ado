import { useCallback, useEffect, useRef, useState } from 'react';
import { getKbProfile, type KbProfile } from '../api/kb';

// Reads the grading rubric the knowledge base builds, and keeps asking while it is still being built. The rubric is built in the
// background some time after a file is added (a short wait, then a model reads every document), so "ready" is not the first answer.
// `since` is when the batch finished: a rubric built before then does not include its files yet, so it is not the answer either.

export const KB_PROFILE_POLL_MS = 5_000;
// A build that has not appeared after this long is not going to by waiting: stop asking and say so.
export const KB_PROFILE_GIVE_UP_MS = 10 * 60_000;

export type KbProfileReadStatus =
  | 'idle'
  // Asking, for the first time.
  | 'loading'
  // Queued, building, or not yet built since `since`: asking again soon.
  | 'waiting'
  | 'ready'
  // No rubric, and none coming (nothing in the knowledge base yet).
  | 'none'
  // No model connection to build it with: the first job builds it, with its own.
  | 'no_model'
  // Gave up waiting.
  | 'timeout'
  // The last read failed; asking again.
  | 'error';

export interface KbProfileRead {
  status: KbProfileReadStatus;
  profile: KbProfile | null;
  refresh: () => Promise<void>;
}

export function useKbProfile({ enabled, since = null }: { enabled: boolean; since?: string | null }): KbProfileRead {
  const [status, setStatus] = useState<KbProfileReadStatus>('idle');
  const [profile, setProfile] = useState<KbProfile | null>(null);
  const sinceRef = useRef(since);
  sinceRef.current = since;
  // Bumped whenever the reading starts over or stops, so the answer to an old request is recognised and dropped.
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startedAt = useRef(0);
  const hasProfile = useRef(false);

  const read = useCallback(async (): Promise<KbProfileReadStatus> => {
    const mine = generation.current;
    try {
      const next = await getKbProfile();
      if (mine !== generation.current) return 'idle';
      setProfile(next);
      hasProfile.current = true;
      const cutoff = sinceRef.current;
      const stale = cutoff !== null && next.state === 'ready' && (next.builtAt === null || Date.parse(next.builtAt) < Date.parse(cutoff));
      const outcome: KbProfileReadStatus = next.state === 'none' || next.state === 'no_model' ? next.state : next.state === 'ready' && !stale ? 'ready' : 'waiting';
      setStatus(outcome);
      return outcome;
    } catch {
      if (mine !== generation.current) return 'idle';
      setStatus('error');
      return 'error';
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }
    generation.current += 1;
    const mine = generation.current;
    startedAt.current = Date.now();
    // A restart with a profile already shown is still waiting for a newer one, not loading from nothing.
    setStatus(hasProfile.current ? 'waiting' : 'loading');

    const loop = async (): Promise<void> => {
      const outcome = await read();
      if (mine !== generation.current) return;
      if (outcome !== 'waiting' && outcome !== 'error') return;
      if (Date.now() - startedAt.current >= KB_PROFILE_GIVE_UP_MS) {
        setStatus('timeout');
        return;
      }
      timer.current = setTimeout(() => void loop(), KB_PROFILE_POLL_MS);
    };
    void loop();

    return () => {
      generation.current += 1;
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [enabled, read, since]);

  return { status, profile, refresh: async () => void (await read()) };
}
