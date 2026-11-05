import type { DocumentOverview } from '@req2ado/shared-ts';
import type { DocumentMapSection } from './document-map';
import { sanitizeHint } from './document-profile';

// The shape is the shared contract (shared/schemas/document-overview.schema.json); the frontend keeps a matching hand-written copy.
export type { DocumentOverview };

// Thresholds tuned against a real, deeply fragmented ICD used throughout
// this feature's own design review (79 top-level sections' worth of
// headings collapsed into 543 flat rows, max depth 5, per-section
// blockCount ranging 0-37) -- see docs/superpowers/specs/2026-08-30-pre-
// job-document-exposition-design.md. Deliberately NOT model-decided: the
// caveat must never depend on the LLM choosing to raise a concern.
const DEEP_NESTING_DEPTH_THRESHOLD = 4;
const FRAGMENTED_MIN_SECTION_COUNT = 30;
const FRAGMENTED_TINY_SECTION_FRACTION = 0.4;
const TINY_SECTION_BLOCK_COUNT = 2;

const CAVEAT_TEXT =
  "This document's heading structure is unusually deep and fragmented — many small sections sit alongside a few much larger ones. Worth a closer look to confirm nothing was misclassified.";

export function computeDeterministicCaveat(sectionCount: number, depth: number, documentMap: DocumentMapSection[]): string | null {
  const deepNesting = depth >= DEEP_NESTING_DEPTH_THRESHOLD;
  const tinySectionCount = documentMap.filter((section) => section.blockCount <= TINY_SECTION_BLOCK_COUNT).length;
  const fragmented = sectionCount >= FRAGMENTED_MIN_SECTION_COUNT && tinySectionCount / sectionCount >= FRAGMENTED_TINY_SECTION_FRACTION;
  return deepNesting || fragmented ? CAVEAT_TEXT : null;
}

const MAX_OVERVIEW_LINES = 40;
const MAX_OVERVIEW_LINE_CHARS = 2000;
const MAX_SYNOPSIS_CHARS = 8000;
const MAX_CAVEAT_CHARS = 1000;
const MAX_AI_SUMMARY_CHARS = 1500;

const points = (text: string): number => Array.from(text).length;
const cutPoints = (text: string, max: number): string => (points(text) <= max ? text : Array.from(text).slice(0, max).join(''));
const MAX_STRUCTURE_HINT_CHARS = 1000;

/**
 * The overview a browser submits with a job, read defensively: a malformed shape is no overview, never an error (job creation must not fail on it).
 * The lines are bounded, and the structure hint (it reaches a model prompt) is made one bounded line without control characters.
 */
export function parseDocumentOverview(raw: string | undefined): DocumentOverview | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.synopsis !== 'string') return null;
  const lines = value.lines;
  const goodLines = Array.isArray(lines) && lines.length <= MAX_OVERVIEW_LINES && lines.every((l) => typeof l === 'string' && points(l) <= MAX_OVERVIEW_LINE_CHARS);
  return {
    synopsis: cutPoints(value.synopsis, MAX_SYNOPSIS_CHARS),
    caveat: typeof value.caveat === 'string' ? cutPoints(value.caveat, MAX_CAVEAT_CHARS) : null,
    ...(goodLines ? { lines: lines as string[] } : {}),
    // A model's paragraph, shown to the reader as text only: one paragraph, no control characters, bounded.
    ...(typeof value.aiSummary === 'string' && value.aiSummary.trim() ? { aiSummary: sanitizeHint(value.aiSummary, MAX_AI_SUMMARY_CHARS) } : {}),
    ...(typeof value.structureHint === 'string' ? { structureHint: sanitizeHint(value.structureHint, MAX_STRUCTURE_HINT_CHARS) } : {}),
  };
}
