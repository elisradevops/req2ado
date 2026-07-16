import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLinkWorkItemsTool } from '../src/tools/linkWorkItemsTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_link_work_items tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => registerLinkWorkItemsTool(server, new MockAdoBackend(':memory:'))).not.toThrow();
  });
});
