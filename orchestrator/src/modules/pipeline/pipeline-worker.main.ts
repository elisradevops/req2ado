import '../../tracing';
import path from 'path';
import { Worker } from 'bullmq';
import { configSchema } from '../../config/config.schema';

/**
 * BullMQ worker process entrypoint — runs as its own Node process (`node
 * dist/modules/pipeline/pipeline-worker.main.js`), separate from the main
 * NestJS HTTP server, per docs/architecture.md's "TS workers consume jobs"
 * architecture. No automated test for this file (thin bootstrap wiring
 * real dependencies) — matches mcp-ado-server/src/index.ts's precedent.
 *
 * This process itself stays deliberately thin: the actual job processing
 * (ingest -> /level -> dry-run diff, all of runPipelineJob's real
 * dependencies -- Prisma, IngestionHttpClient, JobEventsPublisher's Redis,
 * McpClient) lives entirely in pipeline.processor.ts, run as a BullMQ
 * SANDBOXED processor in a separate child process. This was tried as the
 * fix for repeated "could not renew lock" errors on real long-running
 * SURVEY jobs, on the theory that in-process event-loop contention was
 * starving the lock-renewal timer -- BUT the same error recurred live even
 * with the job fully isolated in its own child process (see
 * lockDuration/stalledInterval's own comment below for the full story).
 * Kept anyway as a real architectural improvement (isolates job-processing
 * crashes/memory from the lock-renewal process, matches BullMQ's own
 * guidance), just not the actual fix for the lock issue -- that turned out
 * to be host-level Docker Desktop VM scheduling contention with a native
 * process (Ollama.app), which no in-app process separation can address.
 * This parent process therefore holds no Prisma/Redis/Mcp client of its
 * own -- only BullMQ's own internal connection (`connection` below), and
 * its shutdown only needs to close the Worker (which itself tears down
 * the child process pool).
 */
const config = configSchema.parse(process.env);

const worker = new Worker(
  'req2ado-pipeline',
  // Sandboxed processor: a FILE PATH (not a function) tells BullMQ to spawn/
  // pool child processes running this file's default export -- see
  // pipeline.processor.ts. The '.js' extension is REQUIRED here: the
  // Worker constructor's own existsSync check appends '.js' when resolving
  // the path for validation, but the child process (child-processor.js)
  // does a raw dynamic import() on whatever string is actually passed
  // through with no extension inference of its own -- omitting it here
  // passed the parent's check but the child's ESM import() then failed
  // with ERR_MODULE_NOT_FOUND ("Did you mean .../pipeline.processor.js?"),
  // observed live on every real job.
  path.join(__dirname, 'pipeline.processor.js'),
  // Previously no concurrency option was set at all -- BullMQ's own
  // implicit default is 1, a real horizontal-scaling throughput blocker
  // even before considering multiple worker replicas.
  //
  // lockDuration/stalledInterval raised from BullMQ's 30s defaults to 60s
  // as a first-pass mitigation, investigated live (throwaway BullMQ-only
  // harness, no Ollama involved) after ~28 "could not renew lock" errors
  // during a real run. Confirmed mechanistically: an async await (e.g. a
  // long ingestionClient.level() HTTP call) does NOT block the event loop
  // and causes ZERO lock-renewal errors no matter how long it takes; only
  // SYNCHRONOUS CPU work blocking the loop past lockDuration does. That
  // 60s bump alone was NOT sufficient -- the error recurred on a later
  // clean run with no synchronous blocking code anywhere in this app and
  // no manual Redis intervention, root-caused to macOS/Docker Desktop VM
  // scheduling contention while Ollama.app does heavy real GPU/CPU
  // inference on the same host (docs.docker.com: the VM has "a fixed pool
  // of CPU/memory... default settings will either starve your containers
  // or starve your Mac"). Moving the actual job work to a sandboxed child
  // process was tried as BullMQ's documented fix for in-process/event-loop
  // blocking -- but the SAME "could not renew lock" error recurred live
  // even with the job fully isolated in its own child process, proving
  // this isn't event-loop contention within one process at all: it's the
  // whole Docker Desktop VM (parent process included) losing host
  // wall-clock scheduling time while Ollama.app does heavy real GPU/CPU
  // inference. No in-app process separation can fix host-level VM
  // starvation. Falling back to BullMQ's own documented alternative for
  // exactly this situation ("pass a larger value for lockDuration, with
  // the tradeoff being it takes longer to recognize a genuinely stalled
  // job") -- raised substantially (10 min) since real SURVEY jobs already
  // run tens of minutes, so slower real-stall detection is an acceptable
  // tradeoff against false-positive stalls during host contention.
  //
  // Raised again to 30 min: the coverage-chunking fix (see
  // ingestion/app/leveling/llm_leveling.py's coverage_budget_tokens)
  // deliberately trades one large holistic call for several smaller
  // sequential per-branch calls to fix under-synthesis -- correct for
  // coverage, but it extends a real job's total wall-clock time
  // proportionally to branch count. Observed live: a real AirPro job (6
  // branches) still hit "could not renew lock"/"Missing lock" at the
  // previous 10-min value under the SAME already-diagnosed host
  // contention (Docker Desktop VM starved by Ollama.app's native
  // inference) -- not a new bug, just the existing tradeoff's margin
  // consumed by the chunking fix's own added latency.
  { connection: { url: config.REDIS_URL } as any, concurrency: config.PIPELINE_WORKER_CONCURRENCY, lockDuration: 1800000, stalledInterval: 1800000 },
);

worker.on('failed', (job, error) => {
  // eslint-disable-next-line no-console -- worker process logging, not app logging
  console.error(`Pipeline job ${job?.id} failed:`, error);
});

// Previously unattached -- BullMQ's own internal errors (including lock-
// renewal failures) were going completely unlogged, so a real incident's
// root cause was invisible until this investigation reproduced it
// artificially. `stalled` fires when BullMQ decides another worker should
// reclaim a job whose lock lapsed -- logging both makes any future
// divergence immediately attributable instead of silent.
worker.on('error', (error) => {
  // eslint-disable-next-line no-console -- worker process logging, not app logging
  console.error('Pipeline worker error:', error);
});
worker.on('stalled', (jobId) => {
  // eslint-disable-next-line no-console -- worker process logging, not app logging
  console.error(`Pipeline job ${jobId} stalled (lock lapsed -- will be reprocessed)`);
});

// eslint-disable-next-line no-console -- startup banner
process.stdout.write('req2ado pipeline worker listening for jobs on queue "req2ado-pipeline"\n');

// Previously no SIGTERM/SIGINT handling at all -- a k8s pod termination
// (rolling update, scale-down, node drain) killed this process immediately,
// mid confirm()/pipeline job, with no chance to finish. worker.close() is
// BullMQ's own graceful shutdown: stops picking up new jobs, tears down the
// sandboxed child process pool, and waits for whatever job is currently
// processing to finish before resolving.
async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console -- worker process logging, not app logging
  console.error(`${signal} received, closing pipeline worker gracefully...`);
  await worker.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
