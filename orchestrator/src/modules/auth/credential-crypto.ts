import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// AES-256-GCM: authenticated encryption (a tampered ciphertext fails to
// decrypt rather than silently returning garbage) -- required for
// something as sensitive as an ADO PAT, unlike a plain CBC/CTR cipher.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM-recommended size (not 16).

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

// CREDENTIAL_ENC_KEY is an operator-supplied passphrase (arbitrary length,
// not necessarily 32 bytes) -- scrypt derives a real 256-bit key from it.
// The salt is fixed and public (not secret -- scrypt's cost factor is what
// resists brute force here, same reasoning as bcrypt's own fixed-cost
// design), so every process derives the identical key from the same env
// var without needing to persist a per-install salt anywhere.
function deriveKey(secret: string): Buffer {
  return scryptSync(secret, 'req2ado-credential-vault', 32);
}

/**
 * AAD (additional authenticated data) binds the ciphertext to WHO it
 * belongs to and WHAT KIND of credential it is -- GCM verifies this on
 * decrypt, so a ciphertext row can't be copied onto a different
 * ownerKey/kind pair and decrypt successfully even though the raw bytes
 * would otherwise "work" (same key, same algorithm).
 */
function buildAad(ownerKey: string, kind: string): Buffer {
  return Buffer.from(`${ownerKey}|${kind}`, 'utf-8');
}

export function encryptCredential(plaintext: string, ownerKey: string, kind: string, secret: string): EncryptedPayload {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(buildAad(ownerKey, kind));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptCredential(payload: EncryptedPayload, ownerKey: string, kind: string, secret: string): string {
  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(buildAad(ownerKey, kind));
  // setAuthTag before update(), not just before final() -- required for
  // GCM to actually verify integrity rather than silently accepting a
  // tampered ciphertext until the final() call.
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);
  return plaintext.toString('utf-8');
}
