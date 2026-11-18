const MAX_LENGTH = 500;
const MAX_CAUSES = 3;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function messageOf(value: unknown): string {
  try {
    if (value instanceof Error) {
      const code = (value as { code?: unknown }).code;
      return typeof code === 'string' && code ? `${code}: ${oneLine(value.message)}` : oneLine(value.message);
    }
    if (typeof value === 'string') return oneLine(value);
    if (value && typeof value === 'object') return oneLine(String((value as { message?: unknown }).message ?? ''));
  } catch {
    // a hostile or broken error object must not hide the failure it describes
  }
  return '';
}

/**
 * The reason to store for a failed job. Node's fetch reports every network failure as "fetch failed" and keeps the
 * real cause (a timeout code, a reset connection) in `error.cause`; storing only the message left the job with no usable
 * reason. The first line is the error itself, the causes follow in brackets.
 */
export function describeFailure(error: unknown): string {
  const head = messageOf(error) || 'unknown error';
  const causes: string[] = [];
  let current: unknown = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  while (current !== undefined && current !== null && causes.length < MAX_CAUSES) {
    const text = messageOf(current);
    if (text) causes.push(text);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  const text = causes.length ? `${head} (${causes.join(' <- ')})` : head;
  return text.slice(0, MAX_LENGTH);
}

/** What kind of failure it was, in a closed vocabulary the page can name in plain words and the Jobs list can show in short. */
export const FAILURE_CLASSES = ['budget_exhausted', 'connection_reset', 'timeout', 'refused', 'unreadable_response', 'unknown'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

const CLASS_PATTERNS: Array<{ failureClass: FailureClass; test: RegExp }> = [
  // First: the budget refusal's text can also mention a timeout or a status code, and it is the one cause that retrying cannot fix.
  { failureClass: 'budget_exhausted', test: /LLM_BUDGET_EXCEEDED/ },
  { failureClass: 'connection_reset', test: /UND_ERR_SOCKET|ECONNRESET|other side closed|socket hang up/i },
  { failureClass: 'timeout', test: /timeout|timed out|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i },
  // A refusal needs the status or the words: a bare 401 or 403 inside other text (an item number) is not one.
  { failureClass: 'refused', test: /status code 40[13]\b|HTTP 40[13]\b|unauthori[sz]ed|forbidden/i },
  { failureClass: 'unreadable_response', test: /unexpected token|unexpected end of JSON|JSON\.parse|invalid JSON|could not be parsed|schema validation/i },
];

/** The class of a failure, read from the same text `describeFailure` stores (message plus the causes Node hides). Never throws: unknown if unsure. */
export function classifyFailure(error: unknown): FailureClass {
  let text: string;
  try {
    text = describeFailure(error);
  } catch {
    return 'unknown';
  }
  return CLASS_PATTERNS.find((entry) => entry.test.test(text))?.failureClass ?? 'unknown';
}
