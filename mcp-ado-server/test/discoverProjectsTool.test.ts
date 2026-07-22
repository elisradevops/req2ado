import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MockAdoBackend } from '../src/backends/mockAdo';
import { registerDiscoverProjectsTool } from '../src/tools/discoverProjectsTool';

describe('registerDiscoverProjectsTool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' });
    const backend = new MockAdoBackend(':memory:');
    expect(() => registerDiscoverProjectsTool(server, backend)).not.toThrow();
  });
});
