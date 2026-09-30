import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenWebUiClientFactory } from '../llm/openwebui-client.factory';
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

// Caps the number of headings sent to the LLM in the prompt -- the plan's
// own reference document had 543 flat heading rows, and an unbounded join
// risks overflowing the model's context on a sufficiently large/fragmented
// document. 150 comfortably covers the vast majority of real documents
// while staying well within typical context budgets; anything beyond that
// is summarized as a trailing count rather than dropped silently.
const MAX_HEADINGS_IN_PROMPT = 150;

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
  constructor(
    private readonly clientFactory: OpenWebUiClientFactory,
    private readonly configService: ConfigService,
  ) {}

  // userId resolves this call's Open WebUI client -- a user with no
  // connection configured yet falls into the same catch block below and
  // returns null, matching this feature's existing fail-open contract
  // (the exposition synopsis is a nice-to-have preview, never a blocker).
  async generate(input: { documentMap: DocumentMapSection[]; sectionCount: number; depth: number }, userId: string): Promise<DocumentOverview | null> {
    try {
      const llmClient = await this.clientFactory.getClientFor(userId);
      const caveat = computeDeterministicCaveat(input.sectionCount, input.depth, input.documentMap);
      const headings = input.documentMap
        .slice(0, MAX_HEADINGS_IN_PROMPT)
        .map((section) => (section.number ? `${section.number} ${section.title}` : section.title));
      const remaining = input.documentMap.length - headings.length;
      const headingList =
        remaining > 0 ? [...headings, `…and ${remaining} more sections`].join('\n') : headings.join('\n');
      const result = await llmClient.chat(
        [
          { role: 'system', content: SYNOPSIS_SYSTEM_PROMPT },
          { role: 'user', content: `Real section headings, in document order:\n\n${headingList}` },
        ],
        // think: false -- a reasoning-capable model otherwise burns the
        // entire maxTokens budget on hidden chain-of-thought and returns
        // empty content (confirmed live against qwen3.6:35b: finish_reason
        // "length", content "", 300/300 completion tokens all reasoning).
        // This is a plain structured single-paragraph summary with no need
        // for multi-step reasoning, matching this codebase's own established
        // use of think: false for exactly this class of call.
        //
        // maxTokens: confirmed live in production (this deployment) that
        // think:false alone is NOT sufficient here -- LLM_SEND_REASONING_EFFORT
        // is globally false in this deployment, so `think` never actually
        // reaches the backend as `reasoning_effort`, and a reasoning-capable
        // model can still exhaust the budget on hidden chain-of-thought
        // (real production log: finishReason=length at the previous 300
        // default). DOCUMENT_OVERVIEW_MAX_TOKENS (config.schema.ts) is a
        // reasoned estimate, not empirically proven sufficient for every
        // model -- configurable so it can be retuned without a code change.
        { seed: 42, maxTokens: this.configService.get<number>('DOCUMENT_OVERVIEW_MAX_TOKENS')!, think: false },
      );
      const synopsis = result.content.trim();
      if (!synopsis) {
        // Distinct from the catch below -- this is a genuine 200 response
        // with empty content, not a thrown error. Known real cause: a
        // reasoning-capable model burns the entire maxTokens budget on
        // hidden chain-of-thought and returns empty content (same failure
        // class OpenWebUiClient.vision()'s own think:false handling exists
        // for) -- worth distinguishing from a thrown exception, since this
        // fail-open path previously gave no signal at all which case
        // happened.
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        console.error(`DocumentOverviewService.generate: model returned empty content for user ${userId} (finishReason=${result.finishReason ?? 'unknown'})`);
        return null;
      }
      return { synopsis, caveat };
    } catch (err) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`DocumentOverviewService.generate failed for user ${userId}:`, err);
      return null;
    }
  }
}
