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
