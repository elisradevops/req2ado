import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { getLlmConnectionModels } from './llmConnection';

vi.mock('./httpClient');

describe('getLlmConnectionModels', () => {
  it('sends a token being previewed in a POST body, never in the URL where every access log would keep an API key', async () => {
    const get = vi.mocked(httpClient.get).mockClear();
    const post = vi.mocked(httpClient.post).mockClear().mockResolvedValue({ data: { models: [{ id: 'm', name: 'm', vision: false }] } });

    const models = await getLlmConnectionModels('sk-candidate-secret');

    expect(post).toHaveBeenCalledWith('/llm/connection/models/preview', { token: 'sk-candidate-secret' });
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(post.mock.calls[0][0])).not.toContain('sk-candidate-secret');
    expect(models).toEqual([{ id: 'm', name: 'm', vision: false }]);
  });

  it('lists the models of the stored connection with a plain GET and no parameters', async () => {
    const get = vi.mocked(httpClient.get).mockClear().mockResolvedValue({ data: { models: [] } });
    const post = vi.mocked(httpClient.post).mockClear();

    await getLlmConnectionModels();

    expect(get).toHaveBeenCalledWith('/llm/connection/models');
    expect(post).not.toHaveBeenCalled();
  });
});
