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

  it('ping returns ok:true', async () => {
    expect(await backend.ping()).toEqual({ ok: true, backend: 'mock' });
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
});
