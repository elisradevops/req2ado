import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueryIdsTool } from '../src/tools/queryIdsTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_query_ids tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => registerQueryIdsTool(server, new MockAdoBackend(':memory:'))).not.toThrow();
  });
});
