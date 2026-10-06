import { create } from 'zustand';
import type { ComparePayload, Heartbeat, InFlightKind, LiveFrame, Notice, ProgressEvent } from '../api/liveTypes';

// The live run view's state (job transparency). It is a store of its own, not
// state inside the 2,000-line JobDetail page, so a stream of small updates
// re-renders only the components that read the piece that changed.
//
// Incoming events are queued and applied together at most four times a second,
// and not at all while the tab is hidden (they wait, bounded, and are applied
// when it comes back), so a burst of frames cannot flood React.

export const FLUSH_INTERVAL_MS = 250;
/** Bounds the queue while the tab is hidden; finished items are never dropped to make room. */
const MAX_QUEUED = 2000;
/** The document map is capped at 5,000 items on the server; this is the matching ceiling. */
const MAX_FINISHED_ITEMS = 6000;
export const RECENT_ITEMS = 4;

export interface LaneState {
  lane: number;
  kind: InFlightKind;
  ref: string | null;
  title: string | null;
  /** A short excerpt of the owner's own document text. Never announced to assistive tech. */
  excerpt: string | null;
  itemType: string | null;
  page: number | null;
  pages: number | null;
  seq: number;
  /** Browser clock when the frame arrived, for "how long ago" decisions. */
  receivedAt: number;
}

export interface FinishedItem {
  ref: string;
  title: string | null;
  itemType: string | null;
  lane: number;
  seq: number;
}

export interface HeartbeatState {
  idleSeconds: number;
  inFlight: Heartbeat['inFlight'];
  receivedAt: number;
}

/** Merges a notice into the list: one entry per kind, the newest count wins, order is first seen. */
export function mergeNotice(list: Notice[], incoming: Notice): Notice[] {
  const at = list.findIndex((n) => n.kind === incoming.kind);
  if (at < 0) return [...list, incoming];
  if (incoming.count < list[at].count || incoming.id === list[at].id) return list;
  const next = list.slice();
  next[at] = incoming;
  return next;
}

type Queued =
  | { kind: 'progress'; value: ProgressEvent }
  | { kind: 'live'; value: LiveFrame }
  | { kind: 'heartbeat'; value: Heartbeat };

interface LiveRunState {
  jobId: string | null;
  progress: ProgressEvent | null;
  lanes: Record<number, LaneState>;
  doneRefs: Record<string, FinishedItem>;
  doneCount: number;
  /** The last few finished items, newest first, for the "just finished" line. */
  recent: FinishedItem[];
  compare: { payload: ComparePayload; seq: number; receivedAt: number } | null;
  heartbeat: HeartbeatState | null;
  /** What changed the run (typed notices), one per kind. Low volume, so applied at once. */
  notices: Notice[];
  /** True once any progress or live event has arrived: the server has the feature on. */
  active: boolean;
  /** Browser clock of the newest event of any kind (see `touch`). */
  lastEventAt: number | null;
  /**
   * Browser clock of the newest progress or live frame. Heartbeats do not count:
   * they prove the server is reachable, not that the run produced anything.
   */
  activityAt: number | null;
  /** Browser clock of the last stream error, if no event has arrived since. */
  errorAt: number | null;

  begin: (jobId: string) => void;
  ingestProgress: (event: ProgressEvent) => void;
  ingestLive: (frame: LiveFrame) => void;
  ingestHeartbeat: (beat: Heartbeat) => void;
  ingestNotice: (notice: Notice) => void;
  /** Items already finished before this page connected (read once, see api/runMap). */
  seedDone: (refs: string[]) => void;
  /** Any event at all (stage, narration, ...) proves the connection is alive. */
  touch: () => void;
  markError: () => void;
  flush: () => void;
  reset: () => void;
}

const EMPTY = {
  jobId: null,
  progress: null,
  lanes: {},
  doneRefs: {},
  doneCount: 0,
  recent: [],
  compare: null,
  heartbeat: null,
  notices: [],
  active: false,
  lastEventAt: null,
  activityAt: null,
  errorAt: null,
} satisfies Partial<LiveRunState>;

let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let visibilityHooked = false;
// Highest seq applied per lane, so a replay after a reconnect cannot move a lane backwards.
let laneSeq: Record<number, number> = {};

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function schedule(): void {
  if (timer !== null || hidden()) return;
  timer = setTimeout(() => {
    timer = null;
    useLiveRunStore.getState().flush();
  }, FLUSH_INTERVAL_MS);
}

function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (!hidden() && queue.length > 0) useLiveRunStore.getState().flush();
  });
}

function enqueue(item: Queued): void {
  hookVisibility();
  queue.push(item);
  if (queue.length > MAX_QUEUED) {
    // Keep finished-item frames (they feed the outline); drop the oldest of the rest.
    const dropAt = queue.findIndex((q) => !(q.kind === 'live' && q.value.kind === 'item'));
    if (dropAt >= 0) queue.splice(dropAt, 1);
  }
  schedule();
}

export const useLiveRunStore = create<LiveRunState>((set, get) => ({
  ...EMPTY,

  begin: (jobId) => {
    if (get().jobId === jobId) return;
    queue = [];
    laneSeq = {};
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    set({ ...EMPTY, jobId });
  },

  ingestProgress: (event) => enqueue({ kind: 'progress', value: event }),
  ingestLive: (frame) => enqueue({ kind: 'live', value: frame }),
  ingestHeartbeat: (beat) => enqueue({ kind: 'heartbeat', value: beat }),
  ingestNotice: (notice) => set((state) => ({ notices: mergeNotice(state.notices, notice) })),

  seedDone: (refs) => {
    const state = get();
    let doneRefs = state.doneRefs;
    let doneCount = state.doneCount;
    for (const ref of refs) {
      if (doneRefs[ref] || doneCount >= MAX_FINISHED_ITEMS) continue;
      if (doneRefs === state.doneRefs) doneRefs = { ...doneRefs };
      doneRefs[ref] = { ref, title: null, itemType: null, lane: 0, seq: 0 };
      doneCount += 1;
    }
    if (doneRefs !== state.doneRefs) set({ doneRefs, doneCount });
  },

  touch: () => set({ lastEventAt: Date.now(), errorAt: null }),
  markError: () => set({ errorAt: Date.now() }),

  flush: () => {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    const now = Date.now();
    const state = get();
    let progress = state.progress;
    let lanes = state.lanes;
    let doneRefs = state.doneRefs;
    let doneCount = state.doneCount;
    let recent = state.recent;
    let compare = state.compare;
    let heartbeat = state.heartbeat;
    let activityAt = state.activityAt;
    for (const entry of batch) {
      if (entry.kind !== 'heartbeat') activityAt = now;
      if (entry.kind === 'progress') {
        // Replays and out-of-order delivery: never go back to an older event.
        if (progress === null || entry.value.seq > progress.seq) progress = entry.value;
      } else if (entry.kind === 'heartbeat') {
        heartbeat = { idleSeconds: entry.value.idleSeconds, inFlight: entry.value.inFlight, receivedAt: now };
      } else {
        const frame = entry.value;
        if (frame.seq <= (laneSeq[frame.lane] ?? -1)) continue;
        laneSeq[frame.lane] = frame.seq;
        if (frame.kind === 'reset') {
          if (lanes[frame.lane]) {
            lanes = { ...lanes };
            delete lanes[frame.lane];
          }
        } else if (frame.kind === 'item') {
          if (frame.ref && !doneRefs[frame.ref] && doneCount < MAX_FINISHED_ITEMS) {
            const finished: FinishedItem = {
              ref: frame.ref, title: frame.title ?? null, itemType: frame.itemType ?? null, lane: frame.lane, seq: frame.seq,
            };
            doneRefs = { ...doneRefs, [frame.ref]: finished };
            recent = [finished, ...recent].slice(0, RECENT_ITEMS);
            doneCount += 1;
          }
        } else if (frame.kind === 'compare') {
          if (frame.compare) compare = { payload: frame.compare, seq: frame.seq, receivedAt: now };
        } else {
          lanes = {
            ...lanes,
            [frame.lane]: {
              lane: frame.lane,
              kind: frame.kind,
              ref: frame.ref ?? null,
              title: frame.title ?? null,
              excerpt: frame.excerpt ?? null,
              itemType: frame.itemType ?? null,
              page: frame.page ?? null,
              pages: frame.pages ?? null,
              seq: frame.seq,
              receivedAt: now,
            },
          };
        }
      }
    }
    set({
      progress,
      lanes,
      doneRefs,
      doneCount,
      recent,
      compare,
      heartbeat,
      active: true,
      lastEventAt: now,
      activityAt,
      errorAt: null,
    });
  },

  reset: () => {
    queue = [];
    laneSeq = {};
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    set({ ...EMPTY });
  },
}));
