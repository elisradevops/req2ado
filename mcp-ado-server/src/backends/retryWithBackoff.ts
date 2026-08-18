/**
 * Exponential backoff with jitter for ADO REST calls, per
 * docs/architecture.md's "Retry/backoff on 429/5xx + network errors, exp
 * backoff + jitter." Retries only on 429 and 5xx — 4xx (other than 429) is
 * a client error that will not succeed on retry, so it fails immediately.
 *
 * Exception: 409 Conflict is retried when it represents optimistic
 * concurrency failures (e.g. PATCH to a work item revision that changed
 * since read). A 409 means the write definitively did NOT land, so a retry
 * cannot create a duplicate relation. This safety argument applies to the
 * PATCH-based relation-write calls specifically (linkWorkItems,
 * linkParentChild) -- it is not a universal justification for every write
 * this retry helper covers. 409 is retried globally in RETRYABLE_STATUSES
 * below, which also covers createWorkItem and uploadAttachment's first call
 * (the raw-bytes POST); ADO does not 409 on those endpoints in practice, so
 * this is not a live bug, but a 409 there would not carry the same
 * "definitely didn't land" guarantee, since a create/upload could
 * plausibly conflict on some other basis.
 */
const RETRYABLE_STATUSES = new Set([409, 429, 500, 502, 503, 504]);

// TF401349 is ADO's own generic "An unexpected error has occurred, please
// verify your request and try again" catch-all, returned as an otherwise-
// ordinary HTTP 400 -- confirmed transient via two independent real
// occurrences (different jobs, different work items, different confirm()
// calls) that both cleared on an identical, unmodified retry with no code
// change in between, forcing a manual re-confirm each time. A narrow,
// code-specific carve-out -- every OTHER 400 (bad field, malformed
// payload) is still a genuine client error that will not succeed on retry
// and must fail immediately, exactly as before.
const RETRYABLE_ADO_400_CODES = ['TF401349'];

// Axios sets `.code` to one of these on a genuine transport-level failure
// (no HTTP response was ever received) — a real on-prem network is far more
// likely to hit these than a stable cloud endpoint, and they were previously
// never retried at all (isRetryable required a numeric `.response.status`).
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function isRetryableAdo400(response: { status?: number; data?: unknown } | undefined): boolean {
  if (response?.status !== 400) {
    return false;
  }
  const data = response.data as { message?: string } | string | undefined;
  const detail = typeof data === 'string' ? data : data?.message;
  return typeof detail === 'string' && RETRYABLE_ADO_400_CODES.some((code) => detail.startsWith(code));
}

function isRetryable(error: unknown): boolean {
  const err = error as { response?: { status?: number; data?: unknown }; request?: unknown; code?: string };
  const status = err?.response?.status;
  if (status !== undefined) {
    return RETRYABLE_STATUSES.has(status) || isRetryableAdo400(err.response);
  }
  // No HTTP response at all: axios sets `.request` whenever a request was
  // actually dispatched (vs. e.g. a config error thrown before send), which
  // means this is a transient network failure, not a client/auth problem.
  if (err?.request !== undefined) {
    return true;
  }
  return err?.code !== undefined && RETRYABLE_NETWORK_CODES.has(err.code);
}

/**
 * A 429's `Retry-After` header (seconds, or an HTTP date) is the server's
 * own authoritative answer for how long to wait — previously ignored in
 * favor of blind exponential backoff regardless of what ADO actually asked
 * for. Returns null when absent/unparseable, falling back to backoff.
 */
function retryAfterMs(error: unknown): number | null {
  const headers = (error as { response?: { headers?: Record<string, string> } })?.response?.headers;
  const value = headers?.['retry-after'];
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

function delayWithJitter(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 200;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) {
        throw error;
      }
      const delay = retryAfterMs(error) ?? delayWithJitter(attempt, baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
