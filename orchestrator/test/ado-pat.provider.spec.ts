import { AdoPatProvider } from '../src/modules/auth/ado-pat.provider';

describe('AdoPatProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('extracts descriptor and displayName from a valid connectionData response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        authenticatedUser: {
          descriptor: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
          providerDisplayName: 'Jane Doe',
        },
      }),
    } as Response);

    const provider = new AdoPatProvider();
    const result = await provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'fake-pat');

    expect(result).toEqual({
      identity: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000',
      displayName: 'Jane Doe',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://tfs.internal/tfs/Collection/_apis/connectionData?api-version=7.1',
      { headers: { Authorization: expect.stringMatching(/^Basic /) } },
    );
  });

  it('falls back to descriptor as displayName when providerDisplayName is absent', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        authenticatedUser: { descriptor: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000' },
      }),
    } as Response);

    const provider = new AdoPatProvider();
    const result = await provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'fake-pat');

    expect(result.displayName).toBe('Microsoft.TeamFoundation.Identity;S-1-5-21-000');
  });

  it('throws when the ADO server rejects the request', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

    const provider = new AdoPatProvider();
    await expect(
      provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'bad-pat'),
    ).rejects.toThrow('ADO connectionData validation failed: 401');
  });

  it('throws when the response is missing authenticatedUser.descriptor', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    const provider = new AdoPatProvider();
    await expect(
      provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'fake-pat'),
    ).rejects.toThrow('ADO connectionData response missing authenticatedUser.descriptor');
  });
});
