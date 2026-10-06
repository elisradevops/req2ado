// Mirrors shared/schemas/job-live.schema.json (the contract for the live run
// view). The frontend image builds from ./frontend alone, so it cannot import
// the generated @req2ado/shared-ts types; instead these are kept by hand and
// `liveTypes.sync.test.ts` reads the schema and fails if a kind, stage or field
// drifts -- the same guardrail events.phase-sync.test.ts gives narration phases.

export const STAGE_NAMES = [
  'parse',
  'draft',
  'improve',
  'summarize',
  'skeleton',
  'map',
  'write',
  'score',
  'link',
  'dedup',
  'write_ado',
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const PROGRESS_UNITS = ['figures', 'pages', 'items', 'sections', 'requirements', 'passes'] as const;
export type ProgressUnit = (typeof PROGRESS_UNITS)[number];

export const LIVE_KINDS = ['working_on', 'writing', 'item', 'compare', 'ocr_page', 'reset'] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];

export const COMPARE_KINDS = ['conflict', 'duplicate'] as const;
export type CompareKind = (typeof COMPARE_KINDS)[number];

export const IN_FLIGHT_KINDS = ['working_on', 'writing', 'ocr_page'] as const;
export type InFlightKind = (typeof IN_FLIGHT_KINDS)[number];

export const NOTICE_KINDS = ['output_limit_reached', 'server_retry', 'context_assumed', 'stream_fallback'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const NOTICE_SEVERITIES = ['info', 'warning'] as const;
export type NoticeSeverity = (typeof NOTICE_SEVERITIES)[number];

export interface ProgressEvent {
  type: 'progress';
  seq: number;
  pct: number;
  stage: StageName;
  unit: ProgressUnit;
  done: number;
  total: number;
  estimated: boolean;
  emittedAt: string;
}

export interface CompareSide {
  ref: string;
  text: string;
}

export interface ComparePayload {
  kind: CompareKind;
  a: CompareSide;
  b: CompareSide;
  similarity: number;
}

export interface LiveFrame {
  type: 'live';
  seq: number;
  lane: number;
  kind: LiveKind;
  ref?: string | null;
  title?: string | null;
  itemType?: string | null;
  excerpt?: string | null;
  cursor?: number | null;
  partial?: boolean;
  compare?: ComparePayload | null;
  page?: number | null;
  pages?: number | null;
  emittedAt: string;
}

/** A condition that changed what the run produced or how long it took (B12). Numbers and short enums only. */
export interface Notice {
  type: 'notice';
  id: string;
  kind: NoticeKind;
  severity: NoticeSeverity;
  /** Cumulative for the kind; a repeating kind is sent at spaced counts only. */
  count: number;
  facts: Record<string, string | number | boolean>;
  emittedAt: string;
}

export interface Heartbeat {
  type: 'heartbeat';
  at: string;
  idleSeconds: number;
  inFlight: { lane: number; kind: InFlightKind; ref?: string | null; title?: string | null }[];
}

export interface DocStats {
  words: number;
  blocks: number;
  headings: number;
  tables: number;
  tableRows: number;
  figures: number;
  pages: number | null;
}

export interface MapGroup {
  ref: string;
  title: string;
  kind: 'heading' | 'table';
  itemStart: number;
  itemCount: number;
  words: number;
}

export interface MapItem {
  ref: string;
  title: string;
  words: number;
  depth: number;
  type: string | null;
}

export interface DocumentMap {
  version: 1;
  unit: 'headings' | 'rows' | 'items';
  stats: DocStats;
  truncated: boolean;
  totalItems: number;
  groups: MapGroup[];
  items: MapItem[];
}
