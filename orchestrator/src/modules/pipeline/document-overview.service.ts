import { Injectable } from '@nestjs/common';
import { OpenWebUiClient } from '../llm/openwebui.client';
import type { DocumentMapSection } from './document-map';

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

const SYNOPSIS_SYSTEM_PROMPT = `You are summarizing a requirements/interface document for an engineer who is about to review an AI-generated breakdown of it. Given a list of its real section headings, write ONE short paragraph (2-4 sentences) that:
1. States what kind of document this is and what system/subject it specifically covers -- be concrete, not generic.
2. Ends with one sentence describing what to expect from processing it (roughly how many discrete requirements, across how many sections).
Do not mention structural concerns, formatting, or how deep/fragmented the document is -- that is handled separately. Respond with the paragraph only, no heading, no preamble.`;

@Injectable()
export class DocumentOverviewService {
  constructor(private readonly llmClient: OpenWebUiClient) {}

  async generate(input: { documentMap: DocumentMapSection[]; sectionCount: number; depth: number }): Promise<DocumentOverview | null> {
    const caveat = computeDeterministicCaveat(input.sectionCount, input.depth, input.documentMap);
    const headingList = input.documentMap
      .map((section) => (section.number ? `${section.number} ${section.title}` : section.title))
      .join('\n');
    try {
      const result = await this.llmClient.chat(
        [
          { role: 'system', content: SYNOPSIS_SYSTEM_PROMPT },
          { role: 'user', content: `Real section headings, in document order:\n\n${headingList}` },
        ],
        { seed: 42, maxTokens: 300 },
      );
      const synopsis = result.content.trim();
      if (!synopsis) return null;
      return { synopsis, caveat };
    } catch {
      return null;
    }
  }
}
