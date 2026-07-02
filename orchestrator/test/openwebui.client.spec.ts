import { OpenWebUiClient } from '../src/modules/llm/openwebui.client';

describe('OpenWebUiClient', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_API_KEY: undefined,
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_TRUSTED_LOCAL: false,
  };

  it('redacts messages before sending, by default', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'contact jane@example.com' }]);

    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'contact <redacted>' }],
        model: 'llama3.1',
      }),
    );
  });

  it('does NOT redact when LLM_TRUSTED_LOCAL is true', async () => {
    const trustedClient = new OpenWebUiClient({ ...config, LLM_TRUSTED_LOCAL: true });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    trustedClient.openai.chat.completions.create = fakeCreate;

    await trustedClient.chat([{ role: 'user', content: 'contact jane@example.com' }]);

    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'contact jane@example.com' }] }),
    );
  });

  it('returns the response content string', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'The answer is 42.' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('The answer is 42.');
  });

  it('passes temperature through when provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0 });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it('embed() throws not-implemented in this phase', async () => {
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/not implemented/i);
  });

  it('vision() throws not-implemented in this phase', async () => {
    const client = new OpenWebUiClient(config);
    await expect(client.vision('prompt', [])).rejects.toThrow(/not implemented/i);
  });
});
