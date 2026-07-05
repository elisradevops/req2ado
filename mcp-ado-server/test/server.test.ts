import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createMcpApp } from '../src/server';
import { MockAdoBackend } from '../src/backends/mockAdo';
import { timingSafeEqualBearer } from '../src/auth/timingSafeEqualBearer';
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
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong bearer token', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).post('/mcp').set('Authorization', 'Bearer wrong').send({});
    expect(res.status).toBe(401);
  });

  it('exposes a plain health endpoint with no auth required', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'mock' });
  });

  it('accepts an initialize request with the correct bearer token, and allows a second request afterwards', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);

    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    };

    // First request: proves a correctly-authenticated call to /mcp succeeds (not 401).
    const first = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${testConfig.mcpBearer}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest);
    expect(first.status).not.toBe(401);
    expect(first.status).toBeLessThan(500);

    // Second request on the SAME app instance: regression test for the
    // "connect() called per-request on a shared transport" bug. Before the
    // fix this either threw "Already connected to a transport..." (when a
    // single transport/server pair was reused and connect() was called again)
    // or produced a bare 500 (a stateless transport is single-use per the
    // MCP SDK, so reusing one across requests also fails). Asserting a
    // second, independent, non-401/non-500 response proves the app can
    // serve more than one /mcp request.
    const toolsListRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };
    const second = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${testConfig.mcpBearer}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(toolsListRequest);
    expect(second.status).not.toBe(401);
    expect(second.status).toBeLessThan(500);
  });

  it('rejects a /mcp request with no ADO credential headers when backend=real', async () => {
    const app = createMcpApp(() => {
      throw new Error('should not be called');
    }, { ...testConfig, backend: 'real' });
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${testConfig.mcpBearer}`).send({});
    expect(res.status).toBe(401);
  });

  it('GET /health never constructs a credentialed backend when backend=real', async () => {
    // Regression test: /health used to call backendFactory(undefined) even
    // when backend===real, constructing a RealAdoBackend with no credential
    // and immediately calling its ping() — which dereferences
    // credential.orgUrl and throws on every single health check, breaking
    // container/orchestrator liveness probes for the exact configuration
    // this whole task exists to unblock. The factory below throwing proves
    // /health never invokes it at all when backend===real.
    const app = createMcpApp(() => {
      throw new Error('should not be called for /health when backend=real');
    }, { ...testConfig, backend: 'real' });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'real' });
  });
});

describe('timingSafeEqualBearer', () => {
  it('returns true for an exact match', () => {
    expect(timingSafeEqualBearer('Bearer abc123', 'Bearer abc123')).toBe(true);
  });

  it('returns false for a mismatch', () => {
    expect(timingSafeEqualBearer('Bearer abc123', 'Bearer wrong')).toBe(false);
  });

  it('returns false when lengths differ (no length-based short-circuit crash)', () => {
    expect(timingSafeEqualBearer('Bearer short', 'Bearer a-much-longer-token-value')).toBe(false);
  });

  it('returns false for an empty header', () => {
    expect(timingSafeEqualBearer('', 'Bearer abc123')).toBe(false);
  });
});
