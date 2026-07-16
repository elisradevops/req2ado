import { BadRequestException } from '@nestjs/common';
import { LlmController } from '../src/modules/llm/llm.controller';

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

  it('throws BadRequestException on an invalid body', async () => {
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn() } as any);
    await expect(controller.chat({})).rejects.toThrow(BadRequestException);
  });

  it('GET /llm/models returns the catalog from llmClient.listModels()', async () => {
    const listModels = jest.fn().mockResolvedValue(['llama3.1', 'qwen2.5:14b']);
    const controller = new LlmController({ chat: jest.fn(), listModels } as any);

    const result = await controller.models();

    expect(result).toEqual({ models: ['llama3.1', 'qwen2.5:14b'] });
  });

  it('POST /llm/chat/stream writes one ndjson line per delta and ends the response', async () => {
    async function* fakeDeltas() {
      yield 'Hel';
      yield 'lo';
    }
    const streamChat = jest.fn().mockReturnValue(fakeDeltas());
    const controller = new LlmController({ chat: jest.fn(), listModels: jest.fn(), streamChat } as any);
    const written: string[] = [];
    const res = {
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
    };

    await controller.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, res as any);

    expect(written).toEqual([`${JSON.stringify({ delta: 'Hel' })}\n`, `${JSON.stringify({ delta: 'lo' })}\n`]);
    expect(res.end).toHaveBeenCalled();
  });
});
