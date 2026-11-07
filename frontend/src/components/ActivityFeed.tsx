import { useEffect, useRef, useState } from 'react';
import type { NarrationEvent } from '../api/events';
import { cn } from '../lib/cn';
import { ARRIVE, useArrivedLate, useSettled } from '../ui/motion';

/** Lines shown until the person opens the rest. */
export const COLLAPSED_LINES = 6;

const TIME_FORMAT = new Intl.DateTimeFormat([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export interface ActivityEvent {
  id: number;
  label: string;
  message: string;
  /** When this page first saw the event, or null for one that was already there when the page opened. */
  seenAt: number | null;
}

// Narration events carry no id, and the merged list is rebuilt on every render, so identity comes from content (plus the
// nth repeat of the same content). A time comes from the event's own `at` (history: when the server recorded it; live: when
// this page received it); without one, an event present on the first render has no time and a later one is stamped now.
export function useActivityLog(narrations: NarrationEvent[] | undefined, labelFor: (event: NarrationEvent) => string): ActivityEvent[] {
  const known = useRef(new Map<string, { id: number; seenAt: number | null }>());
  const nextId = useRef(0);
  const firstRender = useRef(true);
  useEffect(() => {
    firstRender.current = false;
  }, []);

  const seenInThisPass = new Map<string, number>();
  const live = new Set<string>();
  const events = (narrations ?? []).map((event) => {
    const content = `${event.phase}|${event.branchIndex ?? ''}|${event.chunkIndex ?? ''}|${event.blocksDone}|${event.message}`;
    // With a recorded time, content plus time is the identity: it stays put when the capped list drops older repeats.
    // Without one, the nth repeat of the content stands in.
    const nth = (seenInThisPass.get(content) ?? 0) + 1;
    seenInThisPass.set(content, nth);
    const key = event.at ? `${content}@${event.at}` : `${content}#${nth}`;
    live.add(key);
    let meta = known.current.get(key);
    if (!meta) {
      // The server's own time wins; failing that, an event present on first render is history (no time) and a later one is
      // stamped with the moment this page saw it.
      const recorded = event.at ? Date.parse(event.at) : NaN;
      meta = { id: nextId.current++, seenAt: Number.isFinite(recorded) ? recorded : firstRender.current ? null : Date.now() };
      known.current.set(key, meta);
    }
    return { id: meta.id, label: labelFor(event), message: event.message, seenAt: meta.seenAt };
  });
  // The list is capped upstream: forget what has scrolled out of it, so this map stays bounded.
  for (const key of known.current.keys()) if (!live.has(key)) known.current.delete(key);
  return events;
}

function Line({ event, settled }: { event: ActivityEvent; settled: boolean }): React.ReactElement {
  const arrivedLate = useArrivedLate(settled);
  return (
    <li className={cn('flex items-baseline gap-2 px-4 py-1 text-xs max-md:flex-wrap', arrivedLate && ARRIVE.fade)}>
      {event.seenAt === null ? (
        <span className="w-[4.5rem] flex-none text-ink-3">earlier</span>
      ) : (
        <time dir="ltr" dateTime={new Date(event.seenAt).toISOString()} className="w-[4.5rem] flex-none font-mono tabular-nums text-ink-3">
          {TIME_FORMAT.format(event.seenAt)}
        </time>
      )}
      <span className="flex-none font-medium text-ink-2">{event.label}</span>
      {event.message && (
        <span className="min-w-0 truncate text-ink-3 max-md:line-clamp-2 max-md:basis-full max-md:whitespace-normal" title={event.message}>
          {event.message}
        </span>
      )}
    </li>
  );
}

// A compact record of what the run has reported, so a long wait shows what already happened and when. It is a log:
// oldest first, newest at the bottom. It does not announce each line (that would bury a screen reader in routine
// updates); the run's milestones go through one status region instead.
export function ActivityFeed({ events }: { events: ActivityEvent[] }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const settled = useSettled();
  const canExpand = events.length > COLLAPSED_LINES;
  const shown = expanded ? events : events.slice(-COLLAPSED_LINES);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  // When it is open and the person is reading the newest lines, keep them in view as more arrive.
  // Keyed on the newest line's id, not the length: the list is capped, so once it is full the length never changes again.
  const newestId = events.at(-1)?.id;
  useEffect(() => {
    const el = scroller.current;
    if (expanded && el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [expanded, newestId]);

  return (
    <section aria-labelledby="activity-heading" className="border-b border-hairline">
      <div className="flex items-center justify-between gap-2 px-4 pt-2">
        <h2 id="activity-heading" className="text-meta font-semibold text-ink-3">
          Activity
        </h2>
        {canExpand && (
          <button
            type="button"
            onClick={() => {
              // Opening lands on the newest lines, whatever the last reading position was.
              nearBottom.current = true;
              setExpanded((open) => !open);
            }}
            className="rounded-sm text-meta font-medium text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {expanded ? 'Show fewer' : `Show all ${events.length}`}
          </button>
        )}
      </div>
      <div
        ref={scroller}
        // once open it scrolls, so it is a named region the keyboard can reach
        role={expanded ? 'region' : undefined}
        aria-label={expanded ? 'Job activity, scrollable' : undefined}
        tabIndex={expanded ? 0 : undefined}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className={cn('pb-2', expanded && 'max-h-56 overflow-y-auto')}
      >
        {events.length === 0 ? (
          <p className="px-4 py-1 text-xs text-ink-3">Nothing yet. The first update appears here as soon as the run reports one.</p>
        ) : (
          <ol role="log" aria-label="Job activity" aria-live="off">
            {shown.map((event) => (
              <Line key={event.id} event={event} settled={settled.current} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
