import { describe, it, expect, beforeEach } from 'vitest';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('MockAdoBackend', () => {
  let backend: MockAdoBackend;

  beforeEach(() => {
    backend = new MockAdoBackend(':memory:');
  });

  it('creates a work item and assigns an incrementing id', async () => {
    const item = await backend.createWorkItem({
      type: 'Epic',
      fields: { 'System.Title': 'Receiver', 'System.State': 'Proposed' },
    });
    expect(item.id).toBe(1);
    expect(item.type).toBe('Epic');
    expect(item.parentId).toBeNull();
  });

  it('links a child to a parent via Hierarchy-Reverse', async () => {
    const parent = await backend.createWorkItem({ type: 'Epic', fields: { 'System.Title': 'Receiver' } });
    const child = await backend.createWorkItem({ type: 'Feature', fields: { 'System.Title': 'Broadcast & Inputs' } });
    await backend.linkParentChild(child.id, parent.id);
    const fetched = await backend.getWorkItem(child.id);
    expect(fetched?.parentId).toBe(parent.id);
  });

  it('queryIds finds items by exact field match, scoped by area path field if present', async () => {
    await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Channel scan', 'System.AreaPath': 'ProjectX\\TV' } });
    const ids = await backend.queryIds({ 'System.AreaPath': 'ProjectX\\TV' });
    expect(ids).toHaveLength(1);
  });

  it('queryIds matches System.AreaPath as a subtree (UNDER), mirroring realAdo.ts -- includes nested sub-paths', async () => {
    // Regression for a confirmed contract divergence: realAdo.ts's
    // buildWiqlQuery uses UNDER (subtree match) for System.AreaPath, not
    // exact equality. The mock must mirror that, or dev/test/demo runs
    // against the mock backend validate a narrower behavior than
    // production traffic actually gets.
    const parent = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Parent item', 'System.AreaPath': 'ProjectX\\TV' } });
    const child = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Child item', 'System.AreaPath': 'ProjectX\\TV\\Sub' } });
    const unrelated = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Unrelated', 'System.AreaPath': 'ProjectX\\Radio' } });

    const ids = await backend.queryIds({ 'System.AreaPath': 'ProjectX\\TV' });

    expect(ids.sort()).toEqual([parent.id, child.id].sort());
    expect(ids).not.toContain(unrelated.id);
  });

  it('queryIds does not match a sibling area path that merely shares a string prefix', async () => {
    // 'ProjectX\TVGuide' must not match a query for 'ProjectX\TV' -- the
    // subtree check requires a path-segment boundary (backslash), not a
    // bare string prefix.
    const sibling = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Sibling', 'System.AreaPath': 'ProjectX\\TVGuide' } });

    const ids = await backend.queryIds({ 'System.AreaPath': 'ProjectX\\TV' });

    expect(ids).not.toContain(sibling.id);
  });

  it('queryIds still requires exact match for non-AreaPath fields even when combined with an AreaPath subtree match', async () => {
    const match = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Exact', 'System.AreaPath': 'ProjectX\\TV\\Sub' } });
    const wrongTitle = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Different', 'System.AreaPath': 'ProjectX\\TV\\Sub' } });

    const ids = await backend.queryIds({ 'System.Title': 'Exact', 'System.AreaPath': 'ProjectX\\TV' });

    expect(ids).toEqual([match.id]);
    expect(ids).not.toContain(wrongTitle.id);
  });

  it('ping returns ok:true', async () => {
    expect(await backend.ping()).toEqual({ ok: true, backend: 'mock' });
  });

  it('getWorkItemsBatch reads multiple items and omits unknown ids', async () => {
    const a = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'A' } });
    const b = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'B' } });
    const results = await backend.getWorkItemsBatch([a.id, 999999, b.id]);
    expect(results.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('getWorkItemsBatch returns an empty array for an empty id list', async () => {
    expect(await backend.getWorkItemsBatch([])).toEqual([]);
  });
});

describe('MockAdoBackend.discoverFields', () => {
  it('returns a hardcoded, realistic set of field ref names for Requirement', async () => {
    const backend = new MockAdoBackend(':memory:');
    const fields = await backend.discoverFields('Requirement');
    expect(fields).toContain('System.Title');
    expect(fields).toContain('System.Description');
    expect(fields).toContain('Custom.CustomerId');
  });
});

describe('MockAdoBackend.discoverProjects', () => {
  it('returns a fixed list of projects, including "Project" to align with the readAreaPaths mock root', async () => {
    const backend = new MockAdoBackend(':memory:');
    const projects = await backend.discoverProjects();
    expect(projects.map((p) => p.name)).toContain('Project');
    expect(projects.length).toBeGreaterThan(1);
  });
});

describe('MockAdoBackend.setFields', () => {
  it('updates the fields of an existing work item', async () => {
    const backend = new MockAdoBackend(':memory:');
    const created = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Original' } });
    await backend.setFields(created.id, { 'System.Title': 'Updated' });
    const updated = await backend.getWorkItem(created.id);
    expect(updated?.fields['System.Title']).toBe('Updated');
  });

  it('merges new fields with existing ones rather than replacing the whole fields object', async () => {
    const backend = new MockAdoBackend(':memory:');
    const created = await backend.createWorkItem({
      type: 'Requirement',
      fields: { 'System.Title': 'Title', 'System.State': 'Proposed' },
    });
    await backend.setFields(created.id, { 'System.State': 'Active' });
    const updated = await backend.getWorkItem(created.id);
    expect(updated?.fields['System.Title']).toBe('Title');
    expect(updated?.fields['System.State']).toBe('Active');
  });

  it('discoverWorkItemTypeCategories resolves CMMI-shaped defaults', async () => {
    const backend = new MockAdoBackend(':memory:');
    const result = await backend.discoverWorkItemTypeCategories();
    expect(result).toEqual({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' });
  });
});
