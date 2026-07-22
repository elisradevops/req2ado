import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import helmet from 'helmet';
import { WsAdapter } from '@nestjs/platform-ws';

describe('Security headers and rate limiting', () => {
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

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.use(helmet());
    await app.init();
    // Bind to a real ephemeral port before the burst-request test below fires
    // 20 concurrent requests — supertest lazily calls .listen() on the first
    // request when given an unbound server, and 20 concurrent lazy-listen
    // calls race each other (most connections get ECONNRESET). Binding once
    // up front avoids that race; it isn't a throttler/helmet concern.
    await new Promise<void>((resolve) => app.getHttpServer().listen(0, resolve));
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets standard security headers on responses', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
  });

  it('does not set the identifying X-Powered-By header', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows a generous burst of requests without rate-limiting (CI/test-safe threshold)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app.getHttpServer()).get('/health')),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
  });
});
