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
 *
 * DUPLICATED, not imported, at
 * mcp-ado-server/src/auth/timingSafeEqualBearer.ts — see that file's own
 * header comment for why (same rationale as frontend/orchestrator's
 * canNest.ts) and mcp-ado-server/test/timingSafeEqualBearer.test.ts for
 * the drift guard.
 */
export function timingSafeEqualBearer(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
