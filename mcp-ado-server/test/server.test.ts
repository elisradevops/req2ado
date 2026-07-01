import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createMcpApp } from '../src/server';
import { MockAdoBackend } from '../src/backends/mockAdo';
import type { AdoMcpConfig } from '../src/config/env';

const testConfig: AdoMcpConfig = {
  adoBaseUrl: '',
  adoProject: '',
  apiVersionLadder: ['7.1', '5.1', 'none'],
  batchSize: 200,
  concurrency: 8,
  mcpBearer: 'test-bearer-token',
  port: 0,
  backend: 'mock',
  mockDbPath: ':memory:',
};

describe('MCP server HTTP transport', () => {
  it('rejects requests without a bearer token', async () => {
    const app = createMcpApp(new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong bearer token', async () => {
    const app = createMcpApp(new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).post('/mcp').set('Authorization', 'Bearer wrong').send({});
    expect(res.status).toBe(401);
  });

  it('exposes a plain health endpoint with no auth required', async () => {
    const app = createMcpApp(new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'mock' });
  });
});
