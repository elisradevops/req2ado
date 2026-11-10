/* eslint-disable */
/**
 * This file was automatically generated from shared/schemas/write-preview.schema.json.
 * DO NOT EDIT — run `pnpm --filter @req2ado/shared-ts generate` instead.
 */

/**
 * What a write would do for a job's diff right now (GET/POST /jobs/:id/write-preview). Single source of truth - the orchestrator computes it (orchestrator/src/modules/pipeline/write-plan.ts buildWritePreview, the same select* functions confirm() uses) and the TS types are generated from this file (shared/ts, `pnpm generate`); the frontend only phrases these numbers and re-implements no write rule. Checked against buildWritePreview's output keys by orchestrator/test/write-preview.contract.spec.ts.
 */
export interface WritePreview {
  createdTotal: number;
  /**
   * The local ids of the items that will be created, so a caller can relate its own per-item facts (such as how each was reviewed) to the write.
   */
  createdLocalIds: string[];
  createdByType: {
    [k: string]: number;
  };
  /**
   * Entries the reviewer excluded, and entries dropped because an ancestor was excluded.
   */
  excluded: {
    direct: number;
    viaAncestor: number;
  };
  /**
   * New parent links that will be written.
   */
  parentLinks: number;
  /**
   * Distinct existing parents (resolved to an ADO id by this job's reuse/dedup_skip) of entries that get a new parent link. A resumed-only parent is not counted.
   */
  existingGettingChildren: number;
  /**
   * Non-excluded entries that resolved to an existing ADO id AND have a parent. A root existing entry is not counted.
   */
  existingWithoutNewParentLink: number;
  /**
   * Trace links: written, and declared but not written (target excluded, not created, or unresolved).
   */
  traceLinks: {
    planned: number;
    skipped: number;
  };
  /**
   * Non-excluded items of this job already in Azure DevOps from an earlier attempt. Deliberately NOT limited to the current selection.
   */
  alreadyWritten: number;
  /**
   * Figure attachments confirm() would still upload (figures whose file is still stored, on items this job creates or resumes).
   */
  figuresToAttach: number;
  /**
   * Figures of entries this job creates that have no stored file (failed to store, or removed by retention), so they will not be attached.
   */
  figuresUnavailable: number;
  /**
   * Whether a write would do anything at all: create, link, trace-link or attach. Computed by the server (planHasWork).
   */
  hasWork: boolean;
  /**
   * Only figures are left: nothing is created and no link is added, but figures are still attached to their items. Computed by the server.
   */
  figuresOnly: boolean;
}
