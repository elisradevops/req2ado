import { useEffect, useRef, useState } from 'react';
import { useLiveRunStore } from '../../store/liveRunStore';
import { noticeCopy, STAGE_COPY } from '../../utils/liveCopy';

/** Phase changes are announced at most this often; the latest one wins. */
export const ANNOUNCE_INTERVAL_MS = 15000;

// The run view's one polite live region for assistive technology. It is in the
// markup from the first render, empty, because screen readers only announce
// changes to a region that already exists. It says when the step changes
// (throttled, latest wins). It never reads out items, excerpts or percentages.
export function LiveStatusRegion(): React.ReactElement {
  const stage = useLiveRunStore((s) => s.progress?.stage ?? null);
  // The newest warning notice by kind and count, announced once when it first appears.
  const warning = useLiveRunStore((s) => {
    const warnings = s.notices.filter((n) => n.severity === 'warning');
    return warnings.length > 0 ? warnings[warnings.length - 1].kind : null;
  });
  const [text, setText] = useState('');
  const announcedWarning = useRef<string | null>(null);

  useEffect(() => {
    if (!warning || warning === announcedWarning.current) return;
    announcedWarning.current = warning;
    setText(noticeCopy({ kind: warning, count: 1, facts: {} }).title);
  }, [warning]);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (!stage || stage === announced.current) return;
    const say = (): void => {
      announced.current = stage;
      lastAt.current = Date.now();
      setText(STAGE_COPY[stage].headline);
    };
    const wait = lastAt.current === 0 ? 0 : ANNOUNCE_INTERVAL_MS - (Date.now() - lastAt.current);
    if (wait <= 0) say();
    else {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(say, wait);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [stage]);

  return (
    <div role='status' aria-live='polite' className='sr-only' data-testid='live-status-region'>
      {text}
    </div>
  );
}
