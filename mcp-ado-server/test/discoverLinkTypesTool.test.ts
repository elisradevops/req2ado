import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDiscoverLinkTypesTool } from '../src/tools/discoverLinkTypesTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_discover_link_types tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => registerDiscoverLinkTypesTool(server, new MockAdoBackend(':memory:'))).not.toThrow();
  });
});
