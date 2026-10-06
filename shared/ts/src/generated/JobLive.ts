/* eslint-disable */
/**
 * This file was automatically generated from shared/schemas/job-live.schema.json.
 * DO NOT EDIT — run `pnpm --filter @req2ado/shared-ts generate` instead.
 */

export type StageName =
  'parse' | 'draft' | 'improve' | 'summarize' | 'skeleton' | 'map' | 'write' | 'score' | 'link' | 'dedup' | 'write_ado';

/**
 * Wire contracts for live job transparency (docs/job-transparency-implementation-plan.md): the static document map, the exact stage units ingestion reports, the weighted progress the orchestrator publishes, and the live frames shown while a job runs. Single source of truth - TS types are generated from this file (shared/ts, `pnpm generate`); the Python producers are hand-written and checked against this schema by ingestion/tests/test_job_live_contract.py. The root object only bundles the definitions so they are all generated.
 */
export interface JobLive {
  documentMap?: DocumentMap;
  stageUnits?: StageUnits;
  progress?: ProgressEvent;
  live?: LiveFrame;
  heartbeat?: Heartbeat;
  notice?: Notice;
}
export interface DocumentMap {
  version: 1;
  /**
   * What the running screen should call an item.
   */
  unit: 'headings' | 'rows' | 'items';
  stats: DocStats;
  /**
   * True when the item list was cut or dropped to respect the size limits; groups and totals are always complete.
   */
  truncated: boolean;
  totalItems: number;
  groups: MapGroup[];
  items: MapItem[];
}
export interface DocStats {
  words: number;
  blocks: number;
  headings: number;
  tables: number;
  tableRows: number;
  figures: number;
  /**
   * Highest page number found, or null when the format has no pagination.
   */
  pages: number | null;
}
export interface MapGroup {
  ref: string;
  title: string;
  kind: 'heading' | 'table';
  /**
   * Position of this group's first item in the full item sequence.
   */
  itemStart: number;
  itemCount: number;
  words: number;
}
export interface MapItem {
  ref: string;
  title: string;
  words: number;
  depth: number;
  /**
   * Epic, Feature or Requirement as resolved by the detector, or null.
   */
  type: string | null;
}
/**
 * Exact units a stage has finished, derived from existing progress events and published on job-events:{id}:units. Never an estimate.
 */
export interface StageUnits {
  type: 'units';
  stage: StageName;
  unit: 'figures' | 'pages' | 'items' | 'sections' | 'requirements' | 'passes';
  done: number;
  total: number;
  complete: boolean;
  subtree?: number | null;
  subtreeCount?: number | null;
  chunk?: number | null;
  chunkCount?: number | null;
  emittedAt: string;
}
/**
 * Weighted overall progress, computed by the orchestrator (one publisher per job) from the exact stage units. SSE event name: progress.
 */
export interface ProgressEvent {
  type: 'progress';
  /**
   * Monotonic per job; clients drop frames older than the newest seen.
   */
  seq: number;
  /**
   * Never decreases within a job.
   */
  pct: number;
  stage: StageName;
  unit: 'figures' | 'pages' | 'items' | 'sections' | 'requirements' | 'passes';
  done: number;
  total: number;
  /**
   * True while the stage weights are the shipped defaults rather than calibrated from past runs.
   */
  estimated: boolean;
  emittedAt: string;
}
/**
 * What the job is working on right now, coalesced at the source (at most a few per second per job). SSE event name: live. The position shown is inferred from output order, so clients should say 'working on', never 'reading'.
 */
export interface LiveFrame {
  type: 'live';
  seq: number;
  /**
   * Concurrent chunks or branches each have their own lane.
   */
  lane: number;
  kind: 'working_on' | 'writing' | 'item' | 'compare' | 'ocr_page' | 'reset';
  /**
   * Map item or group this frame is about.
   */
  ref?: string | null;
  /**
   * Title of the work item as written so far.
   */
  title?: string | null;
  /**
   * Epic, Feature or Requirement.
   */
  itemType?: string | null;
  /**
   * Short excerpt of the owner's own document text; length is also capped by LIVE_EXCERPT_MAX_CHARS. Never persisted.
   */
  excerpt?: string | null;
  /**
   * Approximate position within the excerpt, only set when output order is known to follow input order.
   */
  cursor?: number | null;
  /**
   * True while the title or text is still being written.
   */
  partial?: boolean;
  compare?: ComparePayload | null;
  page?: number | null;
  pages?: number | null;
  emittedAt: string;
}
export interface ComparePayload {
  kind: 'conflict' | 'duplicate';
  a: CompareSide;
  b: CompareSide;
  similarity: number;
}
export interface CompareSide {
  ref: string;
  text: string;
}
/**
 * Sent every 15 seconds on an open event stream while live progress is on. SSE event name: heartbeat. Its arrival proves the server and the event bus are reachable; idleSeconds says how long nothing has been published for the job, so a screen can tell 'still working on a long model call' from 'lost contact'. Never stored.
 */
export interface Heartbeat {
  type: 'heartbeat';
  at: string;
  idleSeconds: number;
  /**
   * @maxItems 64
   */
  inFlight: {
    lane: number;
    kind: 'working_on' | 'writing' | 'ocr_page';
    ref?: string | null;
    title?: string | null;
  }[];
}
/**
 * A condition that changed what the run produced or how long it took. SSE event name: notice. Kept in the job's event history (JobEvent, phase notice) and replayed on connect. A fixed kind plus a few numbers and short enums: never free text and never document text; the screen owns the wording. count is cumulative for the kind, so a repeating kind is sent at spaced counts only.
 */
export interface Notice {
  type: 'notice';
  id: string;
  kind: 'output_limit_reached' | 'server_retry' | 'context_assumed' | 'stream_fallback';
  severity: 'info' | 'warning';
  count: number;
  facts: {
    [k: string]: string | number | boolean;
  };
  emittedAt: string;
}
