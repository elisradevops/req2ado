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
}
