import { CredentialVaultService } from '../src/modules/auth/credential-vault.service';

function makeFakePrisma() {
  const rows = new Map<string, { ownerKey: string; kind: string; ciphertext: string; iv: string; authTag: string }>();
  const keyFor = (ownerKey: string, kind: string) => `${ownerKey}|${kind}`;
  return {
    rows,
    externalCredential: {
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { ownerKey_kind: { ownerKey: string; kind: string } };
          create: { ownerKey: string; kind: string; ciphertext: string; iv: string; authTag: string };
        }) => {
          rows.set(keyFor(where.ownerKey_kind.ownerKey, where.ownerKey_kind.kind), create);
          return create;
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: { ownerKey_kind: { ownerKey: string; kind: string } } }) => {
        return rows.get(keyFor(where.ownerKey_kind.ownerKey, where.ownerKey_kind.kind)) ?? null;
      }),
      deleteMany: jest.fn(async ({ where }: { where: { ownerKey: string; kind: string } }) => {
        const existed = rows.delete(keyFor(where.ownerKey, where.kind));
        return { count: existed ? 1 : 0 };
      }),
    },
  };
}

describe('CredentialVaultService', () => {
  it('set() then get() round-trips the plaintext', async () => {
    const prisma = makeFakePrisma();
    const vault = new CredentialVaultService(prisma as any, 'current-key');

    await vault.set('user:u1', 'ado_pat', 'my-pat-value');
    const result = await vault.get('user:u1', 'ado_pat');

    expect(result).toBe('my-pat-value');
  });

  it('get() returns null for a never-stored ownerKey/kind pair', async () => {
    const prisma = makeFakePrisma();
    const vault = new CredentialVaultService(prisma as any, 'current-key');

    expect(await vault.get('user:u1', 'ado_pat')).toBeNull();
  });

  it('has() reflects whether a credential is currently stored', async () => {
    const prisma = makeFakePrisma();
    const vault = new CredentialVaultService(prisma as any, 'current-key');

    expect(await vault.has('user:u1', 'sharepoint_token')).toBe(false);
    await vault.set('user:u1', 'sharepoint_token', 'graph-token-value');
    expect(await vault.has('user:u1', 'sharepoint_token')).toBe(true);
  });

  it('delete() removes the row so a subsequent get() returns null', async () => {
    const prisma = makeFakePrisma();
    const vault = new CredentialVaultService(prisma as any, 'current-key');
    await vault.set('user:u1', 'llm_api_key', 'sk-abc');

    await vault.delete('user:u1', 'llm_api_key');

    expect(await vault.get('user:u1', 'llm_api_key')).toBeNull();
  });

  it('set() overwrites a previously stored value under the same ownerKey/kind', async () => {
    const prisma = makeFakePrisma();
    const vault = new CredentialVaultService(prisma as any, 'current-key');
    await vault.set('user:u1', 'ado_pat', 'old-pat');

    await vault.set('user:u1', 'ado_pat', 'new-pat');

    expect(await vault.get('user:u1', 'ado_pat')).toBe('new-pat');
  });

  it('falls back to the previous key on a current-key decrypt failure, and lazily re-encrypts under the current key', async () => {
    const prisma = makeFakePrisma();
    const oldVault = new CredentialVaultService(prisma as any, 'old-key');
    await oldVault.set('user:u1', 'ado_pat', 'rotated-pat-value');

    // Simulates CREDENTIAL_ENC_KEY having been rotated -- the row in the DB
    // is still encrypted under the old key, but the running process now
    // has a new current key plus the old one as CREDENTIAL_ENC_KEY_PREVIOUS.
    const rotatedVault = new CredentialVaultService(prisma as any, 'new-key', 'old-key');

    const result = await rotatedVault.get('user:u1', 'ado_pat');
    expect(result).toBe('rotated-pat-value');

    // Lazy re-encryption: the stored row should now decrypt under the new
    // key ALONE, without needing the previous-key fallback anymore.
    const freshVaultNoFallback = new CredentialVaultService(prisma as any, 'new-key');
    expect(await freshVaultNoFallback.get('user:u1', 'ado_pat')).toBe('rotated-pat-value');
  });

  it('throws (does not silently return garbage) when neither the current nor previous key can decrypt', async () => {
    const prisma = makeFakePrisma();
    const vault = new CredentialVaultService(prisma as any, 'key-a');
    await vault.set('user:u1', 'ado_pat', 'value');

    const wrongVault = new CredentialVaultService(prisma as any, 'key-b', 'also-wrong-key');

    await expect(wrongVault.get('user:u1', 'ado_pat')).rejects.toThrow();
  });
});
