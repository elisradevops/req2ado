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
