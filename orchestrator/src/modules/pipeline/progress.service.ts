import type { ProgressEvent } from '@req2ado/shared-ts';

// Job transparency (docs/job-transparency-implementation-plan.md, B4): one
// weighted percentage per job, counted from the EXACT units ingestion reports
// per stage (see ingestion/app/leveling/stage_units.py). Units are counted;
// only the share each stage takes of the whole run is an estimate, and those
// shares are the shipped defaults until calibrated from past runs (plan S6).
// Runs in the pipeline worker process that owns the job, so exactly one
// publisher exists per job.

export type StageName = ProgressEvent['stage'];
export type ProgressUnit = ProgressEvent['unit'];
export type ProgressPath = 'det' | 'llm' | 'scan';

export interface ProgressUnits {
  stage: StageName;
  unit: ProgressUnit;
  done: number;
  total: number;
  complete?: boolean;
}

interface StageWeight {
  stage: StageName;
  weight: number;
  /** Counts only once it reports: not every run has this stage. */
  optional?: boolean;
  /** Ingestion plans these up front; one planned at zero items is skipped and drops out. */
  skippable?: boolean;
}

// Order is the order stages run in. Weights in each path sum to 1. Measured on 14 real
// runs (docx, spreadsheet, text PDF, scanned PDF) with one local model: scoring and
// trace linking take roughly two thirds of a run, the drafting passes a quarter.
// The shares depend on the model and the hardware (a slower model made a single
// parent-summary call 70% of one run), so these stay estimates, labelled "est.".
//   det:  documents whose own structure encodes the hierarchy (Word headings,
//         ID tables, spreadsheets) -- three chunked passes (draft, improve,
//         summarize) plus, for any leftover text, the section stages.
//   llm:  text-first documents processed section by section.
//   scan: same as llm but pages are read first (OCR), which takes real time.
export const PROGRESS_WEIGHTS: Record<ProgressPath, StageWeight[]> = {
  det: [
    { stage: 'parse', weight: 0.02 },
    { stage: 'draft', weight: 0.12, skippable: true },
    { stage: 'improve', weight: 0.09, skippable: true },
    { stage: 'summarize', weight: 0.15, skippable: true },
    { stage: 'skeleton', weight: 0.03, optional: true },
    { stage: 'write', weight: 0.03, optional: true },
    { stage: 'score', weight: 0.3 },
    { stage: 'link', weight: 0.24 },
    { stage: 'dedup', weight: 0.02 },
  ],
  llm: [
    { stage: 'parse', weight: 0.02 },
    { stage: 'skeleton', weight: 0.16 },
    { stage: 'map', weight: 0.02 },
    { stage: 'write', weight: 0.16 },
    { stage: 'score', weight: 0.37 },
    { stage: 'link', weight: 0.25 },
    { stage: 'dedup', weight: 0.02 },
  ],
  scan: [
    { stage: 'parse', weight: 0.12 },
    { stage: 'skeleton', weight: 0.16 },
    { stage: 'map', weight: 0.02 },
    { stage: 'write', weight: 0.14 },
    { stage: 'score', weight: 0.29 },
    { stage: 'link', weight: 0.25 },
    { stage: 'dedup', weight: 0.02 },
  ],
};

// The three passes that run over many chunks and, for a document with several
// deterministic subtrees, once per subtree: they interleave, so a later one
// starting does not mean an earlier one is over. Every other step is strictly
// sequential.
const INTERLEAVING: ReadonlySet<StageName> = new Set<StageName>(['draft', 'improve', 'summarize']);

// A pass planned at zero items is a marker that it will not run, not evidence
// that this is a deterministic-hierarchy document.
const hasWork = (units: ProgressUnits | undefined): boolean => !!units && (units.total > 0 || units.done > 0);

export function resolvePath(seen: ReadonlyMap<StageName, ProgressUnits>): ProgressPath {
  if (seen.get('parse')?.unit === 'pages') return 'scan';
  if (hasWork(seen.get('draft')) || hasWork(seen.get('improve')) || hasWork(seen.get('summarize'))) return 'det';
  if (seen.has('skeleton') || seen.has('map') || seen.has('write')) return 'llm';
  return 'det';
}

function fraction(units: ProgressUnits): number {
  if (units.complete) return 1;
  if (units.total <= 0) return 0;
  return Math.max(0, Math.min(1, units.done / units.total));
}

export interface OverallProgress {
  /** 0..1, not yet clamped or rounded. */
  value: number;
  stage: StageName;
  unit: ProgressUnit;
  done: number;
  total: number;
}

/**
 * Weighted progress from the latest units seen per stage. Each stage adds its
 * own share times its own completed fraction. A stage that has not reported
 * counts as done when a later stage has (a run that skipped it must not hold
 * the bar back). A step that reported but never says it finished (the section
 * skeleton, the last trace-link pass) counts as done once a later sequential
 * step has reported: the run is sequential there, so the earlier step is over.
 * The interleaving passes are the exception (see INTERLEAVING). An optional
 * stage counts only once it reports; a skippable
 * stage planned at zero items drops out and the rest are rescaled, so a pass
 * that never runs does not hand out its share at once. Stages not in the
 * path's table (such as writing to ADO) are ignored. `latest` is the fallback
 * for the "what is happening now" part of the event once every step is done.
 */
export function computeOverall(
  seen: ReadonlyMap<StageName, ProgressUnits>,
  latest?: ProgressUnits,
): OverallProgress {
  const table = PROGRESS_WEIGHTS[resolvePath(seen)];
  let lastSeen = -1;
  table.forEach((entry, index) => {
    if (seen.has(entry.stage)) lastSeen = index;
  });
  if (lastSeen < 0) return { value: 0, stage: 'parse', unit: 'figures', done: 0, total: 0 };
  const isSkipped = (entry: StageWeight, units: ProgressUnits | undefined): boolean =>
    !!units && !!entry.skippable && units.complete === true && units.total === 0;
  // The latest sequential step that has reported: everything before it is over.
  let lastSequential = -1;
  table.forEach((entry, index) => {
    const units = seen.get(entry.stage);
    if (units && !INTERLEAVING.has(entry.stage) && !isSkipped(entry, units)) lastSequential = index;
  });
  const shareOf = (entry: StageWeight, index: number): number => {
    const units = seen.get(entry.stage);
    if (!units) return index < lastSeen ? 1 : 0;
    return index < lastSequential ? 1 : fraction(units);
  };
  let weightSum = 0;
  let doneSum = 0;
  table.forEach((entry, index) => {
    const units = seen.get(entry.stage);
    if (!units && entry.optional) return;
    if (isSkipped(entry, units)) return;
    weightSum += entry.weight;
    doneSum += entry.weight * shareOf(entry, index);
  });
  // What is happening now: the earliest step that has reported and is not
  // finished (the plan reports every pass up front, so "the last to report" would
  // name a step that has not started). When all are finished, the latest report.
  const running = table.find((entry, index) => {
    const units = seen.get(entry.stage);
    return !!units && !isSkipped(entry, units) && shareOf(entry, index) < 1;
  });
  const shown =
    (running && seen.get(running.stage)) ||
    (latest && seen.get(latest.stage)) ||
    (seen.get(table[lastSeen].stage) as ProgressUnits);
  return {
    value: weightSum > 0 ? doneSum / weightSum : 0,
    stage: shown.stage,
    unit: shown.unit,
    done: shown.done,
    total: shown.total,
  };
}

/** Per-job state: latest units per stage, last percentage, sequence number. */
export class ProgressTracker {
  private readonly seen = new Map<StageName, ProgressUnits>();
  private lastPct = 0;
  private lastStage: StageName | null = null;
  private seq = 0;
  private finished = false;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Restores state after a worker restart (latest units and last event). */
  seed(units: ProgressUnits[], last?: Pick<ProgressEvent, 'seq' | 'pct' | 'stage'> | null): void {
    for (const entry of units) this.setUnits(entry);
    if (last) {
      this.seq = last.seq;
      this.lastPct = last.pct;
      this.lastStage = last.stage;
    }
  }

  /** Returns an event only when the percentage or the stage changed. */
  ingest(units: ProgressUnits): ProgressEvent | null {
    this.setUnits(units);
    const overall = computeOverall(this.seen, units);
    // 100 is reserved for finish(): the run is not done until the diff is ready.
    const pct = Math.max(this.lastPct, Math.min(99, Math.round(overall.value * 100)));
    if (pct === this.lastPct && overall.stage === this.lastStage) return null;
    return this.emit(pct, overall);
  }

  // A scanned document reports its parse stage in pages. The ordinary "parse
  // finished" event counts figures, and must not turn the run back into a
  // text-first one: keep the pages and only take over "complete".
  private setUnits(units: ProgressUnits): void {
    const previous = this.seen.get(units.stage);
    if (units.stage === 'parse' && previous?.unit === 'pages' && units.unit !== 'pages') {
      this.seen.set('parse', { ...previous, complete: previous.complete || units.complete === true });
    } else {
      this.seen.set(units.stage, units);
    }
  }

  finish(): ProgressEvent | null {
    if (this.finished) return null;
    this.finished = true;
    const overall = computeOverall(this.seen);
    return this.emit(100, overall);
  }

  private emit(pct: number, overall: OverallProgress): ProgressEvent {
    this.lastPct = pct;
    this.lastStage = overall.stage;
    this.seq += 1;
    return {
      type: 'progress',
      seq: this.seq,
      pct,
      stage: overall.stage,
      unit: overall.unit,
      done: overall.done,
      total: overall.total,
      // True while the stage weights are the shipped defaults.
      estimated: true,
      emittedAt: this.now().toISOString(),
    };
  }
}

export interface ProgressRedisCommands {
  publish(channel: string, message: string): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface ProgressRedisSubscriber {
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

const PROGRESS_TTL_SECONDS = 24 * 3600;
const TRACKER_MAX_AGE_MS = 24 * 3600 * 1000;

export const unitsChannel = (jobId: string): string => `job-events:${jobId}:units`;
export const unitsLatestKey = (jobId: string): string => `job-events:${jobId}:units-latest`;
export const progressChannel = (jobId: string): string => `job-events:${jobId}:progress`;
export const progressLatestKey = (jobId: string): string => `job-events:${jobId}:progress-latest`;

function parseUnits(raw: string): ProgressUnits | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ProgressUnits> & { type?: string };
    if (parsed.type !== 'units' && parsed.type !== undefined) return null;
    if (typeof parsed.stage !== 'string' || typeof parsed.unit !== 'string') return null;
    if (!Number.isFinite(parsed.done) || !Number.isFinite(parsed.total)) return null;
    return {
      stage: parsed.stage as StageName,
      unit: parsed.unit as ProgressUnit,
      done: parsed.done as number,
      total: parsed.total as number,
      complete: parsed.complete === true,
    };
  } catch {
    return null;
  }
}

/**
 * Feeds one job's units into a ProgressTracker and publishes the resulting
 * progress events on their own channel (the SSE controller routes them to the
 * browser, B6). Entirely best-effort: a Redis failure here is logged and
 * swallowed, never fails or slows the job.
 */
export class ProgressService {
  private readonly trackers = new Map<string, { tracker: ProgressTracker; createdAt: number }>();

  constructor(
    private readonly commands: ProgressRedisCommands,
    private readonly subscriberFactory: () => ProgressRedisSubscriber,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private trackerFor(jobId: string): ProgressTracker {
    const nowMs = this.now().getTime();
    for (const [id, entry] of this.trackers) {
      if (nowMs - entry.createdAt > TRACKER_MAX_AGE_MS) this.trackers.delete(id);
    }
    let entry = this.trackers.get(jobId);
    if (!entry) {
      entry = { tracker: new ProgressTracker(this.now), createdAt: nowMs };
      this.trackers.set(jobId, entry);
    }
    return entry.tracker;
  }

  private async publish(jobId: string, event: ProgressEvent | null): Promise<void> {
    if (!event) return;
    const payload = JSON.stringify(event);
    await this.commands.set(progressLatestKey(jobId), payload, 'EX', PROGRESS_TTL_SECONDS);
    await this.commands.publish(progressChannel(jobId), payload);
  }

  private async handle(jobId: string, units: ProgressUnits): Promise<void> {
    try {
      await this.publish(jobId, this.trackerFor(jobId).ingest(units));
    } catch (err) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`ProgressService failed to publish progress for job ${jobId}:`, err);
    }
  }

  /** Starts following ingestion's units for this job. Returns the stop function. */
  async track(jobId: string): Promise<() => Promise<void>> {
    const tracker = this.trackerFor(jobId);
    const subscriber = this.subscriberFactory();
    try {
      const latest = await this.commands.hgetall(unitsLatestKey(jobId));
      const seeded = Object.values(latest ?? {})
        .map(parseUnits)
        .filter((u): u is ProgressUnits => u !== null);
      const lastRaw = await this.commands.get(progressLatestKey(jobId));
      const last = lastRaw ? (JSON.parse(lastRaw) as ProgressEvent) : null;
      tracker.seed(seeded, last);
      subscriber.on('message', (_channel, message) => {
        const units = parseUnits(message);
        if (units) void this.handle(jobId, units);
      });
      await subscriber.subscribe(unitsChannel(jobId));
    } catch (err) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`ProgressService could not start tracking job ${jobId}:`, err);
    }
    return async () => {
      try {
        await subscriber.unsubscribe(unitsChannel(jobId));
        await subscriber.quit();
      } catch {
        // The subscriber is going away either way.
      }
    };
  }

  /** For stages the orchestrator itself runs (duplicate check). */
  async record(jobId: string, units: ProgressUnits): Promise<void> {
    await this.handle(jobId, units);
  }

  /** The diff is ready: the run is done. Publishes 100 and drops the state. */
  async finish(jobId: string): Promise<void> {
    try {
      await this.publish(jobId, this.trackerFor(jobId).finish());
    } catch (err) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`ProgressService failed to finish job ${jobId}:`, err);
    } finally {
      this.trackers.delete(jobId);
    }
  }
}
