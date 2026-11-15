import { useEffect, useRef, useState } from 'react';
import { useLiveRunStore } from '../../store/liveRunStore';
import { noticeCopy, STAGE_COPY, STILL_WORKING_COPY } from '../../utils/liveCopy';

/** Phase changes are announced at most this often; the latest one wins. */
export const ANNOUNCE_INTERVAL_MS = 15000;

// The run view's one polite live region for assistive technology. It is in the
// markup from the first render, empty, because screen readers only announce
// changes to a region that already exists. It says when the step changes
// (throttled, latest wins). It never reads out items, excerpts or percentages.
const WAITING_ANNOUNCEMENT = 'No update for over a minute. The job is still working.';

// DESIGN.md §13 / §11.3.5: the page has ONE polite status region. Besides step changes and warning notices it carries the
// page's own arrival message (`message`) and the long-wait notice (fixed text, never the ticking time).
export function LiveStatusRegion({ message = '' }: { message?: string }): React.ReactElement {
  const stage = useLiveRunStore((s) => s.progress?.stage ?? null);
  // The newest warning notice by kind and count, announced once when it first appears.
  const warning = useLiveRunStore((s) => {
    const warnings = s.notices.filter((n) => n.severity === 'warning');
    return warnings.length > 0 ? warnings[warnings.length - 1].kind : null;
  });
  const waiting = useLiveRunStore((s) => s.waiting);
  const stillWorkingOn = useLiveRunStore((s) => s.stillWorkingOn);
  const [text, setText] = useState('');
  const announcedWarning = useRef<string | null>(null);

  // Latest wins, as for the step: the page's own message (a job that has just started, one that is now running).
  const lastMessage = useRef('');
  useEffect(() => {
    const previous = lastMessage.current;
    lastMessage.current = message;
    if (message) setText(message);
    // A message that goes away takes its own announcement with it (another job's arrival must not linger).
    else if (previous) setText((current) => (current === previous ? '' : current));
  }, [message]);

  // The wait is spoken once, when it starts, and cleared when it ends so a later wait is spoken again.
  useEffect(() => {
    if (waiting) setText(WAITING_ANNOUNCEMENT);
    else setText((current) => (current === WAITING_ANNOUNCEMENT ? '' : current));
  }, [waiting]);

  // A stage gone quiet (20 s, QA P2) is spoken once, when the threshold is crossed, and cleared by the next event. Declared
  // after the wait so the one-minute wait, which replaces it, is not cleared by it.
  const quietText = useRef('');
  useEffect(() => {
    const previous = quietText.current;
    quietText.current = stillWorkingOn ? STILL_WORKING_COPY(stillWorkingOn) : '';
    if (quietText.current) setText(quietText.current);
    else if (previous) setText((current) => (current === previous ? '' : current));
  }, [stillWorkingOn]);

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
