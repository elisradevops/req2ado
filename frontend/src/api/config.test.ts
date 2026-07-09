import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadRuntimeConfig } from './config';

describe('loadRuntimeConfig', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ apiBaseUrl: 'http://api.test' }) }));
  });

  it('fetches /config.json and returns the parsed config', async () => {
    const config = await loadRuntimeConfig();
    expect(config).toEqual({ apiBaseUrl: 'http://api.test' });
    expect(fetch).toHaveBeenCalledWith('/config.json');
  });
});
