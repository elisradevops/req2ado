import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLinkParentChildTool } from '../src/tools/linkParentChildTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_link_parent_child tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const backend = new MockAdoBackend(':memory:');
    expect(() => registerLinkParentChildTool(server, backend)).not.toThrow();
  });
});
