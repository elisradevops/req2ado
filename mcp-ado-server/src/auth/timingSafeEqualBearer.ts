import { timingSafeEqual } from 'crypto';

/**
 * Constant-time comparison for bearer-token headers. Plain string `!==`
 * short-circuits on the first mismatched byte, which is a (low-risk on an
 * internal network, but real) timing side-channel — flagged explicitly in
 * server.ts's own Phase 0 comment as deferred to Phase 8 hardening.
 * Buffers of different lengths are handled explicitly (timingSafeEqual
 * throws on length mismatch) rather than let that throw propagate.
 */
export function timingSafeEqualBearer(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
