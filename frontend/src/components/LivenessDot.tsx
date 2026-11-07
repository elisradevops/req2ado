import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { BEAT, useReplayOnChange } from '../ui/motion';

/** Beats closer together than this are held back, so a burst of events never chains into one long motion (WCAG 2.2.2). */
export const BEAT_MIN_GAP_MS = 2000;

// The live dot of a running job. It replaces an endless ping: it beats ONCE, as an opacity-only halo, each time `beatKey`
// changes (the server really reported progress), and it becomes a hollow ring when `waiting` (nothing has arrived for a
// while). A quiet wait is normal for one large request, so it is never warning-coloured; the shape and the text beside it
// carry the state, and the halo is only a cue that something just happened.
export function LivenessDot({ beatKey, waiting }: { beatKey: string | number; waiting: boolean }): React.ReactElement {
  const haloRef = useRef<HTMLSpanElement>(null);
  const [beats, setBeats] = useState(0);
  const first = useRef(true);
  const lastBeatAt = useRef(0);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const now = Date.now();
    if (now - lastBeatAt.current < BEAT_MIN_GAP_MS) return;
    lastBeatAt.current = now;
    setBeats((count) => count + 1);
  }, [beatKey]);
  useReplayOnChange(haloRef, String(beats), BEAT);
  return (
    <span data-liveness={waiting ? 'waiting' : 'live'} className="relative flex h-2.5 w-2.5 flex-none">
      <span ref={haloRef} aria-hidden="true" className="absolute -inset-1 rounded-full bg-live/60 opacity-0" />
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', waiting ? 'border-2 border-live bg-transparent' : 'bg-live')} />
    </span>
  );
}
