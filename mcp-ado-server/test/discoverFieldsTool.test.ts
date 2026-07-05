import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDiscoverFieldsTool } from '../src/tools/discoverFieldsTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_discover_fields tool', () => {
  it('registers without throwing and calls through to the backend', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const backend = new MockAdoBackend(':memory:');
    expect(() => registerDiscoverFieldsTool(server, backend)).not.toThrow();
  });
});
