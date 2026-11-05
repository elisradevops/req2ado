/* eslint-disable */
/**
 * This file was automatically generated from shared/schemas/document-overview.schema.json.
 * DO NOT EDIT — run `pnpm --filter @req2ado/shared-ts generate` instead.
 */

/**
 * The wizard's step-3 overview of a document, made from its parsed text and structure alone (orchestrator/src/modules/pipeline/document-profile.ts, no model). Sent back with the job (SURVEY only) and stored in Job.documentOverview. Single source of truth - the orchestrator's TS type is generated from this file (shared/ts, `pnpm generate`); the frontend's hand-written copy in frontend/src/api/jobs.ts must match it. Bounds are enforced where a browser submits it (parseDocumentOverview).
 */
export interface DocumentOverview {
  /**
   * The lines joined into one paragraph: what an older client, or a job stored before `lines` existed, shows.
   */
  synopsis: string;
  /**
   * A warning about a deeply nested or fragmented heading structure, or null.
   */
  caveat: string | null;
  /**
   * What step 3 and the job page show, one entry per line, each read off the document's text and structure.
   *
   * @maxItems 40
   */
  lines?: string[];
  /**
   * The optional AI summary the wizard showed (written by a model from the document's headings and opening text, checked against that input), kept so the job page can show it. One paragraph. Absent when it was not ready when the job started.
   */
  aiSummary?: string;
  /**
   * How the file is built, for the SURVEY job's AI stage (appended to its document context). One line, no control characters. Carried to the job, never shown.
   */
  structureHint?: string;
}
