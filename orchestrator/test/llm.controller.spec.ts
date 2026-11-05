import 'reflect-metadata';
import { BadRequestException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import OpenAI from 'openai';
import { LlmController } from '../src/modules/llm/llm.controller';
import { ModelInfoUnavailableError } from '../src/modules/llm/openwebui.client';

const USER_ID = 'user-1';

// clientFactory.getClientFor(userId) resolves to `client` for every userId
// -- these tests aren't exercising per-user resolution itself (that's
// openwebui-client.factory.spec.ts's job), just that LlmController threads
// the X-Req2Ado-User-Id header through to resolveClient() and then calls
// through to whatever client comes back.
function makeController(client: Record<string, jest.Mock>) {
  const getClientFor = jest.fn().mockResolvedValue(client);
  const controller = new LlmController({ getClientFor } as any);
  return { controller, getClientFor };
}

describe('LlmController @SkipThrottle', () => {
  it('is exempt from the global ThrottlerGuard (§16 -- internal bearer-guarded traffic, not public; the agentic KB loop fires several /llm/embed calls per branch)', () => {
    // @nestjs/throttler's SkipThrottle() decorator writes Reflect metadata
    // under `THROTTLER:SKIP${name}` (name defaults to 'default') directly
    // onto the decorated class -- see throttler.decorator.js /
    // throttler.constants.js in @nestjs/throttler's dist. Asserting the
    // literal metadata key here (rather than a live HTTP burst test, which
    // would need the full AppModule + ThrottlerGuard wired) proves the
    // decorator is actually applied without needing live Postgres/Redis.
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', LlmController)).toBe(true);
  });
});

describe('LlmController', () => {
  it('rejects with UnauthorizedException when the X-Req2Ado-User-Id header is absent', async () => {
    const { controller } = makeController({ chat: jest.fn() });
    await expect(controller.chat({ messages: [{ role: 'user', content: 'hi' }] }, undefined)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects with UnauthorizedException when the header names a user with no configured connection', async () => {
    const getClientFor = jest.fn().mockRejectedValue(new Error('no profile'));
    const controller = new LlmController({ getClientFor } as any);
    await expect(controller.chat({ messages: [{ role: 'user', content: 'hi' }] }, USER_ID)).rejects.toThrow(UnauthorizedException);
  });

  it('threads an explicit model from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const { controller } = makeController({ chat });

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'qwen2.5:14b' }, USER_ID);

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { model: 'qwen2.5:14b' });
  });

  it('threads a strict responseSchema from the request body into llmClient.chat (the flag survives validation)', async () => {
    const chat = jest.fn().mockResolvedValue({ content: '{}' });
    const { controller } = makeController({ chat });
    const responseSchema = { name: 'title_tags_by_row', schema: { type: 'object' }, strict: true };

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], responseSchema }, USER_ID);

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { responseSchema });
  });

  it('omits model from opts when not provided in the request body', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const { controller } = makeController({ chat });

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }] }, USER_ID);

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], {});
  });

  it('threads an explicit numCtx from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const { controller } = makeController({ chat });

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], numCtx: 28000 }, USER_ID);

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { numCtx: 28000 });
  });

  it('threads an explicit seed from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const { controller } = makeController({ chat });

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], seed: 42 }, USER_ID);

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { seed: 42 });
  });

  it('threads explicit topK/minP from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const { controller } = makeController({ chat });

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], topK: 50, minP: 0.05 }, USER_ID);

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { topK: 50, minP: 0.05 });
  });

  it('threads an explicit think from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const { controller } = makeController({ chat });

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], think: false }, USER_ID);

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { think: false });
  });

  it('throws BadRequestException on an invalid body', async () => {
    const { controller } = makeController({ chat: jest.fn() });
    await expect(controller.chat({}, USER_ID)).rejects.toThrow(BadRequestException);
  });

  it('POST /llm/show forwards the model and returns llmClient.showModel()', async () => {
    const showModel = jest.fn().mockResolvedValue({ contextLength: 32000, capabilities: ['completion', 'tools'] });
    const { controller } = makeController({ showModel });

    const result = await controller.show({ model: 'qwen3.6:35b' }, USER_ID);

    expect(showModel).toHaveBeenCalledWith('qwen3.6:35b');
    expect(result).toEqual({ contextLength: 32000, capabilities: ['completion', 'tools'] });
  });

  it('POST /llm/show answers 404 for a model no source can describe, not a server error', async () => {
    const showModel = jest.fn().mockRejectedValue(new ModelInfoUnavailableError('mystery', 'not listed by the proxy'));
    const { controller } = makeController({ showModel });

    await expect(controller.show({ model: 'mystery' }, USER_ID)).rejects.toThrow(NotFoundException);
  });

  it('POST /llm/show throws BadRequestException when model is missing', async () => {
    const { controller } = makeController({ showModel: jest.fn() });
    await expect(controller.show({}, USER_ID)).rejects.toThrow(BadRequestException);
  });

  it('GET /llm/models returns the catalog from llmClient.listModels()', async () => {
    const listModels = jest.fn().mockResolvedValue(['llama3.1', 'qwen2.5:14b']);
    const { controller } = makeController({ listModels });

    const result = await controller.models(USER_ID);

    expect(result).toEqual({ models: ['llama3.1', 'qwen2.5:14b'] });
  });

  it('POST /llm/chat/stream writes one ndjson line per delta and ends the response', async () => {
    async function* fakeDeltas() {
      yield { content: 'Hel' };
      yield { content: 'lo' };
    }
    const streamChat = jest.fn().mockReturnValue(fakeDeltas());
    const { controller } = makeController({ streamChat });
    const written: string[] = [];
    const res = {
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
      on: jest.fn(),
    };

    await controller.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, res as any, USER_ID);

    expect(written).toEqual([`${JSON.stringify({ delta: 'Hel' })}\n`, `${JSON.stringify({ delta: 'lo' })}\n`]);
    expect(res.end).toHaveBeenCalled();
  });

  describe('terminal done line (job transparency B7)', () => {
    const run = async (chunks: Array<Record<string, unknown>>, body: Record<string, unknown>, failAfter = false) => {
      async function* fake() {
        for (const c of chunks) yield c;
        if (failAfter) throw new Error('upstream dropped');
      }
      const { controller } = makeController({ streamChat: jest.fn().mockReturnValue(fake()) });
      const written: string[] = [];
      const res = { setHeader: jest.fn(), write: jest.fn((c: string) => written.push(c)), end: jest.fn(), on: jest.fn() };
      const outcome = await controller
        .chatStream({ messages: [{ role: 'user', content: 'hi' }], ...body }, res as any, USER_ID)
        .then(() => 'ok', () => 'error');
      return { written, res, outcome };
    };

    it('ends with {done, finishReason, model} when asked, and writes no empty line for the reason chunk', async () => {
      const { written } = await run([{ content: 'Hi' }, { finishReason: 'stop' }], { includeDone: true, model: 'gemma4:12b' });
      expect(written).toEqual([
        `${JSON.stringify({ delta: 'Hi' })}\n`,
        `${JSON.stringify({ done: true, finishReason: 'stop', model: 'gemma4:12b' })}\n`,
      ]);
    });

    it('reports a length cut-off so the caller knows the answer is incomplete', async () => {
      const { written } = await run([{ content: '{"a":' }, { finishReason: 'length' }], { includeDone: true });
      expect(JSON.parse(written[written.length - 1])).toEqual({ done: true, finishReason: 'length' });
    });

    it('omits finishReason when the upstream gave none', async () => {
      const { written } = await run([{ content: 'Hi' }], { includeDone: true });
      expect(JSON.parse(written[written.length - 1])).toEqual({ done: true });
    });

    it('writes nothing extra unless asked, even when the upstream reports a reason', async () => {
      const { written } = await run([{ content: 'Hi' }, { finishReason: 'stop' }], {});
      expect(written).toEqual([`${JSON.stringify({ delta: 'Hi' })}\n`]);
    });

    it('never writes the done line when the stream fails part-way', async () => {
      const { written, res, outcome } = await run([{ content: 'Hi' }], { includeDone: true }, true);
      expect(outcome).toBe('error');
      expect(written).toEqual([`${JSON.stringify({ delta: 'Hi' })}\n`]);
      expect(res.end).toHaveBeenCalled();
    });
  });

  it('threads an explicit seed from the request body into llmClient.streamChat', async () => {
    async function* fakeDeltas() {
      yield { content: 'Hi' };
    }
    const streamChat = jest.fn().mockReturnValue(fakeDeltas());
    const { controller } = makeController({ streamChat });
    const res = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn(), on: jest.fn() };

    await controller.chatStream({ messages: [{ role: 'user', content: 'hi' }], seed: 42 }, res as any, USER_ID);

    expect(streamChat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { seed: 42 });
  });

  it('threads numCtx/topK/minP/think from the request body into llmClient.streamChat (previously silently discarded)', async () => {
    async function* fakeDeltas() {
      yield { content: 'Hi' };
    }
    const streamChat = jest.fn().mockReturnValue(fakeDeltas());
    const { controller } = makeController({ streamChat });
    const res = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn(), on: jest.fn() };

    await controller.chatStream(
      { messages: [{ role: 'user', content: 'hi' }], numCtx: 28000, topK: 50, minP: 0.05, think: false },
      res as any,
      USER_ID,
    );

    expect(streamChat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], {
      numCtx: 28000,
      topK: 50,
      minP: 0.05,
      think: false,
    });
  });

  it('writes reasoningDelta (not delta) for a reasoning-model chunk, keeping the two fields distinct on the wire', async () => {
    async function* fakeChunks() {
      yield { reasoning: 'Hmm, ' };
      yield { content: 'Sure.' };
    }
    const streamChat = jest.fn().mockReturnValue(fakeChunks());
    const { controller } = makeController({ streamChat });
    const written: string[] = [];
    const res = {
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
      on: jest.fn(),
    };

    await controller.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, res as any, USER_ID);

    expect(written).toEqual([`${JSON.stringify({ reasoningDelta: 'Hmm, ' })}\n`, `${JSON.stringify({ delta: 'Sure.' })}\n`]);
  });

  it('stops writing further deltas once the response emits "close" (stop-generating / downstream disconnect)', async () => {
    let resolveNext: (() => void) | undefined;
    async function* fakeDeltas() {
      yield { content: 'a' };
      yield { content: 'b' };
      // Give the test a chance to invoke the registered 'close' callback
      // in between yields, simulating ingestion aborting mid-stream.
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
      yield { content: 'c' };
      yield { content: 'd' };
    }
    const streamChat = jest.fn().mockReturnValue(fakeDeltas());
    const { controller } = makeController({ streamChat });
    const written: string[] = [];
    let closeCallback: (() => void) | undefined;
    const res = {
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'close') closeCallback = cb;
      }),
    };

    const streamPromise = controller.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, res as any, USER_ID);

    // Wait for the generator to pause after yielding 'a' and 'b'.
    await new Promise((resolve) => setImmediate(resolve));
    expect(closeCallback).toBeDefined();
    closeCallback!();
    resolveNext!();

    await streamPromise;

    // 'c' is already in flight (the generator resumed and produced it
    // before the loop re-checks the flag), so it still gets written — the
    // check only stops the loop from continuing to 'd'. This is the
    // documented granularity: it stops consuming/writing further chunks as
    // soon as the current await resolves, not an instant mid-flight abort.
    expect(written).toEqual([
      `${JSON.stringify({ delta: 'a' })}\n`,
      `${JSON.stringify({ delta: 'b' })}\n`,
      `${JSON.stringify({ delta: 'c' })}\n`,
    ]);
    expect(res.end).toHaveBeenCalled();
  });

  describe('chat disconnect', () => {
    const chatBody = { messages: [{ role: 'user' as const, content: 'hi' }] };
    const fakeRes = () => {
      const handlers: Record<string, () => void> = {};
      return {
        res: { writableEnded: false, on: (event: string, handler: () => void) => { handlers[event] = handler; } } as any,
        fire: (event: string) => handlers[event]?.(),
      };
    };

    it('aborts the upstream chat call when the caller closes the connection before an answer is sent', async () => {
      let signal: AbortSignal | undefined;
      const chat = jest.fn().mockImplementation(
        (_m: unknown, opts: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal = opts.signal;
            opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const { controller } = makeController({ chat });
      const { res, fire } = fakeRes();
      const call = controller.chat(chatBody, USER_ID, res);
      await new Promise((resolve) => setImmediate(resolve));
      expect(signal?.aborted).toBe(false);
      fire('close');
      await expect(call).rejects.toThrow('aborted');
      expect(signal?.aborted).toBe(true);
    });

    it('does not abort when the connection closes after the answer was fully sent, and a call without a response object still works', async () => {
      let signal: AbortSignal | undefined;
      const chat = jest.fn().mockImplementation(async (_m: unknown, opts: { signal?: AbortSignal }) => {
        signal = opts.signal;
        return { content: 'ok' };
      });
      const { controller } = makeController({ chat });
      const { res, fire } = fakeRes();
      await controller.chat(chatBody, USER_ID, res);
      res.writableEnded = true;
      fire('close');
      expect(signal?.aborted).toBe(false);
      await expect(controller.chat(chatBody, USER_ID)).resolves.toEqual({ content: 'ok' });
    });
  });

  describe('vision budget and disconnect', () => {
    const body = { prompt: 'describe this figure', images: [Buffer.from('img').toString('base64')] };
    const fakeRes = () => {
      const handlers: Record<string, () => void> = {};
      return {
        res: { writableEnded: false, on: (event: string, handler: () => void) => { handlers[event] = handler; } } as any,
        fire: (event: string) => handlers[event]?.(),
      };
    };

    it('turns the X-Req2Ado-Deadline-Ms header into an absolute deadline for the call', async () => {
      const vision = jest.fn().mockResolvedValue('d');
      const { controller } = makeController({ vision });
      const before = Date.now();
      await controller.vision(body, USER_ID, '240000', fakeRes().res);
      const opts = vision.mock.calls[0][2];
      expect(opts.deadlineAtMs).toBeGreaterThanOrEqual(before + 240_000);
      expect(opts.deadlineAtMs).toBeLessThanOrEqual(Date.now() + 240_000);
    });

    it.each([undefined, 'abc', '0', '-5', ''])('ignores a missing or invalid deadline header (%p)', async (header) => {
      const vision = jest.fn().mockResolvedValue('d');
      const { controller } = makeController({ vision });
      await controller.vision(body, USER_ID, header as string | undefined, fakeRes().res);
      expect(vision.mock.calls[0][2]?.deadlineAtMs).toBeUndefined();
    });

    describe('upstream errors keep their HTTP status', () => {
      const apiError = (status: number, headers: Record<string, string> = {}) =>
        Object.assign(Object.create(OpenAI.APIError.prototype), { status, message: `upstream ${status}`, headers });

      it.each([400, 401, 404, 429, 502])('passes an upstream %i on to the caller instead of collapsing it to a 500', async (status) => {
        const vision = jest.fn().mockRejectedValue(apiError(status));
        const { controller } = makeController({ vision });
        const error: any = await controller.vision(body, USER_ID, undefined, fakeRes().res).catch((e) => e);
        expect(error).toBeInstanceOf(HttpException);
        expect(error.getStatus()).toBe(status);
      });

      it('forwards the provider\'s Retry-After on a 429 so the caller can wait exactly that long', async () => {
        const vision = jest.fn().mockRejectedValue(apiError(429, { 'retry-after': '7' }));
        const { controller } = makeController({ vision });
        const setHeader = jest.fn();
        const { res } = fakeRes();
        res.setHeader = setHeader;
        await controller.vision(body, USER_ID, undefined, res).catch(() => undefined);
        expect(setHeader).toHaveBeenCalledWith('Retry-After', '7');
      });

      it('leaves an error that is not an upstream HTTP error as it was', async () => {
        const vision = jest.fn().mockRejectedValue(new Error('boom'));
        const { controller } = makeController({ vision });
        await expect(controller.vision(body, USER_ID, undefined, fakeRes().res)).rejects.toThrow('boom');
      });
    });

    it('aborts the upstream call when the caller closes the connection before an answer is sent', async () => {
      let signal: AbortSignal | undefined;
      const vision = jest.fn().mockImplementation(
        (_p: string, _i: Buffer[], opts: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal = opts.signal;
            opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const { controller } = makeController({ vision });
      const { res, fire } = fakeRes();
      const call = controller.vision(body, USER_ID, undefined, res);
      await new Promise((resolve) => setImmediate(resolve));
      expect(signal?.aborted).toBe(false);
      fire('close');
      await expect(call).rejects.toThrow('aborted');
      expect(signal?.aborted).toBe(true);
    });

    it('does not abort when the connection closes after the answer was fully sent', async () => {
      let signal: AbortSignal | undefined;
      const vision = jest.fn().mockImplementation(async (_p: string, _i: Buffer[], opts: { signal?: AbortSignal }) => {
        signal = opts.signal;
        return 'd';
      });
      const { controller } = makeController({ vision });
      const { res, fire } = fakeRes();
      await controller.vision(body, USER_ID, undefined, res);
      res.writableEnded = true;
      fire('close');
      expect(signal?.aborted).toBe(false);
    });
  });

  it('threads an explicit responseSchema from the request body into llmClient.vision', async () => {
    const vision = jest.fn().mockResolvedValue('a description');
    const { controller } = makeController({ vision });

    await controller.vision(
      {
        prompt: 'describe this figure',
        images: [Buffer.from('img').toString('base64')],
        responseSchema: { name: 'figure_significance', schema: { type: 'object' } },
      },
      USER_ID,
    );

    expect(vision).toHaveBeenCalledWith(
      'describe this figure',
      [Buffer.from('img')],
      expect.objectContaining({ responseSchema: { name: 'figure_significance', schema: { type: 'object' } } }),
    );
  });
});
