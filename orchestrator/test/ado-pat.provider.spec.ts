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
      'https://tfs.internal/tfs/Collection/_apis/connectionData?api-version=7.2-preview',
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

  it('throws immediately on a 401 without trying other api-versions in the ladder', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 401, text: async () => 'expired PAT' } as Response);

    const provider = new AdoPatProvider();
    await expect(
      provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'bad-pat'),
    ).rejects.toThrow('ADO connectionData validation failed: 401');
    // A 401 is an auth failure, not an api-version mismatch — retrying other
    // versions would never fix it, so the ladder must not be walked further.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('advances to the next api-version in the ladder on a 400, and succeeds there', async () => {
    // Reproduces the real on-prem Azure DevOps Server 2022.x case: 7.2-preview
    // is rejected with 400; the server accepts 7.1-preview instead.
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'preview version required' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ authenticatedUser: { descriptor: 'id-1', providerDisplayName: 'Jane Doe' } }),
      } as Response);

    const provider = new AdoPatProvider();
    const result = await provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'fake-pat');

    expect(result).toEqual({ identity: 'id-1', displayName: 'Jane Doe' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://tfs.internal/tfs/Collection/_apis/connectionData?api-version=7.2-preview',
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://tfs.internal/tfs/Collection/_apis/connectionData?api-version=7.1-preview',
      expect.anything(),
    );
  });

  it('throws with the last failure once the whole ladder is exhausted', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 400, text: async () => 'preview version required' } as Response);

    const provider = new AdoPatProvider();
    await expect(
      provider.validateAndIdentify('https://tfs.internal/tfs/Collection', 'fake-pat'),
    ).rejects.toThrow('ADO connectionData validation failed: 400');
    // 7.2-preview, 7.1-preview, 6.0-preview, none — every rung tried once.
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

  describe('the person behind the token', () => {
    const connection = (user: Record<string, unknown>) =>
      jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ authenticatedUser: { descriptor: 'desc-1', providerDisplayName: 'Jane Doe', ...user } }) } as Response);

    it('reads the account name, e-mail and id ADO reports', async () => {
      connection({ id: '11111111-2222-3333-4444-555555555555', properties: { Account: { $value: 'CORP\\jane' }, Mail: { $value: 'jane@corp.example' } } });

      const result = await new AdoPatProvider().validateAndIdentify('https://tfs.internal/tfs/Collection', 'pat');

      expect(result).toEqual({ identity: 'desc-1', displayName: 'Jane Doe', email: 'jane@corp.example', accountName: 'CORP\\jane', adoUserGuid: '11111111-2222-3333-4444-555555555555' });
    });

    it('uses the account name as the e-mail when it is one and no Mail is given', async () => {
      connection({ properties: { Account: { $value: 'jane@corp.example' } } });

      const result = await new AdoPatProvider().validateAndIdentify('https://tfs.internal/tfs/Collection', 'pat');

      expect(result).toMatchObject({ email: 'jane@corp.example', accountName: 'jane@corp.example' });
    });

    it('does not take an account name that is not an address for an e-mail', async () => {
      connection({ properties: { Account: { $value: 'CORP\\jane' } } });

      const result = await new AdoPatProvider().validateAndIdentify('https://tfs.internal/tfs/Collection', 'pat');

      expect(result.email).toBeUndefined();
      expect(result.accountName).toBe('CORP\\jane');
    });

    it('ignores properties of the wrong shape instead of failing the sign-in', async () => {
      connection({ id: 42, properties: { Account: 'plain', Mail: { $value: 7 } } });

      const result = await new AdoPatProvider().validateAndIdentify('https://tfs.internal/tfs/Collection', 'pat');

      expect(result).toEqual({ identity: 'desc-1', displayName: 'Jane Doe' });
    });
  });
});
