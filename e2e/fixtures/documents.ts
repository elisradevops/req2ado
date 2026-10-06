// What each of the four document kinds looks like to the live view: its map
// (counts and outline) and the stream of events a run over it produces. The
// shapes mirror shared/schemas/job-live.schema.json.

export type DocKind = 'docx' | 'spreadsheet' | 'pdf' | 'scanned';
export const DOC_KINDS: DocKind[] = ['docx', 'spreadsheet', 'pdf', 'scanned'];

export interface MapItem { ref: string; title: string; words: number; depth: number; type: string | null }
export interface DocMap {
  version: 1;
  unit: 'headings' | 'rows' | 'items';
  stats: { words: number; blocks: number; headings: number; tables: number; tableRows: number; figures: number; pages: number | null };
  truncated: boolean;
  totalItems: number;
  groups: { ref: string; title: string; kind: 'heading' | 'table'; itemStart: number; itemCount: number; words: number }[];
  items: MapItem[];
}

export interface DocFixture {
  kind: DocKind;
  filename: string;
  /** Null when the server would publish no outline-bearing map (text PDFs have no headings to qualify). */
  map: DocMap;
  /** Refs live frames use; empty for kinds with no outline. */
  refs: string[];
  /** The stage progress events report while this kind is being drafted. */
  stage: 'improve' | 'write' | 'parse';
  unit: 'items' | 'sections' | 'pages';
}

const ref = (sub: number, id: string): string => `det${sub}_${id.replace(/\./g, '_')}`;

function headingItems(): MapItem[] {
  const items: MapItem[] = [];
  for (let e = 1; e <= 2; e++) {
    items.push({ ref: ref(0, `${e}`), title: `Subsystem ${e}`, words: 12, depth: 0, type: 'Epic' });
    for (let f = 1; f <= 2; f++) {
      items.push({ ref: ref(0, `${e}.${f}`), title: `Function ${e}.${f}`, words: 8, depth: 1, type: 'Feature' });
      for (let r = 1; r <= 3; r++) {
        items.push({
          ref: ref(0, `${e}.${f}.${r}`),
          title: `The unit shall meet limit ${(e - 1) * 6 + (f - 1) * 3 + r} under condition ${r}.`,
          words: 24, depth: 2, type: 'Requirement',
        });
      }
    }
  }
  return items;
}

function rowItems(): MapItem[] {
  return Array.from({ length: 24 }, (_, i) => ({
    ref: ref(0, `R${i + 1}`), title: `Row R${i + 1}: input range ${i + 1} V`, words: 9, depth: i === 0 ? 0 : 1, type: 'Requirement',
  }));
}

const stats = (extra: Partial<DocMap['stats']>): DocMap['stats'] => ({
  words: 915, blocks: 88, headings: 0, tables: 0, tableRows: 0, figures: 0, pages: 4, ...extra,
});

export function fixtureFor(kind: DocKind): DocFixture {
  if (kind === 'docx') {
    const items = headingItems();
    return {
      kind, filename: 'synthetic-spec.docx', stage: 'improve', unit: 'items', refs: items.map((i) => i.ref),
      map: {
        version: 1, unit: 'headings', truncated: false, totalItems: items.length, items,
        stats: stats({ headings: 6, blocks: 88 }),
        groups: [{ ref: 'g0.0', title: 'Subsystem 1', kind: 'heading', itemStart: 0, itemCount: items.length, words: 300 }],
      },
    };
  }
  if (kind === 'spreadsheet') {
    const items = rowItems();
    return {
      kind, filename: 'requirements.xlsx', stage: 'improve', unit: 'items', refs: items.map((i) => i.ref),
      map: {
        version: 1, unit: 'rows', truncated: false, totalItems: items.length, items,
        stats: stats({ headings: 0, tables: 1, tableRows: 24, pages: null, words: 340, blocks: 1 }),
        groups: [{ ref: 'g0.0', title: 'Table t0', kind: 'table', itemStart: 0, itemCount: items.length, words: 216 }],
      },
    };
  }
  // A text PDF with no qualifying headings goes down the section path: counts, no outline.
  if (kind === 'pdf') {
    return {
      kind, filename: 'customer-spec.pdf', stage: 'write', unit: 'sections', refs: [],
      map: { version: 1, unit: 'items', truncated: false, totalItems: 0, items: [], groups: [], stats: stats({ pages: 18, words: 6400, blocks: 210, headings: 14 }) },
    };
  }
  return {
    kind, filename: 'scanned-contract.pdf', stage: 'parse', unit: 'pages', refs: [],
    map: { version: 1, unit: 'items', truncated: false, totalItems: 0, items: [], groups: [], stats: stats({ pages: 12, words: 3100, blocks: 40, figures: 12 }) },
  };
}

export type SseEvent = [type: string, data: unknown];

const at = (n: number): string => new Date(Date.UTC(2026, 9, 5, 10, 0, n)).toISOString();

export const stageEvent = (stage = 'infer_hierarchy_start'): SseEvent => ['stage', { stage }];

export const narrationEvent = (): SseEvent => [
  'narration',
  {
    type: 'narration', phase: 'deterministic_subtree', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
    kbGrounded: false, kbCitations: [], message: 'Extracting a deterministic hierarchy subtree (1 of 1)',
  },
];

export const progressEvent = (
  seq: number, pct: number, stage: string, unit: string, done: number, total: number,
): SseEvent => ['progress', { type: 'progress', seq, pct, stage, unit, done, total, estimated: true, emittedAt: at(seq) }];

export const liveEvent = (seq: number, lane: number, kind: string, extra: Record<string, unknown> = {}): SseEvent => [
  'live', { type: 'live', seq, lane, kind, emittedAt: at(seq), ...extra },
];

export const heartbeatEvent = (idleSeconds: number, inFlight: unknown[] = []): SseEvent => [
  'heartbeat', { type: 'heartbeat', at: at(0), idleSeconds, inFlight },
];

/** A few items finishing, with one in progress: what "going well" looks like for this kind. */
export function smoothScript(fx: DocFixture, from = 1): SseEvent[] {
  const events: SseEvent[] = [];
  let seq = from;
  if (fx.kind === 'scanned') {
    for (let page = 1; page <= 4; page++) {
      events.push(progressEvent(seq, 2 + page * 2, 'parse', 'pages', page, 12));
      events.push(liveEvent(seq + 1, 0, 'ocr_page', { page, pages: 12, excerpt: `Section ${page} Requirements ${page}.1 The scanned unit shall tolerate ${page * 10} volts.` }));
      seq += 2;
    }
    return events;
  }
  if (fx.refs.length === 0) {
    events.push(progressEvent(seq, 34, 'write', 'sections', 3, 9));
    events.push(liveEvent(seq + 1, 0, 'working_on', { title: 'Power budget', excerpt: 'The power budget for the platform shall not exceed 480 W in any operating mode.' }));
    return events;
  }
  const done = 5;
  for (let i = 0; i < done; i++) {
    events.push(liveEvent(seq++, 0, 'item', { ref: fx.refs[i], title: fx.map.items[i].title }));
  }
  events.push(progressEvent(seq++, 3 + done, fx.stage, 'items', done, fx.refs.length));
  events.push(liveEvent(seq++, 0, 'working_on', { ref: fx.refs[done], excerpt: `${fx.map.items[done].title} Measured at the connector, 25 C.` }));
  return events;
}

/** Three parts of the document being worked on at once. */
export function parallelScript(fx: DocFixture, from = 1): SseEvent[] {
  const seq = from;
  if (fx.kind === 'scanned' || fx.refs.length === 0) {
    return [
      progressEvent(seq, 40, fx.stage, fx.unit, 4, 12),
      liveEvent(seq + 1, 0, 'working_on', { title: 'Section 1', excerpt: 'First part of the document being read.' }),
      liveEvent(seq + 2, 1, 'working_on', { title: 'Section 2', excerpt: 'Second part, read at the same time.' }),
      liveEvent(seq + 3, 2, 'working_on', { title: 'Section 3', excerpt: 'Third part, also in parallel.' }),
    ];
  }
  return [
    progressEvent(seq, 30, fx.stage, 'items', 6, fx.refs.length),
    liveEvent(seq + 1, 0, 'working_on', { ref: fx.refs[2], excerpt: 'First part of the document.' }),
    liveEvent(seq + 2, 1, 'working_on', { ref: fx.refs[5], excerpt: 'Second part, at the same time.' }),
    liveEvent(seq + 3, 2, 'working_on', { ref: fx.refs[8], excerpt: 'Third part, also in parallel.' }),
  ];
}

/** Where the two conflicting statements sit in the outline (when the kind has one). */
export const CONFLICT_ITEMS = [2, 8];

/**
 * Two statements that disagree. For kinds with an outline the sides are real
 * items, so the view can name them by heading; otherwise they are known only by
 * an internal id, and the view must say "first" and "second statement".
 */
export function conflictFor(fx: DocFixture) {
  const [first, second] = CONFLICT_ITEMS;
  return {
    kind: 'conflict', similarity: 0.92,
    a: { ref: fx.refs[first] ?? 'det0_2_1', text: 'The power supply shall provide 500 W at 28 VAC input.' },
    b: { ref: fx.refs[second] ?? 'det0_9_4', text: 'The power supply shall provide 600 W at 28 VDC input.' },
  };
}

/** The accessible names of the two sides of `conflictFor(fx)`. */
export function conflictSideNames(fx: DocFixture): [string, string] {
  return fx.refs.length > 0
    ? [`Statement: ${fx.map.items[CONFLICT_ITEMS[0]].title}`, `Statement: ${fx.map.items[CONFLICT_ITEMS[1]].title}`]
    : ['First statement', 'Second statement'];
}

/** The existing work item is known by its Azure DevOps number. */
export const DUPLICATE = {
  kind: 'duplicate', similarity: 0.97,
  a: { ref: 'proposed', text: 'The unit shall regulate its output to within 1 percent over the full input range.' },
  b: { ref: '1001', text: 'The unit shall regulate its output to within 2 percent over the full input range.' },
};
