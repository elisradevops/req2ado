import type { CanonicalDoc, WorkItemTree } from '@req2ado/shared-ts';
import type { DocumentMapSection } from './document-map';
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
async function baselineTreeShape(doc: CanonicalDoc, level: LevelCall, log?: Warn): Promise<BaselineTreeShape | undefined> {
  const abort = new AbortController();
  // The bound holds even when the call ignores its signal: the race below ends the wait, the abort stops a call that honours it.
  const bound = new Promise<never>((_resolve, reject) => {
    abort.signal.addEventListener('abort', () => reject(new Error('baseline tree preview timed out')));
  });
  bound.catch(() => undefined); // never an unhandled rejection when the call wins
  const timer = setTimeout(() => abort.abort(), BASELINE_PREVIEW_MS);
  try {
    return summarizeBaselineTree(await Promise.race([level(doc, 'baseline', undefined, undefined, undefined, undefined, undefined, undefined, abort.signal), bound]));
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
  counts: { sectionCount: number; depth: number; documentMap: DocumentMapSection[] },
  log?: Warn,
): Promise<DocumentOverview & { profile: DocumentProfile }> {
  const baselineTree = await baselineTreeShape(doc, level, log);
  const profile: DocumentProfile = { ...buildDocumentProfile(doc), ...(baselineTree ? { baselineTree } : {}) };
  const lines = composeProfileLines(profile);
  return {
    synopsis: lines.join(' '),
    caveat: computeDeterministicCaveat(counts.sectionCount, counts.depth, counts.documentMap),
    lines,
    structureHint: composeStructureHint(profile),
    profile,
  };
}
