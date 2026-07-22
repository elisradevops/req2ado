import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetWorkItemsBatchTool } from '../src/tools/getWorkItemsBatchTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_get_work_items_batch tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const backend = new MockAdoBackend(':memory:');
    expect(() => registerGetWorkItemsBatchTool(server, backend)).not.toThrow();
  });
});
