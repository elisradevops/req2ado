import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WsAdapter } from '@nestjs/platform-ws';
import { JobsService } from '../src/modules/pipeline/jobs.service';

describe('JobsController (e2e)', () => {
  let app: INestApplication;
  const fakeJobsService = {
    submit: jest.fn(),
    getById: jest.fn(),
    confirm: jest.fn(),
    reject: jest.fn(),
    getAuditTrail: jest.fn(),
    getSummary: jest.fn(),
    getDedupSkips: jest.fn(),
    validateCreatedTree: jest.fn(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://req2ado:req2ado@localhost:5432/req2ado';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MCP_URL = 'http://localhost:4100';
    process.env.MCP_BEARER = 'test-bearer';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.LLM_CHAT_MODEL = 'test-model';
    process.env.LLM_PROXY_BEARER = 'test-llm-proxy-bearer';
    process.env.EMBED_MODEL = 'test-embed-model';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JobsService)
      .useValue(fakeJobsService)
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('POST /jobs accepts a file upload and returns a jobId', async () => {
    fakeJobsService.submit.mockResolvedValue({ jobId: 'job-1' });
    const res = await request(app.getHttpServer())
      .post('/jobs')
      .field('areaPath', 'Project\\Area1')
      .attach('file', Buffer.from('hello world'), 'spec.txt');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ jobId: 'job-1' });
    expect(fakeJobsService.submit).toHaveBeenCalledWith(
      expect.objectContaining({ areaPath: 'Project\\Area1', filename: 'spec.txt' }),
    );
  });

  it('POST /jobs defaults mode to baseline when not provided', async () => {
    fakeJobsService.submit.mockResolvedValue({ jobId: 'job-1' });
    const res = await request(app.getHttpServer())
      .post('/jobs')
      .field('areaPath', 'Project\\Area1')
      .attach('file', Buffer.from('hello world'), 'spec.txt');

    expect(res.status).toBe(201);
    expect(fakeJobsService.submit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline' }));
  });

  it('POST /jobs passes mode=survey through when specified', async () => {
    fakeJobsService.submit.mockResolvedValue({ jobId: 'job-1' });
    const res = await request(app.getHttpServer())
      .post('/jobs')
      .field('areaPath', 'Project\\Area1')
      .field('mode', 'survey')
      .attach('file', Buffer.from('hello world'), 'spec.txt');

    expect(res.status).toBe(201);
    expect(fakeJobsService.submit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'survey' }));
  });

  it('POST /jobs rejects an invalid mode value', async () => {
    const res = await request(app.getHttpServer())
      .post('/jobs')
      .field('areaPath', 'Project\\Area1')
      .field('mode', 'invalid-mode')
      .attach('file', Buffer.from('hello world'), 'spec.txt');

    expect(res.status).toBe(400);
  });

  it('POST /jobs returns 400 when no file is attached', async () => {
    const res = await request(app.getHttpServer()).post('/jobs').field('areaPath', 'Project\\Area1');
    expect(res.status).toBe(400);
  });

  it('POST /jobs rejects a file exceeding the configured size limit', async () => {
    const oversized = Buffer.alloc(30 * 1024 * 1024); // exceeds the 25MB default
    const res = await request(app.getHttpServer())
      .post('/jobs')
      .attach('file', oversized, 'big.txt')
      .field('areaPath', 'Project\\Area1');
    expect(res.status).toBe(413);
  });

  it('POST /jobs rejects an unsupported file extension', async () => {
    const res = await request(app.getHttpServer())
      .post('/jobs')
      .attach('file', Buffer.from('fake'), 'malware.exe')
      .field('areaPath', 'Project\\Area1');
    expect(res.status).toBe(400);
  });

  it('GET /jobs/:id returns the job status', async () => {
    fakeJobsService.getById.mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [] });
    const res = await request(app.getHttpServer()).get('/jobs/job-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'job-1', status: 'diff_ready', dryRunDiff: [] });
  });

  it('GET /jobs/:id returns 404 for an unknown job', async () => {
    fakeJobsService.getById.mockResolvedValue(null);
    const res = await request(app.getHttpServer()).get('/jobs/unknown');
    expect(res.status).toBe(404);
  });

  it('POST /jobs/:id/confirm triggers the write and returns the result', async () => {
    fakeJobsService.confirm.mockResolvedValue({ status: 'succeeded', createdCount: 2 });
    const res = await request(app.getHttpServer()).post('/jobs/job-1/confirm');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'succeeded', createdCount: 2 });
    expect(fakeJobsService.confirm).toHaveBeenCalledWith('job-1', undefined, undefined);
  });

  it('POST /jobs/:id/confirm forwards X-Ado-Org-Url / X-Ado-Pat headers as a credential', async () => {
    fakeJobsService.confirm.mockResolvedValue({ status: 'succeeded', createdCount: 1 });
    const res = await request(app.getHttpServer())
      .post('/jobs/job-1/confirm')
      .set('X-Ado-Org-Url', 'https://ado.example.com/tfs')
      .set('X-Ado-Pat', 'secret-pat');
    expect(res.status).toBe(201);
    expect(fakeJobsService.confirm).toHaveBeenCalledWith(
      'job-1',
      { orgUrl: 'https://ado.example.com/tfs', pat: 'secret-pat' },
      undefined,
    );
  });

  it('POST /jobs/:id/confirm treats a partial credential (only one header) as no credential', async () => {
    fakeJobsService.confirm.mockResolvedValue({ status: 'succeeded', createdCount: 0 });
    const res = await request(app.getHttpServer())
      .post('/jobs/job-1/confirm')
      .set('X-Ado-Org-Url', 'https://ado.example.com/tfs');
    expect(res.status).toBe(201);
    expect(fakeJobsService.confirm).toHaveBeenCalledWith('job-1', undefined, undefined);
  });

  it('POST /jobs/:id/confirm forwards selectedLocalIds from the request body', async () => {
    fakeJobsService.confirm.mockResolvedValue({ status: 'succeeded', createdCount: 1 });
    const res = await request(app.getHttpServer())
      .post('/jobs/job-1/confirm')
      .send({ selectedLocalIds: ['n0', 'n2'] });
    expect(res.status).toBe(201);
    expect(fakeJobsService.confirm).toHaveBeenCalledWith('job-1', undefined, ['n0', 'n2']);
  });

  it('POST /jobs/:id/reject rejects the job', async () => {
    fakeJobsService.reject.mockResolvedValue({ status: 'rejected' });
    const res = await request(app.getHttpServer()).post('/jobs/job-1/reject');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'rejected' });
    expect(fakeJobsService.reject).toHaveBeenCalledWith('job-1');
  });

  it('GET /jobs/:id/summary returns the aggregated summary', async () => {
    fakeJobsService.getSummary.mockResolvedValue({
      created: 3, reused: 1, dedupSkipped: 1, flagged: 2, warnings: ['node count diverges'],
    });
    const res = await request(app.getHttpServer()).get('/jobs/job-1/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 3, reused: 1, dedupSkipped: 1, flagged: 2, warnings: ['node count diverges'] });
  });

  it('GET /jobs/:id/summary returns 404 for an unknown job', async () => {
    fakeJobsService.getSummary.mockResolvedValue(null);
    const res = await request(app.getHttpServer()).get('/jobs/unknown/summary');
    expect(res.status).toBe(404);
  });

  it('GET /jobs/:id/validate returns the post-write validation result', async () => {
    fakeJobsService.validateCreatedTree.mockResolvedValue({ valid: true, checkedCount: 2, mismatches: [] });
    const res = await request(app.getHttpServer()).get('/jobs/job-1/validate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, checkedCount: 2, mismatches: [] });
    expect(fakeJobsService.validateCreatedTree).toHaveBeenCalledWith('job-1', undefined);
  });

  it('GET /jobs/:id/validate forwards X-Ado-Org-Url / X-Ado-Pat headers as a credential', async () => {
    fakeJobsService.validateCreatedTree.mockResolvedValue({ valid: true, checkedCount: 0, mismatches: [] });
    const res = await request(app.getHttpServer())
      .get('/jobs/job-1/validate')
      .set('X-Ado-Org-Url', 'https://ado.example.com/tfs')
      .set('X-Ado-Pat', 'secret-pat');
    expect(res.status).toBe(200);
    expect(fakeJobsService.validateCreatedTree).toHaveBeenCalledWith('job-1', {
      orgUrl: 'https://ado.example.com/tfs',
      pat: 'secret-pat',
    });
  });

  it('GET /jobs/:id/validate returns 404 for an unknown job', async () => {
    fakeJobsService.validateCreatedTree.mockResolvedValue(null);
    const res = await request(app.getHttpServer()).get('/jobs/unknown/validate');
    expect(res.status).toBe(404);
  });

  it('GET /jobs/:id/audit returns the audit trail', async () => {
    fakeJobsService.getAuditTrail.mockResolvedValue([{ id: 'a1', message: 'Job submitted: x.txt', createdAt: new Date() }]);
    const res = await request(app.getHttpServer()).get('/jobs/job-1/audit');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /jobs/:id/dedup-skips returns the durable dedup-skip audit rows', async () => {
    fakeJobsService.getDedupSkips.mockResolvedValue([
      { id: 'a1', localId: 'n1', similarity: 0.95, existingAdoId: 42, createdAt: new Date() },
    ]);
    const res = await request(app.getHttpServer()).get('/jobs/job-1/dedup-skips');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ localId: 'n1', similarity: 0.95, existingAdoId: 42 });
  });
});
