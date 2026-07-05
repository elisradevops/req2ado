import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSetFieldsTool } from '../src/tools/setFieldsTool';
import { MockAdoBackend } from '../src/backends/mockAdo';

describe('ado_set_fields tool', () => {
  it('registers without throwing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => registerSetFieldsTool(server, new MockAdoBackend(':memory:'))).not.toThrow();
  });
});
