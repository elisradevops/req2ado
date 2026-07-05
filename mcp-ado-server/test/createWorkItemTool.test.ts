import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCreateWorkItemTool } from '../src/tools/createWorkItemTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_create_work_item tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const backend = new MockAdoBackend(':memory:');
    expect(() => registerCreateWorkItemTool(server, backend)).not.toThrow();
  });
});
