/**
 * Exponential backoff with jitter for the Ollama-native embed()/showModel()
 * fetch calls in OpenWebUiClient -- these are idempotent GETs-in-spirit (pure
 * reads), unlike chat()/streamChat()/vision(), which must NOT be retried here
 * (see OpenWebUiClient's maxRetries:0 comment for why blind retry of a
 * non-idempotent, multi-minute inference call is actively harmful).
 *
 * Mirrors mcp-ado-server/src/backends/retryWithBackoff.ts's ADO-call pattern
 * (429/5xx + Retry-After honored, exponential backoff + jitter), adapted for
 * fetch's Response shape instead of axios's thrown-error shape.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
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

export async function fetchWithRetry(
  fn: () => Promise<Response>,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 200;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fn();
      if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) {
        return response;
      }
      const delay = retryAfterMs(response) ?? delayWithJitter(attempt, baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      // A genuine network failure (fetch itself rejects, no Response at all)
      // is also transient-by-default -- same reasoning as the ADO version's
      // `.request !== undefined` check: a request was dispatched, just never
      // answered.
      lastError = error;
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayWithJitter(attempt, baseDelayMs)));
    }
  }
  throw lastError;
}
