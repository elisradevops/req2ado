import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WsAdapter } from '@nestjs/platform-ws';
import { OpenWebUiClient } from '../src/modules/llm/openwebui.client';

describe('LlmController (e2e)', () => {
  let app: INestApplication;
  const fakeOpenWebUiClient = { chat: jest.fn(), embed: jest.fn(), vision: jest.fn() };

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
      .overrideProvider(OpenWebUiClient)
      .useValue(fakeOpenWebUiClient)
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

  it('returns 401 with no Authorization header', async () => {
    const res = await request(app.getHttpServer())
      .post('/llm/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
  });

  it('returns 401 with the wrong bearer token', async () => {
    const res = await request(app.getHttpServer())
      .post('/llm/chat')
      .set('Authorization', 'Bearer wrong-token')
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
  });

  it('returns 400 on a malformed body (missing messages)', async () => {
    const res = await request(app.getHttpServer())
      .post('/llm/chat')
      .set('Authorization', 'Bearer test-llm-proxy-bearer')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns the chat content on a valid request with the correct bearer', async () => {
    fakeOpenWebUiClient.chat.mockResolvedValue({ content: 'The unit shall survive a 1m drop.' });
    const res = await request(app.getHttpServer())
      .post('/llm/chat')
      .set('Authorization', 'Bearer test-llm-proxy-bearer')
      .send({ messages: [{ role: 'user', content: 'summarize the drop spec' }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ content: 'The unit shall survive a 1m drop.' });
  });

  it('passes temperature through to OpenWebUiClient.chat when provided', async () => {
    fakeOpenWebUiClient.chat.mockResolvedValue({ content: 'ok' });
    await request(app.getHttpServer())
      .post('/llm/chat')
      .set('Authorization', 'Bearer test-llm-proxy-bearer')
      .send({ messages: [{ role: 'user', content: 'hi' }], temperature: 0 });
    expect(fakeOpenWebUiClient.chat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hi' }],
      { temperature: 0 },
    );
  });

  describe('POST /llm/embed', () => {
    it('returns 401 with no Authorization header', async () => {
      const res = await request(app.getHttpServer()).post('/llm/embed').send({ texts: ['hi'] });
      expect(res.status).toBe(401);
    });

    it('returns 400 on a malformed body (missing texts)', async () => {
      const res = await request(app.getHttpServer())
        .post('/llm/embed')
        .set('Authorization', 'Bearer test-llm-proxy-bearer')
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns embeddings on a valid request', async () => {
      fakeOpenWebUiClient.embed.mockResolvedValue([[0.1, 0.2, 0.3]]);
      const res = await request(app.getHttpServer())
        .post('/llm/embed')
        .set('Authorization', 'Bearer test-llm-proxy-bearer')
        .send({ texts: ['The unit shall survive a drop.'] });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ embeddings: [[0.1, 0.2, 0.3]] });
    });
  });

  describe('POST /llm/vision', () => {
    it('returns 401 with no Authorization header', async () => {
      const res = await request(app.getHttpServer())
        .post('/llm/vision')
        .send({ prompt: 'describe this', images: ['aGVsbG8='] });
      expect(res.status).toBe(401);
    });

    it('returns 400 on a malformed body (missing images)', async () => {
      const res = await request(app.getHttpServer())
        .post('/llm/vision')
        .set('Authorization', 'Bearer test-llm-proxy-bearer')
        .send({ prompt: 'describe this' });
      expect(res.status).toBe(400);
    });

    it('decodes base64 images to Buffers and returns the description on a valid request', async () => {
      fakeOpenWebUiClient.vision.mockResolvedValue('A block diagram showing power distribution.');
      const res = await request(app.getHttpServer())
        .post('/llm/vision')
        .set('Authorization', 'Bearer test-llm-proxy-bearer')
        .send({ prompt: 'describe this figure', images: [Buffer.from('fake-png-bytes').toString('base64')] });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ description: 'A block diagram showing power distribution.' });
      expect(fakeOpenWebUiClient.vision).toHaveBeenCalledWith(
        'describe this figure',
        [Buffer.from('fake-png-bytes')],
        undefined,
      );
    });

    it('forwards an explicit model override when provided', async () => {
      fakeOpenWebUiClient.vision.mockResolvedValue('ok');
      await request(app.getHttpServer())
        .post('/llm/vision')
        .set('Authorization', 'Bearer test-llm-proxy-bearer')
        .send({ prompt: 'describe', images: ['aGVsbG8='], model: 'llava' });
      expect(fakeOpenWebUiClient.vision).toHaveBeenCalledWith('describe', [Buffer.from('hello')], { model: 'llava' });
    });

    it('forwards an explicit mimeType when provided (a real non-PNG image)', async () => {
      fakeOpenWebUiClient.vision.mockResolvedValue('ok');
      await request(app.getHttpServer())
        .post('/llm/vision')
        .set('Authorization', 'Bearer test-llm-proxy-bearer')
        .send({ prompt: 'describe', images: ['aGVsbG8='], mimeType: 'image/jpeg' });
      expect(fakeOpenWebUiClient.vision).toHaveBeenCalledWith('describe', [Buffer.from('hello')], { mimeType: 'image/jpeg' });
    });
  });
});

describe('timingSafeEqualBearer', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { timingSafeEqualBearer } = require('../src/modules/llm/timing-safe-equal-bearer');

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
