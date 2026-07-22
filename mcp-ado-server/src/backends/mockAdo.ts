import Database from 'better-sqlite3';
import type { AdoBackend, AdoProject, AreaPathNode, CreateWorkItemInput, WorkItemRecord, WorkItemType } from './types.js';
import { SEED_LINK_TYPES, type AdoLinkType } from '../domain/adoLinkTypes.js';

/**
 * SQLite-backed ADO stand-in for off-network development and tests.
 * Schema is intentionally flat: one row per work item, fields as a JSON blob,
 * parent_id nullable for the hierarchy link. Good enough to exercise the same
 * MCP tool contract the real ADO REST backend will fulfill in Phase 7.
 */
export class MockAdoBackend implements AdoBackend {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        fields TEXT NOT NULL,
        parent_id INTEGER
      );
    `);
  }

  async ping(): Promise<{ ok: true; backend: 'mock' }> {
    return { ok: true, backend: 'mock' };
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord> {
    const stmt = this.db.prepare(
      'INSERT INTO work_items (type, fields, parent_id) VALUES (?, ?, NULL)',
    );
    const result = stmt.run(input.type, JSON.stringify(input.fields));
    return { id: Number(result.lastInsertRowid), type: input.type, fields: input.fields, parentId: null };
  }

  async getWorkItem(id: number): Promise<WorkItemRecord | null> {
    const row = this.db
      .prepare('SELECT id, type, fields, parent_id as parentId FROM work_items WHERE id = ?')
      .get(id) as { id: number; type: WorkItemType; fields: string; parentId: number | null } | undefined;
    if (!row) return null;
    return { id: row.id, type: row.type, fields: JSON.parse(row.fields), parentId: row.parentId };
  }

  async getWorkItemsBatch(ids: number[]): Promise<WorkItemRecord[]> {
    const results = await Promise.all(ids.map((id) => this.getWorkItem(id)));
    return results.filter((item): item is WorkItemRecord => item !== null);
  }

  async linkParentChild(childId: number, parentId: number): Promise<void> {
    this.db.prepare('UPDATE work_items SET parent_id = ? WHERE id = ?').run(parentId, childId);
  }

  async linkWorkItems(_fromId: number, _toId: number, _referenceName: string): Promise<void> {
    // No-op: the mock's flat schema has no generic relations table (only
    // parent_id). Good enough to exercise the tool contract in tests; the
    // real backend is what actually needs to write the relation.
  }

  async queryIds(fieldMatch: Record<string, string>): Promise<number[]> {
    const rows = this.db.prepare('SELECT id, fields FROM work_items').all() as { id: number; fields: string }[];
    return rows
      .filter((row) => {
        const fields = JSON.parse(row.fields) as Record<string, string>;
        return Object.entries(fieldMatch).every(([key, value]) => fields[key] === value);
      })
      .map((row) => row.id);
  }

  async setFields(id: number, fields: Record<string, string>): Promise<void> {
    const existing = this.db.prepare('SELECT fields FROM work_items WHERE id = ?').get(id) as
      | { fields: string }
      | undefined;
    if (!existing) return;
    const merged = { ...JSON.parse(existing.fields), ...fields };
    this.db.prepare('UPDATE work_items SET fields = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }

  async discoverFields(_workItemType: WorkItemType): Promise<string[]> {
    // Hardcoded, realistic field set for off-network dev/tests — good enough
    // to exercise the Customer ID candidate-matching logic without a real
    // ADO server. Includes one of the three real candidate names so callers
    // can test the "found" path against the mock.
    return [
      'System.Title',
      'System.Description',
      'System.State',
      'System.AreaPath',
      'Microsoft.VSTS.CMMI.RequirementType',
      'Custom.CustomerId',
    ];
  }

  async readAreaPaths(_depth: number, _project?: string): Promise<AreaPathNode> {
    return {
      path: 'Project',
      children: [
        { path: 'Project\\Frontend', children: [] },
        { path: 'Project\\Backend', children: [] },
      ],
    };
  }

  async discoverProjects(): Promise<AdoProject[]> {
    return [
      { id: '1', name: 'Project' },
      { id: '2', name: 'OtherProject' },
    ];
  }

  async discoverLinkTypes(): Promise<AdoLinkType[]> {
    return SEED_LINK_TYPES;
  }
}
