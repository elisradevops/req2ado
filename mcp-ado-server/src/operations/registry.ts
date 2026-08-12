import { z, type ZodRawShape } from 'zod';
import type { AdoBackend } from '../backends/types.js';
import { adoErrorMessage } from '../backends/adoErrorMessage.js';

/**
 * Framework-agnostic operation definition: the single source of truth for an
 * ADO backend operation's name, input schema, and handler. src/rest/router.ts
 * builds mcp-ado-server's entire REST API from this list (S9's MCP → REST
 * cutover — this used to also back 16 near-identical MCP SDK tool
 * registrations under src/tools/*.ts; that duplication is gone along with
 * the MCP transport itself, deleted once the REST cutover was live-verified).
 */
export interface AdoOperation<TInput = any, TOutput = any> {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape (not a ZodObject) — src/rest/router.ts wraps it in z.object() for body validation. */
  inputSchema: ZodRawShape;
  handler: (backend: AdoBackend, input: TInput) => Promise<TOutput>;
}

/**
 * Every operation now goes through adoErrorMessage, not just the 4
 * (createWorkItem/getWorkItemsBatch/setFields/linkParentChild) that
 * previously wrapped it ad hoc. Bug found while consolidating into this
 * registry: the other 12 tools call the same axios-backed ADO REST client
 * and can equally hit a 400 with a useful TF400xxx detail in
 * error.response.data — they were just as exposed to axios's generic
 * "Request failed with status code 400" as createWorkItem was before that
 * wrapping was added (see adoErrorMessage's own doc comment). Applying it
 * uniformly here both fixes that gap and removes the need for a per-op flag.
 */
async function callBackend<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(adoErrorMessage(error));
  }
}

export const adoOperations: AdoOperation[] = [
  {
    name: 'ado_ping',
    title: 'Ping the ADO backend',
    description: 'Returns which backend (mock|real) is wired in and confirms it is reachable.',
    inputSchema: {},
    handler: (backend) => callBackend(() => backend.ping()),
  },
  {
    name: 'ado_create_work_item',
    title: 'Create an ADO work item',
    description:
      'Creates a new work item of the given type with the given fields. Does not link a parent — use ado_link_parent_child separately. `type` must be the REAL ADO type name for this project (resolve via ado_discover_work_item_type_categories first, not req2ado\'s internal Epic/Feature/Requirement labels) -- process templates other than CMMI use different real names (e.g. "User Story").',
    inputSchema: { type: z.string(), fields: z.record(z.string()) },
    handler: (backend, { type, fields }: { type: string; fields: Record<string, string> }) =>
      callBackend(() => backend.createWorkItem({ type, fields })),
  },
  {
    name: 'ado_link_parent_child',
    title: 'Link a child work item to its parent',
    description: 'Adds a System.LinkTypes.Hierarchy-Reverse relation from childId to parentId.',
    inputSchema: { childId: z.number(), parentId: z.number() },
    handler: (backend, { childId, parentId }: { childId: number; parentId: number }) =>
      callBackend(() => backend.linkParentChild(childId, parentId)).then(() => ({ ok: true })),
  },
  {
    name: 'ado_link_work_items',
    title: 'Link two work items with an arbitrary relation type',
    description:
      'Adds a relation of the given referenceName (e.g. a Covers/CoveredBy/Affects/' +
      'AffectedBy reference name from ado_discover_link_types) from fromId to toId.',
    inputSchema: { fromId: z.number(), toId: z.number(), referenceName: z.string() },
    handler: (backend, { fromId, toId, referenceName }: { fromId: number; toId: number; referenceName: string }) =>
      callBackend(() => backend.linkWorkItems(fromId, toId, referenceName)).then(() => ({ ok: true })),
  },
  {
    name: 'ado_set_fields',
    title: 'Set fields on an existing ADO work item',
    description: 'Merges the given fields onto an existing work item without changing its type or parent link.',
    inputSchema: { id: z.number(), fields: z.record(z.string()) },
    handler: (backend, { id, fields }: { id: number; fields: Record<string, string> }) =>
      callBackend(() => backend.setFields(id, fields)).then(() => ({ ok: true })),
  },
  {
    name: 'ado_query_ids',
    title: 'Query work item ids by exact field match',
    description:
      'Returns ids of work items whose fields exactly match every key/value pair given (System.AreaPath matches the whole subtree via WIQL UNDER, not just an exact node). Used for dedup/idempotency lookups. `project`, when supplied, overrides the server-configured default project.',
    inputSchema: { fieldMatch: z.record(z.string()), project: z.string().optional() },
    handler: (backend, { fieldMatch, project }: { fieldMatch: Record<string, string>; project?: string }) =>
      callBackend(() => backend.queryIds(fieldMatch, project)),
  },
  {
    name: 'ado_get_work_items_batch',
    title: 'Bulk-read ADO work items by id',
    description:
      "Reads multiple work items by id in one call, chunked at the backend's configured batch size with bounded concurrency. Unknown ids are simply omitted from the result.",
    inputSchema: { ids: z.array(z.number()) },
    handler: (backend, { ids }: { ids: number[] }) => callBackend(() => backend.getWorkItemsBatch(ids)),
  },
  {
    name: 'ado_discover_fields',
    title: 'Discover ADO work-item type fields',
    description:
      'Returns the field reference names available on a given work-item type. Used by callers to resolve the correct Customer ID field ref name against a runtime-verified candidate list (see docs/architecture.md "Customer ID Field Resolution"). workItemType must be the REAL ADO type name for this project (resolve via ado_discover_work_item_type_categories first, not req2ado\'s internal Epic/Feature/Requirement labels) -- process templates other than CMMI use different real names (e.g. "User Story").',
    inputSchema: { workItemType: z.string() },
    handler: (backend, { workItemType }: { workItemType: string }) => callBackend(() => backend.discoverFields(workItemType)),
  },
  {
    name: 'ado_read_area_paths',
    title: 'Read ADO area paths',
    description: 'Returns the nested area-path tree for the configured project, used to populate a real area-path picker instead of free text.',
    inputSchema: { depth: z.number().int().min(1).max(10).default(5), project: z.string().optional() },
    handler: (backend, { depth, project }: { depth: number; project?: string }) => callBackend(() => backend.readAreaPaths(depth, project)),
  },
  {
    name: 'ado_read_iteration_paths',
    title: 'Read ADO iteration paths',
    description:
      'Returns the nested iteration-path (sprint) tree for the configured project, used to populate a real iteration-path picker instead of free text.',
    inputSchema: { depth: z.number().int().min(1).max(10).default(5), project: z.string().optional() },
    handler: (backend, { depth, project }: { depth: number; project?: string }) =>
      callBackend(() => backend.readIterationPaths(depth, project)),
  },
  {
    name: 'ado_read_states',
    title: 'Read ADO work-item states',
    description:
      'Returns the workflow states defined for a work-item type on the process template, used to populate a real initial-state picker instead of a hardcoded default. workItemType must be the REAL ADO type name for this project (resolve via ado_discover_work_item_type_categories first, not req2ado\'s internal Epic/Feature/Requirement labels).',
    inputSchema: { workItemType: z.string(), project: z.string().optional() },
    handler: (backend, { workItemType, project }: { workItemType: string; project?: string }) =>
      callBackend(() => backend.readStates(workItemType, project)),
  },
  {
    name: 'ado_discover_projects',
    title: 'Discover ADO team projects',
    description: 'Returns the list of ADO team projects in the org, used to populate a project picker before area-path/field selection.',
    inputSchema: {},
    handler: (backend) => callBackend(() => backend.discoverProjects()),
  },
  {
    name: 'ado_discover_link_types',
    title: 'Discover ADO work-item link types',
    description:
      "Returns the work-item link types (referenceName/name/semanticHint) available on the target project's process template. Used to resolve trace/coverage link types (Covers/CoveredBy/Affects/AffectedBy/etc.) at runtime instead of hardcoding them.",
    inputSchema: {},
    handler: (backend) => callBackend(() => backend.discoverLinkTypes()),
  },
  {
    name: 'ado_discover_work_item_types',
    title: 'Discover ADO work-item types',
    description:
      "Returns the work-item types defined by the target project's actual process template (Agile/CMMI/Scrum/Basic/custom), each with its real color and icon reference. Replaces a hardcoded Epic/Feature/Requirement color assumption.",
    inputSchema: { project: z.string().optional() },
    handler: (backend, { project }: { project?: string }) => callBackend(() => backend.discoverWorkItemTypes(project)),
  },
  {
    name: 'ado_discover_work_item_type_categories',
    title: 'Discover ADO work-item type categories',
    description:
      'Resolves req2ado\'s 3 internal category labels (Epic/Feature/Requirement) to the REAL work-item type name the target project\'s actual process template uses for each -- e.g. Agile\'s Requirement-category type is "User Story", Scrum\'s is "Product Backlog Item", CMMI\'s is "Requirement". Every caller that needs to send a work-item type name to ADO (ado_create_work_item, ado_discover_fields, ado_read_states) must translate through this first.',
    inputSchema: { project: z.string().optional() },
    handler: (backend, { project }: { project?: string }) => callBackend(() => backend.discoverWorkItemTypeCategories(project)),
  },
  {
    name: 'ado_get_work_item_icon',
    title: 'Get ADO work-item icon',
    description:
      'Fetches the icon image for a work-item type (icon id + color from ado_discover_work_item_types) as base64. Server-scoped, not project-scoped.',
    inputSchema: { iconId: z.string(), color: z.string() },
    handler: (backend, { iconId, color }: { iconId: string; color: string }) => callBackend(() => backend.getWorkItemIcon(iconId, color)),
  },
  {
    name: 'ado_upload_attachment',
    title: 'Upload and attach a file to an ADO work item',
    description:
      'Uploads the given bytes (base64) as an ADO attachment and links it to the work item, e.g. a figure a requirement cites (JobFigureFile). Two real ADO calls under one operation: attachments, then a relations/- patch with rel=AttachedFile.',
    inputSchema: { workItemId: z.number(), fileName: z.string(), dataBase64: z.string(), mimeType: z.string() },
    handler: (
      backend,
      { workItemId, fileName, dataBase64, mimeType }: { workItemId: number; fileName: string; dataBase64: string; mimeType: string },
    ) => callBackend(() => backend.uploadAttachment(workItemId, fileName, dataBase64, mimeType)).then(() => ({ ok: true })),
  },
];

export function getOperation(name: string): AdoOperation | undefined {
  return adoOperations.find((op) => op.name === name);
}
