import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdoRestRouter } from '../src/rest/router';
import { MockAdoBackend } from '../src/backends/mockAdo';
import type { AdoBackend } from '../src/backends/types';

function appWithRouter(backendFactory: Parameters<typeof createAdoRestRouter>[0]): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/ado', createAdoRestRouter(backendFactory));
  return app;
}

describe('REST ADO router', () => {
  it('GET / lists every registered operation', async () => {
    const app = appWithRouter(() => new MockAdoBackend(':memory:'));
    const res = await request(app).get('/api/ado/');
    expect(res.status).toBe(200);
    const names = res.body.map((op: { name: string }) => op.name);
    expect(names).toContain('ado_create_work_item');
    expect(names).toContain('ado_link_parent_child');
    expect(names.length).toBe(17);
  });

  it('POST /:operation 404s for an unknown operation', async () => {
    const app = appWithRouter(() => new MockAdoBackend(':memory:'));
    const res = await request(app).post('/api/ado/ado_does_not_exist').send({});
    expect(res.status).toBe(404);
  });

  it('POST /:operation 400s on input that fails the zod schema', async () => {
    const app = appWithRouter(() => new MockAdoBackend(':memory:'));
    const res = await request(app).post('/api/ado/ado_create_work_item').send({ type: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid input');
  });

  it('POST /:operation calls through to the backend and returns its result as JSON', async () => {
    const app = appWithRouter(() => new MockAdoBackend(':memory:'));
    const res = await request(app)
      .post('/api/ado/ado_create_work_item')
      .send({ type: 'Epic', fields: { 'System.Title': 'Test' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'Epic', fields: { 'System.Title': 'Test' } });
  });

  it('POST /:operation returns ok:true for a void-returning backend method (parity with the MCP tool)', async () => {
    const app = appWithRouter(() => new MockAdoBackend(':memory:'));
    const res = await request(app).post('/api/ado/ado_link_parent_child').send({ childId: 1, parentId: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /ado_upload_attachment calls through to the backend and returns ok:true', async () => {
    const app = appWithRouter(() => new MockAdoBackend(':memory:'));
    const res = await request(app)
      .post('/api/ado/ado_upload_attachment')
      .send({ workItemId: 1, fileName: 'fig.png', dataBase64: Buffer.from('x').toString('base64'), mimeType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /:operation returns 502 with the ADO-detail error message when the backend throws (regression: must never be swallowed)', async () => {
    const failingBackend = {
      linkParentChild: async () => {
        throw new Error('TF401232: parent work item does not exist');
      },
    } as unknown as AdoBackend;
    const app = appWithRouter(() => failingBackend);
    const res = await request(app).post('/api/ado/ado_link_parent_child').send({ childId: 1, parentId: 2 });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('parent work item does not exist');
  });

  it('forwards the per-request credential read from X-Ado-Org-Url/X-Ado-Pat to backendFactory', async () => {
    let receivedCredential: unknown;
    const app = appWithRouter((credential) => {
      receivedCredential = credential;
      return new MockAdoBackend(':memory:');
    });
    await request(app)
      .post('/api/ado/ado_ping')
      .set('X-Ado-Org-Url', 'https://tfs.internal/tfs/Collection')
      .set('X-Ado-Pat', 'some-pat')
      .send({});
    expect(receivedCredential).toEqual({ orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'some-pat' });
  });
});
