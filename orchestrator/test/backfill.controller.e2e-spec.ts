import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WsAdapter } from '@nestjs/platform-ws';
import { BackfillService } from '../src/modules/writeback/backfill.service';

describe('BackfillController (e2e)', () => {
  let app: INestApplication;
  const fakeBackfillService = { backfillAreaPath: jest.fn() };

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
      .overrideProvider(BackfillService)
      .useValue(fakeBackfillService)
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

  it('POST /backfill returns 400 when areaPath is missing', async () => {
    const res = await request(app.getHttpServer()).post('/backfill').send({});
    expect(res.status).toBe(400);
    expect(fakeBackfillService.backfillAreaPath).not.toHaveBeenCalled();
  });

  it('POST /backfill calls backfillAreaPath and returns its result', async () => {
    fakeBackfillService.backfillAreaPath.mockResolvedValue({
      scanned: 5,
      seeded: 4,
      skipped: 1,
      skippedReasons: { 'unsupported type': 1 },
    });

    const res = await request(app.getHttpServer())
      .post('/backfill')
      .send({ areaPath: 'Project\\Area1' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ scanned: 5, seeded: 4, skipped: 1, skippedReasons: { 'unsupported type': 1 } });
    expect(fakeBackfillService.backfillAreaPath).toHaveBeenCalledWith('Project\\Area1', undefined);
  });

  it('POST /backfill forwards X-Ado-Org-Url / X-Ado-Pat headers as a credential', async () => {
    fakeBackfillService.backfillAreaPath.mockResolvedValue({ scanned: 0, seeded: 0, skipped: 0, skippedReasons: {} });

    await request(app.getHttpServer())
      .post('/backfill')
      .set('X-Ado-Org-Url', 'https://tfs.internal/tfs/Collection')
      .set('X-Ado-Pat', 'fake-pat')
      .send({ areaPath: 'Project\\Area1' });

    expect(fakeBackfillService.backfillAreaPath).toHaveBeenCalledWith('Project\\Area1', {
      orgUrl: 'https://tfs.internal/tfs/Collection',
      pat: 'fake-pat',
    });
  });
});
