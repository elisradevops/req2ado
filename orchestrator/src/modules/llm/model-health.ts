import type { LlmChatOptions, LlmChatResult } from './llm-client.interface';

// A model can appear in the proxy's catalog and still be unusable for req2ado: persona/agent presets inject their own
// prompt and ignore ours, some entries fail the request contract, retired aliases answer 404. Rather than keep a list
// of such names, each model is probed with two tiny synthetic calls and listed only while it passes.

/** A passing verdict is trusted for this long before it is checked again (it stays listed meanwhile). */
export const OK_TTL_MS = 24 * 60 * 60 * 1000;
/** A failing verdict is re-checked sooner so a transient outage heals (the model stays hidden meanwhile). */
export const FAILED_TTL_MS = 60 * 60 * 1000;
/** An inconclusive result is retried after this long. */
export const UNKNOWN_TTL_MS = 10 * 60 * 1000;
/** Each probe call must answer within this long. */
export const PROBE_TIMEOUT_MS = 45_000;
/** Pause before the one repeat of a failed probe. */
export const PROBE_RETRY_DELAY_MS = 2_000;

export interface ModelVerdict {
  /** 'unknown': probes so far were inconclusive (rate limit, overload, timeout); listed, probed again soon. */
  status: 'ok' | 'failed' | 'unknown';
  /** epoch ms */
  checkedAt: number;
  /** A short code, never model output or request content. */
  reason?: string;
}

/** What a probe round concluded: a verdict, or 'inconclusive' when every failure was transient. */
export type ProbeOutcome = (ModelVerdict & { status: 'ok' | 'failed' }) | { status: 'inconclusive'; checkedAt: number; reason: string };

/** A model with no verdict yet is listed (a fresh deployment is never empty); only a failed one is hidden. */
export function isListed(verdict: ModelVerdict | undefined): boolean {
  return verdict?.status !== 'failed';
}

/** True when the verdict is missing or past its time-to-live. */
export function needsProbe(verdict: ModelVerdict | undefined, now: number): boolean {
  if (!verdict) return true;
  const ttl = verdict.status === 'ok' ? OK_TTL_MS : verdict.status === 'failed' ? FAILED_TTL_MS : UNKNOWN_TTL_MS;
  return now - verdict.checkedAt >= ttl;
}

export function parseVerdict(raw: string | null | undefined): ModelVerdict | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ModelVerdict>;
    if ((parsed.status === 'ok' || parsed.status === 'failed' || parsed.status === 'unknown') && typeof parsed.checkedAt === 'number') {
      return { status: parsed.status, checkedAt: parsed.checkedAt, ...(parsed.reason ? { reason: String(parsed.reason) } : {}) };
    }
  } catch {
    /* a corrupt entry is treated as no verdict */
  }
  return undefined;
}

/** The slice of the LLM client a probe needs. */
export interface ProbeClient {
  chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], opts?: LlmChatOptions): Promise<LlmChatResult>;
}

const PLAIN_TOKEN = 'QX7';
const STRUCTURED_IDS = ['a1', 'b2', 'c3'];
export const ROWS_SCHEMA = {
  name: 'health_rows',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, label: { type: 'string' } },
          required: ['id', 'label'],
          additionalProperties: false,
        },
      },
    },
    required: ['rows'],
    additionalProperties: false,
  },
};

class ProbeFailure extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeFailure('timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A short code for a thrown error: the HTTP status when it has one, else its kind. */
function reasonOf(err: unknown): string {
  if (err instanceof ProbeFailure) return err.reason;
  const status = (err as { status?: number; upstreamStatus?: number } | undefined)?.status ?? (err as { upstreamStatus?: number } | undefined)?.upstreamStatus;
  return status ? `status_${status}` : 'error';
}

/**
 * A reason that says nothing about the model itself: the upstream was rate limiting, overloaded or unreachable, or the
 * call timed out. Such a probe must not hide a model that works (a rate-limited probe round hid healthy models for an
 * hour); the model keeps its earlier verdict and is probed again later.
 */
export function isTransientReason(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason === 'timeout' || reason === 'error') return true;
  const status = /^status_(\d+)$/.exec(reason);
  if (!status) return false;
  const code = Number(status[1]);
  return code === 408 || code === 425 || code === 429 || code >= 500;
}

function parseRows(content: string): { id?: unknown }[] | null {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text) as { rows?: unknown };
    return Array.isArray(parsed?.rows) ? (parsed.rows as { id?: unknown }[]) : null;
  } catch {
    return null;
  }
}

async function probeOnce(client: ProbeClient, model: string, timeoutMs: number): Promise<void> {
  // 1. A plain call that carries our own instruction: a persona/agent preset that injects its own prompt ignores it.
  const plain = await withTimeout(
    client.chat(
      [
        { role: 'system', content: `Reply with exactly the token ${PLAIN_TOKEN} and nothing else.` },
        { role: 'user', content: 'Go.' },
      ],
      { model, temperature: 0, maxTokens: 200 },
    ),
    timeoutMs,
  );
  if (!plain.content.includes(PLAIN_TOKEN)) throw new ProbeFailure('ignored_instruction');

  // 2. Structured output on three synthetic rows (a schema the model cannot take degrades to a prompt-only answer,
  //    which still has to parse).
  const structured = await withTimeout(
    client.chat(
      [
        {
          role: 'system',
          content: 'Return JSON of the form {"rows":[{"id":"<id>","label":"<id in upper case>"}]} with one row per id given.',
        },
        { role: 'user', content: STRUCTURED_IDS.join(', ') },
      ],
      { model, temperature: 0, maxTokens: 400, responseSchema: ROWS_SCHEMA },
    ),
    timeoutMs,
  );
  const rows = parseRows(structured.content);
  const ids = (rows ?? []).map((row) => row.id);
  if (!rows || STRUCTURED_IDS.some((id) => !ids.includes(id))) throw new ProbeFailure('structured_output_failed');
}

export interface ProbeOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Probes one model. A failure is repeated once after a short pause, so a single transient upstream error does not
 * hide a model for an hour. Never throws: the result is the verdict.
 */
export async function probeModel(client: ProbeClient, model: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  let reason = 'error';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await probeOnce(client, model, timeoutMs);
      return { status: 'ok', checkedAt: now() };
    } catch (err) {
      reason = reasonOf(err);
      if (attempt === 1) await sleep(PROBE_RETRY_DELAY_MS);
    }
  }
  return isTransientReason(reason)
    ? { status: 'inconclusive', checkedAt: now(), reason }
    : { status: 'failed', checkedAt: now(), reason };
}
