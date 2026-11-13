// A failed run's cause in plain words (DESIGN.md §11.3.6b). The server records only a line of text ("Pipeline failed: <error>") in the audit
// trail until a structured failure is stored (plan S3), so the cause is read from that text. Only causes the text clearly shows are named;
// anything else says the run stopped with an error and shows the raw text: a guess would send the reader the wrong way.
const FAILED_PREFIX = 'Pipeline failed: ';

export function failureAuditMessage(entries: ReadonlyArray<{ message: string }>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index].message;
    if (message.startsWith(FAILED_PREFIX)) return message.slice(FAILED_PREFIX.length);
  }
  return null;
}

// The summaries say "a step" or "a request", never "the model": the call that failed may be the model, Azure DevOps or SharePoint, and the
// text rarely says which. A bare number (an item 403, a count 401) is not a status code, so a refusal needs the words around it.
const CAUSES: Array<{ test: RegExp; summary: string }> = [
  { test: /UND_ERR_SOCKET|ECONNRESET|other side closed|socket hang up/i, summary: 'The connection was cut during the run.' },
  { test: /timeout|timed out|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i, summary: 'A step took too long to answer.' },
  { test: /status code 40[13]\b|HTTP 40[13]\b|unauthori[sz]ed|forbidden/i, summary: 'A request was refused: a sign-in or permission problem.' },
  { test: /unexpected token|unexpected end of JSON|JSON\.parse|invalid JSON|could not be parsed|schema validation/i, summary: 'A response could not be read.' },
];

export function describeFailureCause(raw: string): { summary: string; detail: string } {
  const detail = raw.trim();
  const match = CAUSES.find((cause) => cause.test.test(detail));
  return { summary: match?.summary ?? 'The run stopped with an error.', detail };
}

// The server stores the class of a failure (orchestrator failure-reason.ts); a stored class is trusted over a guess from text.
const STORED_SUMMARIES: Record<string, string> = {
  connection_reset: 'The connection was cut during the run.',
  timeout: 'A step took too long to answer.',
  refused: 'A request was refused: a sign-in or permission problem.',
  unreadable_response: 'A response could not be read.',
  unknown: 'The run stopped with an error.',
};

export function describeStoredFailure(job: {
  failureClass?: string | null;
  failureMessage?: string | null;
  failedStage?: string | null;
}): { summary: string; detail: string } | null {
  if (!job.failureClass && !job.failureMessage) return null;
  const summary = (job.failureClass && STORED_SUMMARIES[job.failureClass]) || 'The run stopped with an error.';
  return { summary, detail: (job.failureMessage ?? '').trim() };
}
