/**
 * Exponential backoff with jitter for ADO REST calls, per
 * docs/architecture.md's "Retry/backoff on 429/5xx + network errors, exp
 * backoff + jitter." Retries only on 429 and 5xx — 4xx (other than 429) is
 * a client error that will not succeed on retry, so it fails immediately.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

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

function isRetryable(error: unknown): boolean {
  const err = error as { response?: { status?: number }; request?: unknown; code?: string };
  const status = err?.response?.status;
  if (status !== undefined) {
    return RETRYABLE_STATUSES.has(status);
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
