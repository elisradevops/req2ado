import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { WsAdapter } from '@nestjs/platform-ws';
import { JobsService } from '../src/modules/pipeline/jobs.service';
import { SessionService } from '../src/modules/auth/session.service';
import { AdoCredentialResolver } from '../src/modules/auth/ado-credential.resolver';

const TEST_USER_ID = 'test-user-descriptor';
// Any non-empty value -- AuthGuard only checks that the cookie is present,
// then hands it to the (stubbed below) SessionService.validate, which
// resolves the fixed test user regardless of the actual token value.
const TEST_SESSION_COOKIE = 'req2ado_session=test-token';

// Drop-in replacement for `request(server)` that pre-attaches the fake
// session cookie every route below now requires (AuthGuard is real, only
// SessionService is stubbed -- see beforeAll).
function authedRequest(
  server: Parameters<typeof request>[0],
): { get: (url: string) => request.Test; post: (url: string) => request.Test; delete: (url: string) => request.Test } {
  const agent = request(server);
  return {
    get: (url: string) => agent.get(url).set('Cookie', TEST_SESSION_COOKIE),
    post: (url: string) => agent.post(url).set('Cookie', TEST_SESSION_COOKIE),
    delete: (url: string) => agent.delete(url).set('Cookie', TEST_SESSION_COOKIE),
  };
}

describe('JobsController (e2e)', () => {
  let app: INestApplication;
  const fakeJobsService = {
    submit: jest.fn(),
    list: jest.fn(),
    getById: jest.fn(),
    confirm: jest.fn(),
    reject: jest.fn(),
    cancel: jest.fn(),
    delete: jest.fn(),
    resubmit: jest.fn(),
    getAuditTrail: jest.fn(),
    getDebugCaptures: jest.fn(),
    getSummary: jest.fn(),
    getDedupSkips: jest.fn(),
    validateCreatedTree: jest.fn(),
  };
  const fakeAdoCredentialResolver = { resolve: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://req2ado:req2ado@localhost:5432/req2ado';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MCP_URL = 'http://localhost:4100';
    process.env.MCP_BEARER = 'test-bearer';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.LLM_CHAT_MODEL = 'test-model';
    process.env.LLM_PROXY_BEARER = 'test-llm-proxy-bearer';
    process.env.EMBED_MODEL = 'test-embed-model';
    process.env.CREDENTIAL_ENC_KEY = 'test-credential-enc-key';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JobsService)
      .useValue(fakeJobsService)
      // This spec is about JobsController's own request handling, not
      // AuthGuard's -- every request below sends a (fake) session cookie
      // and this stub resolves it to a fixed test user, so the real
      // AuthGuard still runs (unlike overriding the guard itself, which
      // doesn't work cleanly for a guard registered via APP_GUARD).
      .overrideProvider(SessionService)
      .useValue({ validate: jest.fn().mockResolvedValue({ userId: TEST_USER_ID, displayName: 'Test User' }) })
      // confirm/validate now resolve the ADO credential from the vault
      // (by session userId) instead of reading it off request headers --
      // this spec is about JobsController's routing, not vault internals.
      .overrideProvider(AdoCredentialResolver)
      .useValue(fakeAdoCredentialResolver)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Every per-job route now checks ownership via jobsService.getById before
  // delegating (see JobsController.ownedJob) -- default every test to an
  // owned job so routes not specifically testing getById's own response
  // still pass the ownership check. Tests that need a DIFFERENT getById
  // behavior (the 404 cases) override this with their own mockResolvedValue.
  beforeEach(() => {
    fakeJobsService.getById.mockResolvedValue({ userId: TEST_USER_ID });
    fakeAdoCredentialResolver.resolve.mockResolvedValue(undefined);
  });

  it('POST /jobs accepts a file upload and returns a jobId', async () => {
    fakeJobsService.submit.mockResolvedValue({ jobId: 'job-1' });
    const res = await authedRequest(app.getHttpServer())
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
    const res = await authedRequest(app.getHttpServer())
      .post('/jobs')
      .field('areaPath', 'Project\\Area1')
      .attach('file', Buffer.from('hello world'), 'spec.txt');

    expect(res.status).toBe(201);
    expect(fakeJobsService.submit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline' }));
  });

  it('POST /jobs passes mode=survey through when specified', async () => {
    fakeJobsService.submit.mockResolvedValue({ jobId: 'job-1' });
    const res = await authedRequest(app.getHttpServer())
      .post('/jobs')
      .field('areaPath', 'Project\\Area1')
      .field('mode', 'survey')
      .attach('file', Buffer.from('hello world'), 'spec.txt');

    expect(res.status).toBe(201);
    expect(fakeJobsService.submit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'survey' }));
  });

  it('POST /jobs rejects an invalid mode value', async () => {
    const res = await authedRequest(app.getHttpServer())
      .post('/jobs')
      .field('areaPath', 'Project\\Area1')
      .field('mode', 'invalid-mode')
      .attach('file', Buffer.from('hello world'), 'spec.txt');

    expect(res.status).toBe(400);
  });

  it('POST /jobs returns 400 when no file is attached', async () => {
    const res = await authedRequest(app.getHttpServer()).post('/jobs').field('areaPath', 'Project\\Area1');
    expect(res.status).toBe(400);
  });

  it('POST /jobs rejects a file exceeding the configured size limit', async () => {
    const oversized = Buffer.alloc(30 * 1024 * 1024); // exceeds the 25MB default
    const res = await authedRequest(app.getHttpServer())
      .post('/jobs')
      .attach('file', oversized, 'big.txt')
      .field('areaPath', 'Project\\Area1');
    expect(res.status).toBe(413);
  });

  it('POST /jobs rejects an unsupported file extension', async () => {
    const res = await authedRequest(app.getHttpServer())
      .post('/jobs')
      .attach('file', Buffer.from('fake'), 'malware.exe')
      .field('areaPath', 'Project\\Area1');
    expect(res.status).toBe(400);
  });

  it('GET /jobs scopes the list to the session userId, never a client-supplied one', async () => {
    fakeJobsService.list.mockResolvedValue([]);
    const res = await authedRequest(app.getHttpServer()).get('/jobs');
    expect(res.status).toBe(200);
    // Second arg is the (empty, since no query string was sent) parsed
    // skip/take pagination object -- jobsListQuerySchema always produces an
    // object, so the controller always passes one through, even when unused.
    expect(fakeJobsService.list).toHaveBeenCalledWith(TEST_USER_ID, {});
  });

  it('GET /jobs/:id returns the job status', async () => {
    fakeJobsService.getById.mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [], userId: TEST_USER_ID });
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1');
    expect(res.status).toBe(200);
    // areaPath is absent on this fixture -- workItemTypeCatalog resolution
    // is skipped entirely (no project to resolve against) and stays {}, and
    // workItemTypeCategoryLabels falls back to the identity map (CR: reparent).
    expect(res.body).toEqual({
      id: 'job-1',
      status: 'diff_ready',
      dryRunDiff: [],
      workItemTypeCatalog: {},
      workItemTypeCategoryLabels: { Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' },
      requirementClassificationField: null,
    });
  });

  it('GET /jobs/:id returns 404 for an unknown job', async () => {
    fakeJobsService.getById.mockResolvedValue(null);
    const res = await authedRequest(app.getHttpServer()).get('/jobs/unknown');
    expect(res.status).toBe(404);
  });

  it('GET /jobs/:id returns 404 (not 403) for a job that belongs to a different user -- ownership, not enumeration', async () => {
    fakeJobsService.getById.mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [], userId: 'someone-elses-descriptor' });
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1');
    expect(res.status).toBe(404);
  });

  it('POST /jobs/:id/confirm triggers the write and returns the result', async () => {
    fakeJobsService.confirm.mockResolvedValue({ status: 'succeeded', createdCount: 2 });
    const res = await authedRequest(app.getHttpServer()).post('/jobs/job-1/confirm');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'succeeded', createdCount: 2 });
    expect(fakeJobsService.confirm).toHaveBeenCalledWith('job-1', undefined, undefined);
  });

  it('POST /jobs/:id/confirm resolves the ADO credential from the vault by session userId, not request headers', async () => {
    fakeJobsService.confirm.mockResolvedValue({ status: 'succeeded', createdCount: 1 });
    fakeAdoCredentialResolver.resolve.mockResolvedValue({ orgUrl: 'https://ado.example.com/tfs', pat: 'secret-pat' });
    const res = await authedRequest(app.getHttpServer()).post('/jobs/job-1/confirm');
    expect(res.status).toBe(201);
    expect(fakeAdoCredentialResolver.resolve).toHaveBeenCalledWith(TEST_USER_ID);
    expect(fakeJobsService.confirm).toHaveBeenCalledWith(
      'job-1',
      { orgUrl: 'https://ado.example.com/tfs', pat: 'secret-pat' },
      undefined,
    );
  });

  it('POST /jobs/:id/confirm passes undefined when the caller has no vaulted credential', async () => {
    fakeJobsService.confirm.mockResolvedValue({ status: 'succeeded', createdCount: 0 });
    const res = await authedRequest(app.getHttpServer()).post('/jobs/job-1/confirm');
    expect(res.status).toBe(201);
    expect(fakeJobsService.confirm).toHaveBeenCalledWith('job-1', undefined, undefined);
  });

  it('POST /jobs/:id/confirm forwards selectedLocalIds from the request body', async () => {
    fakeJobsService.confirm.mockResolvedValue({ status: 'succeeded', createdCount: 1 });
    const res = await authedRequest(app.getHttpServer())
      .post('/jobs/job-1/confirm')
      .send({ selectedLocalIds: ['n0', 'n2'] });
    expect(res.status).toBe(201);
    expect(fakeJobsService.confirm).toHaveBeenCalledWith('job-1', undefined, ['n0', 'n2']);
  });

  it('POST /jobs/:id/reject rejects the job', async () => {
    fakeJobsService.reject.mockResolvedValue({ status: 'rejected' });
    const res = await authedRequest(app.getHttpServer()).post('/jobs/job-1/reject');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'rejected' });
    expect(fakeJobsService.reject).toHaveBeenCalledWith('job-1');
  });

  it('POST /jobs/:id/cancel cancels the job', async () => {
    fakeJobsService.cancel.mockResolvedValue({ status: 'cancelled' });
    const res = await authedRequest(app.getHttpServer()).post('/jobs/job-1/cancel');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'cancelled' });
    expect(fakeJobsService.cancel).toHaveBeenCalledWith('job-1');
  });

  it('POST /jobs/:id/cancel returns 404 (not 403) for a job that belongs to a different user', async () => {
    fakeJobsService.getById.mockResolvedValue({ userId: 'someone-else' });
    const res = await authedRequest(app.getHttpServer()).post('/jobs/job-1/cancel');
    expect(res.status).toBe(404);
    expect(fakeJobsService.cancel).not.toHaveBeenCalled();
  });

  it('DELETE /jobs/:id deletes the job', async () => {
    fakeJobsService.delete.mockResolvedValue({ deleted: true });
    const res = await authedRequest(app.getHttpServer()).delete('/jobs/job-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(fakeJobsService.delete).toHaveBeenCalledWith('job-1');
  });

  it('DELETE /jobs/:id returns 404 (not 403) for a job that belongs to a different user', async () => {
    fakeJobsService.getById.mockResolvedValue({ userId: 'someone-else' });
    const res = await authedRequest(app.getHttpServer()).delete('/jobs/job-1');
    expect(res.status).toBe(404);
    expect(fakeJobsService.delete).not.toHaveBeenCalled();
  });

  it('POST /jobs/:id/resubmit creates a new job from the retained source file', async () => {
    fakeJobsService.resubmit.mockResolvedValue({ jobId: 'job-2' });
    const res = await authedRequest(app.getHttpServer()).post('/jobs/job-1/resubmit');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ jobId: 'job-2' });
    expect(fakeJobsService.resubmit).toHaveBeenCalledWith('job-1');
  });

  it('POST /jobs/:id/resubmit returns 404 (not 403) for a job that belongs to a different user', async () => {
    fakeJobsService.getById.mockResolvedValue({ userId: 'someone-else' });
    const res = await authedRequest(app.getHttpServer()).post('/jobs/job-1/resubmit');
    expect(res.status).toBe(404);
    expect(fakeJobsService.resubmit).not.toHaveBeenCalled();
  });

  it('GET /jobs/:id/summary returns the aggregated summary', async () => {
    fakeJobsService.getSummary.mockResolvedValue({
      created: 3, reused: 1, dedupSkipped: 1, flagged: 2, warnings: ['node count diverges'],
    });
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 3, reused: 1, dedupSkipped: 1, flagged: 2, warnings: ['node count diverges'] });
  });

  it('GET /jobs/:id/summary returns 404 for an unknown job', async () => {
    fakeJobsService.getSummary.mockResolvedValue(null);
    const res = await authedRequest(app.getHttpServer()).get('/jobs/unknown/summary');
    expect(res.status).toBe(404);
  });

  it('GET /jobs/:id/validate returns the post-write validation result', async () => {
    fakeJobsService.validateCreatedTree.mockResolvedValue({ valid: true, checkedCount: 2, mismatches: [] });
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1/validate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, checkedCount: 2, mismatches: [] });
    expect(fakeJobsService.validateCreatedTree).toHaveBeenCalledWith('job-1', undefined);
  });

  it('GET /jobs/:id/validate resolves the ADO credential from the vault by session userId', async () => {
    fakeJobsService.validateCreatedTree.mockResolvedValue({ valid: true, checkedCount: 0, mismatches: [] });
    fakeAdoCredentialResolver.resolve.mockResolvedValue({ orgUrl: 'https://ado.example.com/tfs', pat: 'secret-pat' });
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1/validate');
    expect(res.status).toBe(200);
    expect(fakeAdoCredentialResolver.resolve).toHaveBeenCalledWith(TEST_USER_ID);
    expect(fakeJobsService.validateCreatedTree).toHaveBeenCalledWith('job-1', {
      orgUrl: 'https://ado.example.com/tfs',
      pat: 'secret-pat',
    });
  });

  it('GET /jobs/:id/validate returns 404 for an unknown job', async () => {
    fakeJobsService.validateCreatedTree.mockResolvedValue(null);
    const res = await authedRequest(app.getHttpServer()).get('/jobs/unknown/validate');
    expect(res.status).toBe(404);
  });

  it('GET /jobs/:id/audit returns the audit trail', async () => {
    fakeJobsService.getAuditTrail.mockResolvedValue([{ id: 'a1', message: 'Job submitted: x.txt', createdAt: new Date() }]);
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1/audit');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /jobs/:id/debug returns the raw-response captures for the job', async () => {
    fakeJobsService.getDebugCaptures.mockResolvedValue([{ kind: 'infer_trace_links', identifier: 'document', content: 'raw content' }]);
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1/debug');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ kind: 'infer_trace_links', identifier: 'document', content: 'raw content' }]);
  });

  it('GET /jobs/:id/debug returns 404 (not 403) for a job that belongs to a different user', async () => {
    fakeJobsService.getById.mockResolvedValue({ userId: 'someone-else' });
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1/debug');
    expect(res.status).toBe(404);
    expect(fakeJobsService.getDebugCaptures).not.toHaveBeenCalled();
  });

  it('GET /jobs/:id/dedup-skips returns the durable dedup-skip audit rows', async () => {
    fakeJobsService.getDedupSkips.mockResolvedValue([
      { id: 'a1', localId: 'n1', similarity: 0.95, existingAdoId: 42, createdAt: new Date() },
    ]);
    const res = await authedRequest(app.getHttpServer()).get('/jobs/job-1/dedup-skips');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ localId: 'n1', similarity: 0.95, existingAdoId: 42 });
  });
});
