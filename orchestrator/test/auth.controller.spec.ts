import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../src/modules/auth/auth.controller';
import type { SessionUser } from '../src/modules/auth/session.service';

const TEST_USER: SessionUser = { userId: 'Microsoft.TeamFoundation.Identity;S-1-5-21-000', displayName: 'Jane Doe' };

function makeRes() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

describe('AuthController.updateAdoCredential', () => {
  it('re-vaults the PAT when the re-entered credential resolves to the SAME identity as the current session', async () => {
    const adoPatProvider = { validateAndIdentify: jest.fn().mockResolvedValue({ identity: TEST_USER.userId, displayName: 'Jane Doe' }) };
    const credentialVault = { set: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthController(adoPatProvider as any, {} as any, credentialVault as any);

    const result = await controller.updateAdoCredential(TEST_USER, { adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'rotated-pat' });

    expect(result).toEqual({ ok: true });
    expect(credentialVault.set).toHaveBeenCalledWith(
      `user:${TEST_USER.userId}`,
      'ado_pat',
      JSON.stringify({ orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'rotated-pat' }),
    );
  });

  it('rejects (does not re-vault) when the re-entered PAT belongs to a DIFFERENT ADO identity than the current session', async () => {
    const adoPatProvider = {
      validateAndIdentify: jest.fn().mockResolvedValue({ identity: 'someone-elses-descriptor', displayName: 'Someone Else' }),
    };
    const credentialVault = { set: jest.fn() };
    const controller = new AuthController(adoPatProvider as any, {} as any, credentialVault as any);

    await expect(
      controller.updateAdoCredential(TEST_USER, { adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'someone-elses-pat' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(credentialVault.set).not.toHaveBeenCalled();
  });

  it('rejects when the PAT itself fails ADO validation', async () => {
    const adoPatProvider = { validateAndIdentify: jest.fn().mockRejectedValue(new Error('401')) };
    const credentialVault = { set: jest.fn() };
    const controller = new AuthController(adoPatProvider as any, {} as any, credentialVault as any);

    await expect(
      controller.updateAdoCredential(TEST_USER, { adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'bad-pat' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(credentialVault.set).not.toHaveBeenCalled();
  });

  it('rejects an invalid request body (missing pat)', async () => {
    const controller = new AuthController({} as any, {} as any, {} as any);

    await expect(controller.updateAdoCredential(TEST_USER, { adoOrgUrl: 'https://tfs.internal/tfs/Collection' })).rejects.toThrow();
  });
});

describe('AuthController.login', () => {
  it('vaults the PAT (keyed to the identified user) alongside issuing the session cookie', async () => {
    const adoPatProvider = {
      validateAndIdentify: jest.fn().mockResolvedValue({ identity: TEST_USER.userId, displayName: 'Jane Doe' }),
    };
    const sessionService = { create: jest.fn().mockResolvedValue('raw-session-token') };
    const credentialVault = { set: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthController(adoPatProvider as any, sessionService as any, credentialVault as any);
    const res = makeRes();

    const result = await controller.login({ adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fresh-pat' }, res as any);

    expect(result).toEqual({ displayName: 'Jane Doe', userId: TEST_USER.userId });
    expect(credentialVault.set).toHaveBeenCalledWith(
      `user:${TEST_USER.userId}`,
      'ado_pat',
      JSON.stringify({ orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fresh-pat' }),
    );
    expect(res.cookie).toHaveBeenCalled();
  });

  it('rejects when the PAT itself fails ADO validation', async () => {
    const adoPatProvider = { validateAndIdentify: jest.fn().mockRejectedValue(new Error('fetch failed')) };
    const controller = new AuthController(adoPatProvider as any, {} as any, {} as any);
    const res = makeRes();

    await expect(controller.login({ adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'bad-pat' }, res as any)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('reports a distinct message (not "invalid credential") when the PAT validates but session/vault setup fails', async () => {
    const adoPatProvider = {
      validateAndIdentify: jest.fn().mockResolvedValue({ identity: TEST_USER.userId, displayName: 'Jane Doe' }),
    };
    const sessionService = { create: jest.fn().mockRejectedValue(new Error('database unreachable')) };
    const credentialVault = { set: jest.fn() };
    const controller = new AuthController(adoPatProvider as any, sessionService as any, credentialVault as any);
    const res = makeRes();

    await expect(
      controller.login({ adoOrgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fresh-pat' }, res as any),
    ).rejects.toThrow('Sign-in succeeded but the server failed to establish a session. Please try again.');
    expect(res.cookie).not.toHaveBeenCalled();
  });
});
