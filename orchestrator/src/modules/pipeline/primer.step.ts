import { createHash } from 'node:crypto';
import type { WarningRecord } from '../writeback/dry-run.service';

// The whole-document "primer": a short, model-authored orientation (document type and purpose, the system it specifies, its
// phrasing conventions) that leveling and ingestion's figure captioning receive as context. It is the first long step of a
// SURVEY job and used to run silently and without a time limit: a slow model left the Parse phase on "Parsing document..."
// for minutes. This module is that step, with each part named and timed for the user, a budget for the whole step, and a way
// to stop it. It stays fail-open: a primer that fails or times out only means the job runs without this one optional hint.

// The primer now runs BEFORE /ingest (figures need document context during
// parsing, not just /level) -- there is no parsed `doc` yet to size num_ctx
// against. Per the design's explicit direction: don't reinvent a client-
// side size heuristic (page-count, raw-byte-count) here -- fixed at this
// deployment's real model ceiling (see the deleted PRIMER_NUM_CTX_BUCKETS'
// own comment: 32_768 is qwen2.5:32b-instruct/qwen3.6:35b's real native
// context window). A document whose real text exceeds this is an accepted,
// explicit tradeoff -- it silently loses primer enrichment (Open WebUI's
// own file-context handling may itself truncate or error; either way this
// call's fail-open catch below absorbs it) rather than failing the job.
export const PRIMER_FIXED_NUM_CTX = 32_768;
// How long a computed primer stays cached in Redis by content hash -- long
// enough that a resubmitted/duplicate document within the same day never
// re-pays the real upload+chat cost, short enough that a stale cache entry
// self-heals within a day with zero manual action. Mirrors
// AREA_PATH_BACKFILL_STALE_AFTER_MS's own "throttle, don't disable" shape.
export const PRIMER_CONTEXT_CACHE_TTL_SECONDS = 86_400;
// Hard clamp on the primer string, independent of maxTokens below. The
// prompt asks for "2-3 short sentences", but a model ignoring that
// instruction is a realistic failure mode, not an edge case -- and
// primerContext is threaded into /level as a URL query param
// (ingestion-http.client.ts), so an unbounded reply risks exceeding
// uvicorn/h11's request-line size limit and throwing a 400/431 from the
// /level call itself, OUTSIDE this block's own try/catch. That would fail
// the whole job on exactly the kind of soft LLM misbehavior this primer's
// fail-open design exists to absorb. A few hundred tokens' worth of
// characters is already generous for "document type/purpose/domain
// conventions" -- clamped here as the final backstop regardless of what
// maxTokens below actually bounds output to.
export const PRIMER_CONTEXT_MAX_CHARS = 1000;
/** How long the file may take to be processed by Open WebUI before the step gives up on it. */
const FILE_PROCESSING_TIMEOUT_MS = 60_000;

export type PrimerStepName = 'cached' | 'uploading' | 'processing' | 'reading' | 'done' | 'skipped' | 'timed_out' | 'failed';

export interface PrimerNarration {
  primerStep: PrimerStepName;
  elapsedSeconds: number;
  message: string;
}

export interface PrimerStepClient {
  chatModel: string;
  uploadFile(buffer: Buffer, filename: string, signal?: AbortSignal): Promise<string>;
  pollFileProcessed(fileId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  chatWithFullFileContext(
    content: string,
    fileId: string,
    opts: { maxTokens?: number; numCtx?: number; model?: string; signal?: AbortSignal },
  ): Promise<{ content?: string | null }>;
  deleteFile(fileId: string): Promise<void>;
}

export interface PrimerCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

export interface PrimerStepOptions {
  /** Time allowed for the WHOLE step (upload, processing, reading). 0 = no limit (the behaviour before the budget existed). */
  budgetSeconds: number;
  /** How often a progress line with the elapsed time is published while a part of the step is running. */
  heartbeatSeconds: number;
  /** After a timeout the same document and model skip the step for this long (0 = never remembered). */
  skipMemorySeconds: number;
}

/** Used when the deployment passes no options; the same values as the PRIMER_* settings' defaults (config.schema.ts). */
export const DEFAULT_PRIMER_OPTIONS: PrimerStepOptions = { budgetSeconds: 180, heartbeatSeconds: 10, skipMemorySeconds: 3600 };

export interface PrimerStepInput {
  job: { id: string; filename: string; fileBuffer: Buffer };
  model: string;
  getClient: () => Promise<PrimerStepClient>;
  cache: PrimerCache;
  narrate: (narration: PrimerNarration) => Promise<void> | void;
  options: PrimerStepOptions;
  /** Aborted when the job is cancelled: the step stops and the error reaches the caller. */
  signal?: AbortSignal;
}

export interface PrimerStepResult {
  primerContext?: string;
  warnings: WarningRecord[];
}

const PRIMER_PROMPT =
  'Read the attached document in full. In 2-3 short sentences, describe: the ' +
  'document type and purpose, the system it specifies (if any), and the domain ' +
  "conventions or phrasing style it uses. Do not list sections or definitions.";

/** Rejects as soon as `signal` aborts, so a call that takes no signal of its own (a cache or client lookup) cannot hold the step past its budget. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Clean-up that must never fail or hold up the job: errors are swallowed and the wait is capped. */
async function bestEffort(work: () => unknown, capMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Started inside a promise chain so a work function that throws, or returns something that is not a promise, is covered too.
    await Promise.race([Promise.resolve().then(work).catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, capMs)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The longest the uploaded file's clean-up may hold the job up. */
const CLEANUP_CAP_MS = 10_000;

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function warning(reason: string, raw: string, extra: Record<string, unknown> = {}): WarningRecord {
  return { kind: 'primer_unavailable', severity: 'pipeline_issue', nodeIds: [], detail: { reason, ...extra }, raw };
}

export async function runPrimerStep(input: PrimerStepInput): Promise<PrimerStepResult> {
  const { job, model, cache, options } = input;
  const startedAt = Date.now();
  const elapsed = (): number => Math.floor((Date.now() - startedAt) / 1000);
  const warnings: WarningRecord[] = [];
  const contentHash = createHash('sha256').update(job.fileBuffer).digest('hex');
  const cacheKey = `primer:${model}:${contentHash}`;
  const skipKey = `primer-skip:${model}:${contentHash}`;

  // Narration is for the user's screen: a failure to publish it must never fail or slow the step.
  const say = (primerStep: PrimerStepName, message: string): void => {
    try {
      void Promise.resolve(input.narrate({ primerStep, elapsedSeconds: elapsed(), message })).catch(() => undefined);
    } catch {
      /* a narrate that throws synchronously is no reason to fail the step */
    }
  };

  const timeout = new AbortController();
  const timer = options.budgetSeconds > 0 ? setTimeout(() => timeout.abort(), options.budgetSeconds * 1000) : undefined;
  const signal = input.signal ? AbortSignal.any([timeout.signal, input.signal]) : timeout.signal;
  let heartbeat: NodeJS.Timeout | undefined;
  const stopBeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const beat = (step: PrimerStepName, text: string): void => {
    stopBeat();
    say(step, `${text} - ${clock(elapsed())}`);
    heartbeat = setInterval(() => say(step, `${text} - ${clock(elapsed())}`), Math.max(1, options.heartbeatSeconds) * 1000);
  };

  let client: PrimerStepClient | undefined;
  let fileId: string | undefined;
  let primerContext: string | undefined;
  try {
    client = await raceAbort(input.getClient(), signal);
    const cached = await raceAbort(cache.get(cacheKey), signal);
    if (cached !== null) {
      say('cached', 'Reused a saved overview of this document.');
      return { primerContext: cached, warnings };
    }
    if (options.skipMemorySeconds > 0 && Boolean(await raceAbort(cache.get(skipKey), signal))) {
      say('skipped', 'Skipped the document overview: it timed out recently for this document.');
      warnings.push(
        warning('recent_timeout', 'The whole-document overview was skipped because it timed out recently for this document, so analysis ran without it. Items are otherwise unaffected.'),
      );
      return { warnings };
    }

    beat('uploading', 'Uploading the document to the model');
    fileId = await client.uploadFile(job.fileBuffer, job.filename, signal);
    beat('processing', 'Waiting for the model to process the file');
    const processed = await client.pollFileProcessed(fileId, FILE_PROCESSING_TIMEOUT_MS, signal);
    if (!processed) {
      stopBeat();
      say('failed', 'The model could not process the file; continuing without an overview.');
      warnings.push(warning('not_processed', 'The document could not be processed for the whole-document overview, so analysis ran without it. Items are otherwise unaffected.'));
      return { warnings };
    }

    beat('reading', 'Reading the whole document to understand it');
    const ask = (primerModel: string) =>
      client!.chatWithFullFileContext(PRIMER_PROMPT, fileId!, { maxTokens: 300, model: primerModel, numCtx: PRIMER_FIXED_NUM_CTX, signal });
    let result;
    try {
      result = await ask(model);
    } catch (primerError) {
      // The native file-context route only answers for models Open WebUI itself lists. The primer is only an orientation hint,
      // so a job model it refuses falls back once to the client's configured model.
      if (model === client.chatModel || signal.aborted) throw primerError;
      // eslint-disable-next-line no-console -- worker process logging
      console.warn(`Whole-document primer refused model ${model} for job ${job.id}; retrying with ${client.chatModel}`);
      result = await ask(client.chatModel);
    }
    primerContext = result.content?.trim().slice(0, PRIMER_CONTEXT_MAX_CHARS) || undefined;
    if (primerContext) await cache.set(cacheKey, primerContext, 'EX', PRIMER_CONTEXT_CACHE_TTL_SECONDS);
    stopBeat();
    say('done', 'Document overview ready.');
    return { primerContext, warnings };
  } catch (error) {
    // A cancelled job is not a primer failure: the caller maps it to a cancellation.
    if (input.signal?.aborted) throw error;
    primerContext = undefined;
    if (timeout.signal.aborted) {
      const seconds = elapsed();
      // eslint-disable-next-line no-console -- worker process logging
      console.warn(`Whole-document primer for job ${job.id} exceeded its ${options.budgetSeconds}s budget (${seconds}s); leveling proceeds without it`);
      say('timed_out', `The document overview took longer than ${options.budgetSeconds} seconds; continuing without it.`);
      warnings.push(
        warning(
          'timeout',
          `The whole-document overview took longer than ${options.budgetSeconds} seconds and was skipped, so analysis ran without it. Items are otherwise unaffected.`,
          { budgetSeconds: options.budgetSeconds, elapsedSeconds: seconds },
        ),
      );
      if (options.skipMemorySeconds > 0) {
        // Not awaited: a slow cache must not delay the end of a step that has already run out of time.
        void Promise.resolve()
          .then(() => cache.set(skipKey, '1', 'EX', options.skipMemorySeconds))
          .catch(() => undefined);
      }
    } else {
      // A systematically failing primer (for example LLM_BASE_URL pointing at raw Ollama, which has no file API) must not be invisible.
      // eslint-disable-next-line no-console -- worker process logging
      console.error(`Whole-document primer failed for job ${job.id} (leveling proceeds without it):`, error);
      say('failed', 'The document overview could not be generated; continuing without it.');
      warnings.push(warning('error', 'The whole-document overview could not be generated, so analysis ran without it. Items are otherwise unaffected.'));
    }
    return { warnings };
  } finally {
    stopBeat();
    if (timer) clearTimeout(timer);
    // Best effort, and it must still run after an abort: the file would otherwise stay in Open WebUI.
    if (fileId && client) await bestEffort(() => client!.deleteFile(fileId!), CLEANUP_CAP_MS);
  }
}
