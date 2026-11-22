import 'reflect-metadata';
import { LlmController } from '../src/modules/llm/llm.controller';
import { TokenUsageRecorder, usageOf } from '../src/modules/llm/token-usage';

describe('usageOf', () => {
  it('reads prompt, completion, cached and reasoning counts from an OpenAI-style usage object', () => {
    expect(
      usageOf({
        prompt_tokens: 1200,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 1000 },
        completion_tokens_details: { reasoning_tokens: 200 },
      }),
    ).toEqual({ promptTokens: 1200, completionTokens: 300, cachedTokens: 1000, reasoningTokens: 200 });
  });

  it('keeps zero as a real count and leaves out what the upstream did not report', () => {
    expect(usageOf({ prompt_tokens: 50, completion_tokens: 0 })).toEqual({ promptTokens: 50, completionTokens: 0 });
  });

  it('returns undefined when there is nothing usable, rather than inventing zeros', () => {
    expect(usageOf(undefined)).toBeUndefined();
    expect(usageOf(null)).toBeUndefined();
    expect(usageOf({})).toBeUndefined();
    expect(usageOf({ prompt_tokens: 'many', completion_tokens: -5, prompt_tokens_details: { cached_tokens: NaN } })).toBeUndefined();
  });
});

describe('TokenUsageRecorder', () => {
  it('adds the call in one statement keyed by job, stage and model', async () => {
    const executeRaw = jest.fn().mockResolvedValue(1);
    await new TokenUsageRecorder({ $executeRaw: executeRaw } as any).record({
      jobId: 'job-1',
      stage: 'propose_acceptance_criteria',
      model: 'm1',
      usage: { promptTokens: 100, completionTokens: 40, cachedTokens: 20 },
    });

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('ON CONFLICT ("jobId", "stage", "model")');
    expect(values).toEqual(['job-1', 'propose_acceptance_criteria', 'm1', 100, 40, 20, 0]);
  });

  it('still counts the call when the upstream reported no usage', async () => {
    const executeRaw = jest.fn().mockResolvedValue(1);
    await new TokenUsageRecorder({ $executeRaw: executeRaw } as any).record({ jobId: 'job-1', stage: 'other', model: 'm1' });
    expect(executeRaw.mock.calls[0].slice(1)).toEqual(['job-1', 'other', 'm1', 0, 0, 0, 0]);
  });

  it('never fails the call it describes: a database error is logged and swallowed', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const executeRaw = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(new TokenUsageRecorder({ $executeRaw: executeRaw } as any).record({ jobId: 'job-1', stage: 's', model: 'm' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('LlmController /chat token ledger', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];
  const build = (chatResult: unknown) => {
    const record = jest.fn().mockResolvedValue(undefined);
    const client = { chat: jest.fn().mockResolvedValue(chatResult), chatModel: 'default-model' };
    const controller = new LlmController({ getClientFor: jest.fn().mockResolvedValue(client) } as any, { record } as any);
    return { controller, record };
  };

  it('records the call under the job and stage named in the headers, and returns the usage to the caller', async () => {
    const result = { content: '{}', usage: { promptTokens: 10, completionTokens: 5 } };
    const { controller, record } = build(result);

    await expect(controller.chat({ messages, model: 'm1' }, 'user-1', undefined, 'job-1', 'score_requirements_for_document')).resolves.toBe(result);

    expect(record).toHaveBeenCalledWith({ jobId: 'job-1', stage: 'score_requirements_for_document', model: 'm1', usage: result.usage });
  });

  it('falls back to the default model and an "other" stage', async () => {
    const { controller, record } = build({ content: '{}' });
    await controller.chat({ messages }, 'user-1', undefined, 'job-1');
    expect(record).toHaveBeenCalledWith({ jobId: 'job-1', stage: 'other', model: 'default-model' });
  });

  it('under a router (Auto), records the tokens under the model the answer says it was sent to, and returns that routing', async () => {
    const result = { content: '{}', routing: { model: 'OpenAI/gpt-5.4', tier: 'MEDIUM' } };
    const { controller, record } = build(result);
    await expect(controller.chat({ messages, model: 'Auto' }, 'user-1', undefined, 'job-1', 's')).resolves.toBe(result);
    expect(record).toHaveBeenCalledWith({ jobId: 'job-1', stage: 's', model: 'OpenAI/gpt-5.4' });
  });

  it('records nothing for a call that names no job', async () => {
    const { controller, record } = build({ content: '{}' });
    await controller.chat({ messages }, 'user-1');
    expect(record).not.toHaveBeenCalled();
  });
});
