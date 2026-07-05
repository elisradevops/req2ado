import { timingSafeEqual } from 'crypto';

/**
 * A naive `actual === expected` bearer-token comparison leaks timing
 * information proportional to the number of matching leading characters,
 * letting an attacker guess a valid token byte-by-byte. `timingSafeEqual`
 * closes that side channel but throws if the two buffers differ in length,
 * so the length check must happen first — this is safe because the
 * attacker already knows the expected token's length (it is fixed by
 * config), so revealing it via a fast-path length mismatch leaks nothing
 * new.
 */
export function timingSafeEqualBearer(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
