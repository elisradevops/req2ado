import { useEffect, useMemo } from 'react';
import { getRunDone } from '../../api/runMap';
import { buildOutlinePaths } from '../../lib/outlinePaths';
import { useLiveRunStore } from '../../store/liveRunStore';
import { useDocumentMap } from '../../hooks/useDocumentMap';
import { useNow } from '../../hooks/useNow';
import {
  CONNECTION_LOST_COPY,
  LIMITS_HEADING,
  WAITING_ON_MODEL_COPY,
} from '../../utils/liveCopy';
import { DocumentMetrics } from './DocumentMetrics';
import { DocumentOutline } from './DocumentOutline';
import { WorkingOnCard } from './WorkingOnCard';
import { ComparePair } from './ComparePair';
import { RunNotices } from './RunNotices';

/** No event of any kind for this long, after a stream error, reads as a lost connection. */
export const CONNECTION_LOST_AFTER_MS = 30000;
/** A model request that has been the only thing running for this long is called out. */
export const LONG_WAIT_AFTER_SECONDS = 60;

// The live view of what a running SURVEY job is doing: the document in numbers,
// what the model is on now, an outline with progress, and (when the run finds
// one) two texts side by side. It appears only when the server has the live
// feature on; with it off, or against an older server, this renders nothing and
// the banner is exactly what it was.
export function LiveRunPanel({ jobId, running }: { jobId: string | undefined; running: boolean }): React.ReactElement | null {
  const active = useLiveRunStore((s) => s.active);
  const lanes = useLiveRunStore((s) => s.lanes);
  const recent = useLiveRunStore((s) => s.recent);
  const doneRefs = useLiveRunStore((s) => s.doneRefs);
  const doneCount = useLiveRunStore((s) => s.doneCount);
  const compare = useLiveRunStore((s) => s.compare);
  const heartbeat = useLiveRunStore((s) => s.heartbeat);
  const lastEventAt = useLiveRunStore((s) => s.lastEventAt);
  const errorAt = useLiveRunStore((s) => s.errorAt);
  const notices = useLiveRunStore((s) => s.notices);
  const { map } = useDocumentMap(jobId, active, running);
  const now = useNow();

  // A page opened mid-run missed the frames for items already finished (the stream
  // replays only the latest frame per lane), so read them once when the map loads.
  const seedDone = useLiveRunStore((s) => s.seedDone);
  const hasMap = map !== null;
  useEffect(() => {
    if (!jobId || !hasMap || !running) return;
    let cancelled = false;
    getRunDone(jobId)
      .then((refs) => {
        if (!cancelled && refs) seedDone(refs);
      })
      .catch(() => undefined); // no seed just means the outline fills in from live frames
    return () => {
      cancelled = true;
    };
  }, [jobId, hasMap, running, seedDone]);

  const laneList = useMemo(() => Object.values(lanes), [lanes]);
  const titleByRef = useMemo(() => new Map((map?.items ?? []).map((item) => [item.ref, item.title])), [map]);
  const pathByRef = useMemo(() => buildOutlinePaths(map?.items ?? []), [map]);
  const workingRefs = useMemo(
    () => new Set(laneList.map((lane) => lane.ref).filter((ref): ref is string => !!ref)),
    [laneList],
  );

  if (!active && !map) return null;

  const lost = errorAt !== null && now - (lastEventAt ?? errorAt) > CONNECTION_LOST_AFTER_MS;
  const idle = heartbeat ? heartbeat.idleSeconds + Math.max(0, (now - heartbeat.receivedAt) / 1000) : 0;
  const longWait = !lost && heartbeat !== null && heartbeat.inFlight.length > 0 && idle >= LONG_WAIT_AFTER_SECONDS;

  return (
    <div className='mt-2.5 flex flex-col gap-2.5' data-testid='live-run-panel'>
      {lost && (
        <p role='alert' className='rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-ink'>
          {CONNECTION_LOST_COPY}
        </p>
      )}
      {longWait && heartbeat && (
        <p className='rounded-md border border-hairline-strong bg-surface-alt px-3 py-2 text-xs text-ink-2' data-testid='long-wait-note'>
          {WAITING_ON_MODEL_COPY(idle)}
        </p>
      )}
      <RunNotices notices={notices} heading={LIMITS_HEADING} storageKey={`${jobId}.live`} titleByRef={titleByRef} />
      {map && <DocumentMetrics stats={map.stats} finished={doneCount} total={map.totalItems} />}
      {active && <WorkingOnCard lanes={laneList} recent={recent} now={now} titleByRef={titleByRef} />}
      {compare && <ComparePair key={compare.seq} compare={compare.payload} titleByRef={titleByRef} pathByRef={pathByRef} />}
      {map && map.items.length > 0 && (
        <DocumentOutline items={map.items} doneRefs={doneRefs} workingRefs={workingRefs} truncated={map.truncated} />
      )}
    </div>
  );
}
