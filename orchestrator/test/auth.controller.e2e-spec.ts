import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AdoPatProvider } from '../src/modules/auth/ado-pat.provider';
import { PrismaService } from '../src/modules/auth/prisma.service';

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  const fakeAdoPatProvider = {
    validateAndIdentify: jest.fn(),
  };
  const fakePrismaService = {
    user: { upsert: jest.fn() },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://req2ado:req2ado@localhost:5432/req2ado';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MCP_URL = 'http://localhost:4100';
    process.env.MCP_BEARER = 'test-bearer';
    process.env.AUTH_JWT_SECRET = 'test-jwt-secret';
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.LLM_CHAT_MODEL = 'test-model';
    process.env.LLM_PROXY_BEARER = 'test-llm-proxy-bearer';
    process.env.EMBED_MODEL = 'test-embed-model';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AdoPatProvider)
      .useValue(fakeAdoPatProvider)
      .overrideProvider(PrismaService)
      .useValue(fakePrismaService)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('POST /auth/login returns a token on a valid PAT', async () => {
    fakeAdoPatProvider.validateAndIdentify.mockResolvedValue({
      identity: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
      displayName: 'Jane Doe',
    });
    fakePrismaService.user.upsert.mockResolvedValue({
      id: 'user-1',
      email: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
      role: 'OPERATOR',
    });

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(fakePrismaService.user.upsert).toHaveBeenCalledWith({
      where: { email: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000' },
      update: {},
      create: { email: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000', role: 'OPERATOR' },
    });

    const decoded = jwt.verify(res.body.token, 'test-jwt-secret') as { userId: string; role: string };
    expect(decoded.userId).toBe('user-1');
    expect(decoded.role).toBe('operator');
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
