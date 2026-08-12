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

describe('HTTP app', () => {
  it('exposes a plain health endpoint with no auth required', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'mock' });
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

  it('GET /ready pings the backend for backend=mock', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'mock' });
  });

  it('GET /ready never constructs a credentialed backend when backend=real', async () => {
    const app = createMcpApp(() => {
      throw new Error('should not be called for /ready when backend=real');
    }, { ...testConfig, backend: 'real' });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      backend: 'real',
      note: 'real-ADO reachability requires a per-request credential, not checkable here',
    });
  });
});

describe('REST ADO transport auth (/api/ado)', () => {
  it('rejects requests without a bearer token', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).post('/api/ado/ado_ping').send({});
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong bearer token', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app).post('/api/ado/ado_ping').set('Authorization', 'Bearer wrong').send({});
    expect(res.status).toBe(401);
  });

  it('accepts an authenticated request and reaches the operation handler', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const res = await request(app)
      .post('/api/ado/ado_ping')
      .set('Authorization', `Bearer ${testConfig.mcpBearer}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backend: 'mock' });
  });

  it('rejects a request with no ADO credential headers when backend=real', async () => {
    const app = createMcpApp(() => {
      throw new Error('should not be called');
    }, { ...testConfig, backend: 'real' });
    const res = await request(app).post('/api/ado/ado_ping').set('Authorization', `Bearer ${testConfig.mcpBearer}`).send({});
    expect(res.status).toBe(401);
  });

  it('accepts a figure-attachment body well over express.json()\'s 100kb default (confirmed real 413 against actual figure uploads)', async () => {
    const app = createMcpApp(() => new MockAdoBackend(':memory:'), testConfig);
    const dataBase64 = Buffer.alloc(200_000, 'a').toString('base64'); // ~267kb of JSON body, > default 100kb limit
    const res = await request(app)
      .post('/api/ado/ado_upload_attachment')
      .set('Authorization', `Bearer ${testConfig.mcpBearer}`)
      .send({ workItemId: 1, fileName: 'fig.png', dataBase64, mimeType: 'image/png' });
    expect(res.status).toBe(200);
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
