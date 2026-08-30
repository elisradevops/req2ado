import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { LlmController } from '../src/modules/llm/llm.controller';

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
  it('threads an explicit model from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const controller = new LlmController({ chat, listModels: jest.fn() } as any);

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'qwen2.5:14b' });

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { model: 'qwen2.5:14b' });
  });

  it('omits model from opts when not provided in the request body', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const controller = new LlmController({ chat, listModels: jest.fn() } as any);

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], {});
  });

  it('threads an explicit numCtx from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const controller = new LlmController({ chat, listModels: jest.fn() } as any);

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], numCtx: 28000 });

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { numCtx: 28000 });
  });

  it('threads an explicit seed from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const controller = new LlmController({ chat, listModels: jest.fn() } as any);

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], seed: 42 });

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { seed: 42 });
  });

  it('threads explicit topK/minP from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const controller = new LlmController({ chat, listModels: jest.fn() } as any);

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], topK: 50, minP: 0.05 });

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { topK: 50, minP: 0.05 });
  });

  it('threads an explicit think from the request body into llmClient.chat', async () => {
    const chat = jest.fn().mockResolvedValue('reply');
    const controller = new LlmController({ chat, listModels: jest.fn() } as any);

    await controller.chat({ messages: [{ role: 'user', content: 'hi' }], think: false });

    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { think: false });
  });

  it('throws BadRequestException on an invalid body', async () => {
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn() } as any);
    await expect(controller.chat({})).rejects.toThrow(BadRequestException);
  });

  it('POST /llm/show forwards the model and returns llmClient.showModel()', async () => {
    const showModel = jest.fn().mockResolvedValue({ contextLength: 32000, capabilities: ['completion', 'tools'] });
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn(), showModel } as any);

    const result = await controller.show({ model: 'qwen3.6:35b' });

    expect(showModel).toHaveBeenCalledWith('qwen3.6:35b');
    expect(result).toEqual({ contextLength: 32000, capabilities: ['completion', 'tools'] });
  });

  it('POST /llm/show throws BadRequestException when model is missing', async () => {
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn(), showModel: jest.fn() } as any);
    await expect(controller.show({})).rejects.toThrow(BadRequestException);
  });

  it('GET /llm/models returns the catalog from llmClient.listModels()', async () => {
    const listModels = jest.fn().mockResolvedValue(['llama3.1', 'qwen2.5:14b']);
    const controller = new LlmController({ chat: jest.fn(), listModels } as any);

    const result = await controller.models();

    expect(result).toEqual({ models: ['llama3.1', 'qwen2.5:14b'] });
  });

  it('POST /llm/chat/stream writes one ndjson line per delta and ends the response', async () => {
    async function* fakeDeltas() {
      yield { content: 'Hel' };
      yield { content: 'lo' };
    }
    const streamChat = jest.fn().mockReturnValue(fakeDeltas());
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn(), streamChat } as any);
    const written: string[] = [];
    const res = {
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
      on: jest.fn(),
    };

    await controller.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, res as any);

    expect(written).toEqual([`${JSON.stringify({ delta: 'Hel' })}\n`, `${JSON.stringify({ delta: 'lo' })}\n`]);
    expect(res.end).toHaveBeenCalled();
  });

  it('threads an explicit seed from the request body into llmClient.streamChat', async () => {
    async function* fakeDeltas() {
      yield { content: 'Hi' };
    }
    const streamChat = jest.fn().mockReturnValue(fakeDeltas());
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn(), streamChat } as any);
    const res = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn(), on: jest.fn() };

    await controller.chatStream({ messages: [{ role: 'user', content: 'hi' }], seed: 42 }, res as any);

    expect(streamChat).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }], { seed: 42 });
  });

  it('writes reasoningDelta (not delta) for a reasoning-model chunk, keeping the two fields distinct on the wire', async () => {
    async function* fakeChunks() {
      yield { reasoning: 'Hmm, ' };
      yield { content: 'Sure.' };
    }
    const streamChat = jest.fn().mockReturnValue(fakeChunks());
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn(), streamChat } as any);
    const written: string[] = [];
    const res = {
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
      on: jest.fn(),
    };

    await controller.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, res as any);

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
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn(), streamChat } as any);
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

    const streamPromise = controller.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, res as any);

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

  it('threads an explicit responseSchema from the request body into llmClient.vision', async () => {
    const llmClient = { vision: jest.fn().mockResolvedValue('a description') };
    const controller = new LlmController(llmClient as any);

    await controller.vision({
      prompt: 'describe this figure',
      images: [Buffer.from('img').toString('base64')],
      responseSchema: { name: 'figure_significance', schema: { type: 'object' } },
    });

    expect(llmClient.vision).toHaveBeenCalledWith(
      'describe this figure',
      [Buffer.from('img')],
      expect.objectContaining({ responseSchema: { name: 'figure_significance', schema: { type: 'object' } } }),
    );
  });
});
