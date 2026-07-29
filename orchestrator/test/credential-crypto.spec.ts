import { decryptCredential, encryptCredential } from '../src/modules/auth/credential-crypto';

const SECRET = 'test-encryption-secret';

describe('credential-crypto', () => {
  it('round-trips: decrypting what was just encrypted returns the original plaintext', () => {
    const payload = encryptCredential('super-secret-pat-value', 'user:u1', 'ado_pat', SECRET);
    const plaintext = decryptCredential(payload, 'user:u1', 'ado_pat', SECRET);
    expect(plaintext).toBe('super-secret-pat-value');
  });

  it('never stores the plaintext in the ciphertext field verbatim', () => {
    const payload = encryptCredential('super-secret-pat-value', 'user:u1', 'ado_pat', SECRET);
    expect(payload.ciphertext).not.toContain('super-secret-pat-value');
  });

  it('produces a different ciphertext each time (random IV) even for the same plaintext', () => {
    const a = encryptCredential('same-value', 'user:u1', 'ado_pat', SECRET);
    const b = encryptCredential('same-value', 'user:u1', 'ado_pat', SECRET);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('fails to decrypt with the wrong key -- a stale/rotated-out key must not silently succeed', () => {
    const payload = encryptCredential('super-secret-pat-value', 'user:u1', 'ado_pat', SECRET);
    expect(() => decryptCredential(payload, 'user:u1', 'ado_pat', 'wrong-secret')).toThrow();
  });

  it('fails to decrypt when the ownerKey does not match what it was encrypted with (AAD binding)', () => {
    const payload = encryptCredential('super-secret-pat-value', 'user:u1', 'ado_pat', SECRET);
    expect(() => decryptCredential(payload, 'user:u2', 'ado_pat', SECRET)).toThrow();
  });

  it('fails to decrypt when the kind does not match what it was encrypted with (AAD binding)', () => {
    const payload = encryptCredential('super-secret-pat-value', 'user:u1', 'ado_pat', SECRET);
    expect(() => decryptCredential(payload, 'user:u1', 'sharepoint_token', SECRET)).toThrow();
  });

  it('fails to decrypt a tampered ciphertext rather than returning corrupted plaintext', () => {
    const payload = encryptCredential('super-secret-pat-value', 'user:u1', 'ado_pat', SECRET);
    const tamperedBytes = Buffer.from(payload.ciphertext, 'base64');
    tamperedBytes[0] ^= 0xff;
    const tampered = { ...payload, ciphertext: tamperedBytes.toString('base64') };
    expect(() => decryptCredential(tampered, 'user:u1', 'ado_pat', SECRET)).toThrow();
  });
});
