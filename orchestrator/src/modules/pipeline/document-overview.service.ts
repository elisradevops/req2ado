import { Injectable } from '@nestjs/common';
import type { DocumentMapSection } from './document-map';
import { IngestionHttpClient } from './ingestion-http.client';
import { composeOverviewText } from './overview-text';

export interface DocumentOverview {
  synopsis: string;
  caveat: string | null;
}

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

/**
 * The pre-job overview of a document ("Does this look right?"): what the document itself states, from a study of the document. The study is
 * ingestion's extractive reading (the same one the SURVEY job runs, so the job reuses its stored windows): every entry is copied from the document
 * and checked against the text, and the text here is composed in code from those facts. No model writes it, so it cannot describe what the document
 * does not say. A document the study could not read, or that gave it nothing to report, gets no overview.
 */
@Injectable()
export class DocumentOverviewService {
  constructor(private readonly ingestionClient: IngestionHttpClient) {}

  // Fail-open (the overview is a preview, never a blocker): any failure returns null. Only the error type is logged: a message can carry hosts.
  async generate(
    input: {
      file: { buffer: Buffer; originalname: string };
      documentMap: DocumentMapSection[];
      sectionCount: number;
      depth: number;
      model?: string;
      // The study's progress while it runs (windows read, seconds elapsed): what the wizard shows so a long wait does not look stuck.
      onProgress?: (progress: { done?: number; total?: number; elapsed: number }) => void;
      // Aborting stops the study (the browser left).
      signal?: AbortSignal;
    },
    userId: string,
  ): Promise<DocumentOverview | null> {
    try {
      const caveat = computeDeterministicCaveat(input.sectionCount, input.depth, input.documentMap);
      const result = await this.ingestionClient.studyOverview(input.file.buffer, input.file.originalname, userId, input.model, input.onProgress, input.signal);
      if (!result.read || !result.facts) return null;
      const synopsis = composeOverviewText(result.facts);
      return synopsis ? { synopsis, caveat } : null;
    } catch (err) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`DocumentOverviewService.generate failed: ${err instanceof Error ? err.name : typeof err}`);
      return null;
    }
  }
}
