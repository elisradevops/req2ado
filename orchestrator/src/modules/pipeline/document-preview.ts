import type { CanonicalDoc, WorkItemTree } from '@req2ado/shared-ts';
import { buildDocumentMap } from './document-map';
import { computeDeterministicCaveat, type DocumentOverview } from './document-overview.service';
import {
  buildDocumentProfile,
  composeProfileLines,
  composeStructureHint,
  summarizeBaselineTree,
  type BaselineTreeShape,
  type DocumentProfile,
} from './document-profile';

/** How long the preview waits for the baseline tree before it shows the overview without it. */
export const BASELINE_PREVIEW_MS = 8_000;

type LevelCall = (
  doc: CanonicalDoc,
  mode: 'baseline',
  userId?: string,
  linkTypeCatalog?: undefined,
  model?: undefined,
  jobId?: undefined,
  primerContext?: undefined,
  scored?: undefined,
  signal?: AbortSignal,
) => Promise<WorkItemTree>;

interface Warn {
  warn(message: string): void;
}

/**
 * What the baseline parser (deterministic, no model) builds from the parsed document. Optional: the overview is shown at once without it when
 * ingestion is slow or down, so this is bounded, cancels its request at the bound, and never throws.
 */
/**
 * What the baseline build left out as front matter (ingestion's document layout: cover, notices, revision history, contents, abbreviations, anything
 * before the first numbered section), read off its `front_matter_left_out` warning. `titleBlockId` is the cover's title, kept as the document's title.
 */
export interface LeftOut {
  parts: { text: string; page: number | null }[];
  pages: number[];
  blockIds: string[];
  tableIds: string[];
  titleBlockId: string | null;
}

export function leftOutOf(tree: Pick<WorkItemTree, 'warnings'>): LeftOut | undefined {
  const warning = (tree.warnings ?? []).find((w) => w.kind === 'front_matter_left_out');
  const detail = (warning?.detail ?? null) as Record<string, unknown> | null;
  if (!detail) return undefined;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  const parts = Array.isArray(detail.parts)
    ? detail.parts.flatMap((p) => {
        const part = p as { text?: unknown; page?: unknown };
        return typeof part?.text === 'string' ? [{ text: part.text, page: typeof part.page === 'number' ? part.page : null }] : [];
      })
    : [];
  return {
    parts,
    pages: Array.isArray(detail.pages) ? detail.pages.filter((p): p is number => typeof p === 'number') : [],
    blockIds: strings(detail.blockIds),
    tableIds: strings(detail.tableIds),
    titleBlockId: typeof detail.titleBlockId === 'string' ? detail.titleBlockId : null,
  };
}

/** `doc` without what the baseline build left out as front matter (the title block, when there is one, becomes the document's title). */
export function withoutLeftOut(doc: CanonicalDoc, leftOut: LeftOut | undefined): CanonicalDoc {
  if (!leftOut) return doc;
  const blocks = new Set(leftOut.blockIds);
  const tables = new Set(leftOut.tableIds);
  return {
    ...doc,
    blocks: doc.blocks
      .filter((b) => !blocks.has(b.id))
      .map((b) => (b.id === leftOut.titleBlockId ? { ...b, kind: 'title' as typeof b.kind, heading_level: null } : b)),
    tables: doc.tables.filter((t) => !tables.has(t.id)),
  };
}

async function baselineTree(doc: CanonicalDoc, level: LevelCall, log?: Warn): Promise<WorkItemTree | undefined> {
  const abort = new AbortController();
  // The bound holds even when the call ignores its signal: the race below ends the wait, the abort stops a call that honours it.
  const bound = new Promise<never>((_resolve, reject) => {
    abort.signal.addEventListener('abort', () => reject(new Error('baseline tree preview timed out')));
  });
  bound.catch(() => undefined); // never an unhandled rejection when the call wins
  const timer = setTimeout(() => abort.abort(), BASELINE_PREVIEW_MS);
  try {
    return await Promise.race([level(doc, 'baseline', undefined, undefined, undefined, undefined, undefined, undefined, abort.signal), bound]);
  } catch (err) {
    log?.warn(`preview: the baseline tree is not shown (${abort.signal.aborted ? 'timed out' : err instanceof Error ? err.name : 'failed'})`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The wizard's step-3 overview of a parsed document: its lines, structure hint and profile, with the baseline tree when it could be had in time. */
export async function buildPreviewOverview(
  doc: CanonicalDoc,
  level: LevelCall,
  log?: Warn,
): Promise<{ overview: DocumentOverview & { profile: DocumentProfile }; leftOut?: LeftOut; content: CanonicalDoc }> {
  const tree = await baselineTree(doc, level, log);
  const leftOut = tree ? leftOutOf(tree) : undefined;
  // Read off the document's content only: the front matter the baseline build left out never shows as a section, a purpose or a glossary.
  const content = withoutLeftOut(doc, leftOut);
  const baselineTreeShape: BaselineTreeShape | undefined = tree ? summarizeBaselineTree(tree) : undefined;
  const profile: DocumentProfile = { ...buildDocumentProfile(content), ...(baselineTreeShape ? { baselineTree: baselineTreeShape } : {}) };
  const lines = composeProfileLines(profile);
  const headings = content.blocks.filter((b) => b.kind === 'heading');
  const depth = headings.reduce((most, b) => (typeof b.heading_level === 'number' ? Math.max(most, b.heading_level) : most), 0);
  return {
    overview: {
      synopsis: lines.join(' '),
      caveat: computeDeterministicCaveat(headings.length, depth, buildDocumentMap(content.blocks)),
      lines,
      structureHint: composeStructureHint(profile),
      profile,
    },
    ...(leftOut ? { leftOut } : {}),
    content,
  };
}

/** How long a batch SURVEY file's overview parse may take: well inside BATCH_SUBMIT_STUCK_MS, so a claimed file is never reclaimed meanwhile. */
export const FILE_OVERVIEW_PARSE_MS = 60_000;

/**
 * The same overview for a file that had no wizard (a batch SURVEY file): one bounded parse of its bytes (vision skipped, as in /jobs/preview),
 * the counts read the way /jobs/preview reads them, then buildPreviewOverview. Throws on a failed or timed-out parse; the caller fails open.
 */
export async function buildFileOverview(
  fileBuffer: Buffer,
  filename: string,
  ingest: (fileBuffer: Buffer, filename: string, signal: AbortSignal) => Promise<CanonicalDoc>,
  level: LevelCall,
  log?: Warn,
): Promise<DocumentOverview & { profile: DocumentProfile }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FILE_OVERVIEW_PARSE_MS);
  let doc: CanonicalDoc;
  try {
    doc = await ingest(fileBuffer, filename, abort.signal);
  } finally {
    clearTimeout(timer);
  }
  return (await buildPreviewOverview(doc, level, log)).overview;
}
