import type { AdoLinkType } from '../domain/adoLinkTypes.js';

/**
 * Backend-agnostic contract for ADO work-item operations. `MockAdoBackend`
 * (this phase) and a future `RealAdoBackend` (Phase 7) both implement this,
 * so MCP tools never need to know which one is wired in.
 */
// req2ado's OWN internal, process-template-agnostic category vocabulary --
// NOT necessarily a real ADO work-item type name. Confirmed real bug: this
// was previously treated as if it WERE always the literal ADO type name
// (createWorkItem/discoverFields/readStates sent it straight into
// `_apis/wit/workitemtypes/$Epic` etc.), which only happens to work for a
// CMMI process template. Agile calls its Requirement-category type "User
// Story", Scrum calls it "Product Backlog Item", Basic calls it "Issue" --
// see WorkItemTypeCategoryMap below, which resolves this category to
// whichever real type name the TARGET PROJECT'S actual process template
// uses, via ADO's own universal work-item-type-categories concept (the same
// categorization Azure Boards' backlog levels use, identical across every
// process template family).
export type WorkItemType = 'Epic' | 'Feature' | 'Requirement';

export interface WorkItemRecord {
  id: number;
  // The REAL ADO type name (e.g. "User Story" on an Agile project) -- NOT
  // necessarily one of WorkItemType's 3 category labels. See WorkItemType's
  // own doc comment for why these are different things.
  type: string;
  fields: Record<string, string>;
  parentId: number | null;
}

export interface CreateWorkItemInput {
  // The REAL ADO type name for the target project, already resolved via
  // WorkItemTypeCategoryMap by the caller -- see WorkItemType's doc comment.
  type: string;
  fields: Record<string, string>;
}

// Maps req2ado's 3 internal category labels to the REAL work-item type name
// active for a given project's process template -- e.g. `{ Epic: "Epic",
// Feature: "Feature", Requirement: "User Story" }` on an Agile project.
// Resolved once via `_apis/wit/workitemtypecategories`, a category concept
// (Microsoft.EpicCategory/FeatureCategory/RequirementCategory) that exists
// identically across every process template (Agile/Scrum/CMMI/Basic/
// custom) -- confirmed against Microsoft's own docs: "Epics group Features,
// Features group Requirements (User Stories, Product Backlog Items,
// Issues, or Requirements)".
export interface WorkItemTypeCategoryMap {
  Epic: string;
  Feature: string;
  Requirement: string;
}

export interface AreaPathNode {
  path: string;
  children: AreaPathNode[];
}

export interface AdoProject {
  id: string;
  name: string;
}

export interface WorkItemTypeDefinition {
  name: string;
  // Hex, no leading '#' -- matches ADO's own wire format from
  // GET _apis/wit/workitemtypes. Callers that need CSS add the '#'.
  color: string;
  icon: { id: string; url: string };
}

export interface WorkItemIcon {
  contentType: string;
  dataBase64: string;
}

export interface AdoFieldDescriptor {
  referenceName: string;
  // Empty for a non-picklist field, or when the target org/api-version
  // doesn't honor the allowed-values expand at all -- an absent list and an
  // empty list are the same fact for every caller (never null).
  allowedValues: string[];
  alwaysRequired: boolean;
}

export interface AdoBackend {
  ping(): Promise<{ ok: true; backend: 'mock' | 'real' }>;
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord>;
  getWorkItem(id: number): Promise<WorkItemRecord | null>;
  /**
   * Bulk read, chunked at the backend's own batch size (config.batchSize,
   * real ADO's workitems-by-id endpoint accepts up to 200 per call) and
   * dispatched with bounded concurrency (config.concurrency) rather than
   * one getWorkItem call per id. Unknown ids are simply omitted from the
   * result (never throw for a partially-missing id list).
   */
  getWorkItemsBatch(ids: number[]): Promise<WorkItemRecord[]>;
  linkParentChild(childId: number, parentId: number): Promise<void>;
  /**
   * Adds a relation of the given referenceName from fromId to toId. Generic
   * primitive behind Phase 4's trace/coverage links (Covers/CoveredBy/
   * Affects/AffectedBy/etc.) — linkParentChild remains separate and
   * unchanged for the hierarchy link.
   */
  linkWorkItems(fromId: number, toId: number, referenceName: string): Promise<void>;
  /**
   * Exact-match field query, used for dedup/idempotency lookups (later phases) and tests here.
   * Note: this exact-full-match mock semantics diverges from the documented Phase 7
   * area-path-scoped dedup contract (docs/architecture.md) and will need revisiting then.
   * `project`, when supplied, overrides the backend's configured default --
   * same convention as readAreaPaths/readIterationPaths/readStates below,
   * needed so a caller whose area path belongs to a different project than
   * the server's configured default still queries the right project.
   */
  queryIds(fieldMatch: Record<string, string>, project?: string): Promise<number[]>;
  /**
   * Returns the field reference names available on a given work-item type —
   * real backing for docs/architecture.md's "Customer ID Field Resolution"
   * candidate-list algorithm (Phase 4/7). The priority-list matching logic
   * itself lives in the caller (see Task 9's write-back driver), not here.
   */
  discoverFields(workItemType: string): Promise<string[]>;
  /**
   * Same field-discovery scope as discoverFields, but with each field's
   * picklist metadata included -- the missing capability that previously
   * forced callers writing to a picklist-constrained field (e.g.
   * Microsoft.VSTS.CMMI.RequirementType) to either skip it or risk a 400 on
   * any org whose allowed values didn't match an assumed taxonomy. A
   * sibling to discoverFields, not a replacement -- existing callers that
   * only need field names keep using the cheaper call.
   */
  discoverFieldsDetailed(workItemType: string): Promise<AdoFieldDescriptor[]>;
  /** Updates (merges) fields on an existing work item without changing its type or parent link. */
  setFields(id: number, fields: Record<string, string>): Promise<void>;
  /**
   * Reads the ADO classification-node area-path tree, nested to `depth`
   * levels. `project`, when supplied, overrides the backend's configured
   * default project (config.adoProject) for this call only.
   */
  readAreaPaths(depth: number, project?: string): Promise<AreaPathNode>;
  /**
   * Reads the ADO classification-node iteration-path tree, nested to `depth`
   * levels -- same shape and same endpoint family as readAreaPaths, against
   * `_apis/wit/classificationnodes/iterations` instead of `/areas`.
   */
  readIterationPaths(depth: number, project?: string): Promise<AreaPathNode>;
  /**
   * Lists the workflow states defined for a work-item type on the target
   * project's process template (e.g. CMMI Requirement:
   * Proposed/Active/Resolved/Closed) -- real backing for a state picker
   * instead of the hardcoded 'Proposed' default. `project` optionally
   * overrides the server's configured default project, matching
   * readAreaPaths/readIterationPaths/discoverWorkItemTypes's own optional
   * override -- a process template's states can genuinely differ between
   * projects, so a picker scoped to the wrong project silently shows the
   * wrong states.
   */
  readStates(workItemType: string, project?: string): Promise<string[]>;
  /** Lists ADO team projects in the org (collection-level, not project-scoped). */
  discoverProjects(): Promise<AdoProject[]>;
  /**
   * Discovers the work-item link types available on the target ADO project's
   * process template (Phase 4's trace/coverage link feature). Real backend:
   * live REST call with a seed-catalog fallback on failure. Mock backend:
   * always returns the seed catalog — good enough to exercise the tool
   * contract without a real ADO server.
   */
  discoverLinkTypes(): Promise<AdoLinkType[]>;
  /**
   * Lists work-item types defined by the target project's actual process
   * template (Agile/CMMI/Scrum/Basic/custom), each with its real color and
   * icon reference -- replaces the hardcoded Epic/Feature/Requirement color
   * map in the frontend's WorkItemTypeBadge/clause-spine chip.
   */
  discoverWorkItemTypes(project?: string): Promise<WorkItemTypeDefinition[]>;
  /**
   * Resolves req2ado's 3 internal category labels (Epic/Feature/Requirement
   * -- see WorkItemType's own doc comment) to the real work-item type name
   * this project's actual process template uses for each, via ADO's
   * universal work-item-type-categories concept. Every caller that needs to
   * send a work-item type name to ADO (createWorkItem, discoverFields,
   * readStates) must translate through this first -- passing our internal
   * category label straight through only happens to work for CMMI.
   */
  discoverWorkItemTypeCategories(project?: string): Promise<WorkItemTypeCategoryMap>;
  /**
   * Fetches the icon image bytes for a given icon id + color (both as
   * returned by discoverWorkItemTypes). Server-scoped endpoint (not
   * project-scoped) on real ADO. Base64-encoded since MCP tool results are
   * text-only; the orchestrator decodes and re-serves as a real image
   * response.
   */
  getWorkItemIcon(iconId: string, color: string): Promise<WorkItemIcon>;
  /**
   * Uploads a figure's bytes as an ADO attachment and links it to the given
   * work item -- the item 20d "attach the figure this requirement cites"
   * feature (JobFigureFile, orchestrator-side). Two real ADO calls under
   * one operation, same reasoning as linkParentChild wrapping a single
   * relations/- patch: the caller (confirm()) only cares that the figure
   * ends up attached, not the two-step REST mechanics. `dataBase64` mirrors
   * getWorkItemIcon's convention (MCP tool results are text-only).
   */
  uploadAttachment(workItemId: number, fileName: string, dataBase64: string, mimeType: string): Promise<void>;
}
