import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WsAdapter } from '@nestjs/platform-ws';
import 'reflect-metadata';
import { AdoPatProvider } from '../src/modules/auth/ado-pat.provider';
import { AuthController } from '../src/modules/auth/auth.controller';
import { SessionService } from '../src/modules/auth/session.service';
import { CredentialVaultService } from '../src/modules/auth/credential-vault.service';

describe('AuthController @Throttle', () => {
  it('POST /auth/login has a tighter per-IP rate limit than the app-wide default (login is a credential-storing endpoint)', () => {
    // Same pattern as llm.controller.spec.ts's own ThrottlerGuard metadata
    // assertion -- proves the decorator is applied without needing a live
    // 21-request HTTP burst against a real Postgres-backed session store.
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', AuthController.prototype.login)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', AuthController.prototype.login)).toBe(60_000);
  });
});

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  const fakeAdoPatProvider = {
    validateAndIdentify: jest.fn(),
  };
  // This spec is about AuthController's request/response mapping, not
  // SessionService's own persistence (covered separately) -- a fake avoids
  // needing a real reachable Postgres in this test's env.
  const fakeSessionService = {
    create: jest.fn().mockResolvedValue('fake-session-token'),
  };
  // Same reasoning as fakeSessionService -- login() now also vaults the
  // PAT (CredentialVaultService.set), which this spec isn't testing and
  // shouldn't need a real reachable Postgres for.
  const fakeCredentialVault = {
    set: jest.fn().mockResolvedValue(undefined),
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
    process.env.CREDENTIAL_ENC_KEY = 'test-credential-enc-key';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AdoPatProvider)
      .useValue(fakeAdoPatProvider)
      .overrideProvider(SessionService)
      .useValue(fakeSessionService)
      .overrideProvider(CredentialVaultService)
      .useValue(fakeCredentialVault)
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

  it('POST /auth/login returns the identified display name on a valid PAT', async () => {
    fakeAdoPatProvider.validateAndIdentify.mockResolvedValue({
      identity: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
      displayName: 'Jane Doe',
    });

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ displayName: 'Jane Doe', userId: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000' });
  });

  it('POST /auth/login returns 401 on an invalid PAT', async () => {
    fakeAdoPatProvider.validateAndIdentify.mockRejectedValue(new Error('ADO connectionData validation failed: 401'));

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'bad-pat' });

    expect(res.status).toBe(401);
  });

  it('POST /auth/login returns 400 when adoOrgUrl is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ pat: 'fake-pat' });

    expect(res.status).toBe(400);
  });

  it('POST /auth/login returns 400 when adoOrgUrl is not a valid URL', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ adoOrgUrl: 'not-a-url', pat: 'fake-pat' });

    expect(res.status).toBe(400);
  });
});
