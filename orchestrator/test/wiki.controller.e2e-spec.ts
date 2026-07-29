import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { WsAdapter } from '@nestjs/platform-ws';
import { SessionService } from '../src/modules/auth/session.service';

const TEST_SESSION_COOKIE = 'req2ado_session=test-token';

describe('WikiController (e2e)', () => {
  let app: INestApplication;

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
      // Wiki is a real user (browser-session) page like any other -- stub
      // session validation to a fixed user rather than needing a real
      // reachable Postgres/session row in this test's env.
      .overrideProvider(SessionService)
      .useValue({ validate: jest.fn().mockResolvedValue({ userId: 'test-user', displayName: 'Test User' }) })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /wiki returns the user guide content', async () => {
    const res = await request(app.getHttpServer()).get('/wiki').set('Cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# req2ado User Guide');
    expect(res.headers['content-type']).toContain('text/markdown');
  });
});
