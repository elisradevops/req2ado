import { AdoCredentialResolver } from '../src/modules/auth/ado-credential.resolver';

describe('AdoCredentialResolver', () => {
  it('returns undefined when the user has no vaulted ADO credential', async () => {
    const vault = { get: jest.fn().mockResolvedValue(null) };
    const resolver = new AdoCredentialResolver(vault as any);

    const result = await resolver.resolve('user-1');

    expect(result).toBeUndefined();
    expect(vault.get).toHaveBeenCalledWith('user:user-1', 'ado_pat');
  });

  it('parses the stored JSON into {orgUrl, pat}', async () => {
    const vault = { get: jest.fn().mockResolvedValue(JSON.stringify({ orgUrl: 'https://ado.example', pat: 'secret-pat' })) };
    const resolver = new AdoCredentialResolver(vault as any);

    const result = await resolver.resolve('user-1');

    expect(result).toEqual({ orgUrl: 'https://ado.example', pat: 'secret-pat' });
  });

  it('returns undefined (not a throw) when the stored value is corrupt/non-JSON', async () => {
    const vault = { get: jest.fn().mockResolvedValue('not-valid-json{{{') };
    const resolver = new AdoCredentialResolver(vault as any);

    const result = await resolver.resolve('user-1');

    expect(result).toBeUndefined();
  });
});
