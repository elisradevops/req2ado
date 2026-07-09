/**
 * Backend-agnostic contract for ADO work-item operations. `MockAdoBackend`
 * (this phase) and a future `RealAdoBackend` (Phase 7) both implement this,
 * so MCP tools never need to know which one is wired in.
 */
export type WorkItemType = 'Epic' | 'Feature' | 'Requirement';

export interface WorkItemRecord {
  id: number;
  type: WorkItemType;
  fields: Record<string, string>;
  parentId: number | null;
}

export interface CreateWorkItemInput {
  type: WorkItemType;
  fields: Record<string, string>;
}

export interface AreaPathNode {
  path: string;
  children: AreaPathNode[];
}

export interface AdoBackend {
  ping(): Promise<{ ok: true; backend: 'mock' | 'real' }>;
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord>;
  getWorkItem(id: number): Promise<WorkItemRecord | null>;
  linkParentChild(childId: number, parentId: number): Promise<void>;
  /**
   * Exact-match field query, used for dedup/idempotency lookups (later phases) and tests here.
   * Note: this exact-full-match mock semantics diverges from the documented Phase 7
   * area-path-scoped dedup contract (docs/architecture.md) and will need revisiting then.
   */
  queryIds(fieldMatch: Record<string, string>): Promise<number[]>;
  /**
   * Returns the field reference names available on a given work-item type —
   * real backing for docs/architecture.md's "Customer ID Field Resolution"
   * candidate-list algorithm (Phase 4/7). The priority-list matching logic
   * itself lives in the caller (see Task 9's write-back driver), not here.
   */
  discoverFields(workItemType: WorkItemType): Promise<string[]>;
  /** Updates (merges) fields on an existing work item without changing its type or parent link. */
  setFields(id: number, fields: Record<string, string>): Promise<void>;
  /** Reads the ADO classification-node area-path tree, nested to `depth` levels. */
  readAreaPaths(depth: number): Promise<AreaPathNode>;
}
