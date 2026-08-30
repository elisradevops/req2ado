import { timingSafeEqual } from 'crypto';

/**
 * Constant-time comparison for bearer-token headers. Plain string `!==`
 * short-circuits on the first mismatched byte, which is a (low-risk on an
 * internal network, but real) timing side-channel — flagged explicitly in
 * server.ts's own Phase 0 comment as deferred to Phase 8 hardening.
 * Buffers of different lengths are handled explicitly (timingSafeEqual
 * throws on length mismatch) rather than let that throw propagate.
 *
 * DUPLICATED, not imported, at
 * orchestrator/src/modules/llm/timing-safe-equal-bearer.ts — same
 * deliberate-duplication rationale as frontend/orchestrator's canNest.ts
 * (see its own header comment): mcp-ado-server and orchestrator are
 * separate deployables with no shared runtime TS package today
 * (@req2ado/shared-ts ships generated types only, with no build step).
 * See test/timingSafeEqualBearer.test.ts for the mechanical drift guard
 * that keeps the two copies byte-identical instead.
 */
export function timingSafeEqualBearer(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
