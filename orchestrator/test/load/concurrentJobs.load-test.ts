// orchestrator/test/load/concurrentJobs.load-test.ts
/**
 * Manual load test — NOT run by `npx jest` (see run-load-test.sh for why:
 * this file is excluded from Jest's default testMatch pattern via its
 * directory, matching the project's existing convention for
 * openwebui.client.live.smoke.ts).
 *
 * Exercises Phase 7.5's runPipelineJob directly at concurrency N, with a
 * fake ingestion client (no real Python service / Postgres / Redis
 * needed) — proves the pipeline logic itself has no shared-mutable-state
 * race condition under concurrent execution, independent of infrastructure
 * throughput (which is a deployment/ops concern, not a code-correctness one).
 *
 * Run with: npx ts-node test/load/concurrentJobs.load-test.ts [N]
 */
import { runPipelineJob } from '../../src/modules/pipeline/pipeline.worker';
import { DryRunService } from '../../src/modules/writeback/dry-run.service';
import { IdempotencyService } from '../../src/modules/writeback/idempotency.service';

async function main(): Promise<void> {
  const concurrency = Number(process.argv[2] ?? 50);

  const idempotencyStore = new Map<string, number>();
  let nextAdoId = 1;
  const fakePrisma = {
    job: { update: async () => undefined },
    idempotencyMapping: {
      findFirst: async ({ where }: any) => {
        const key = JSON.stringify({ sourceHash: where.sourceHash, customerId: where.customerId, areaPath: where.areaPath });
        return idempotencyStore.has(key) ? { adoWorkItemId: idempotencyStore.get(key) } : null;
      },
      create: async ({ data }: any) => {
        const key = JSON.stringify({ sourceHash: data.sourceHash, customerId: data.customerId, areaPath: data.areaPath });
        idempotencyStore.set(key, data.adoWorkItemId);
      },
    },
  };
  const idempotencyService = new IdempotencyService(fakePrisma as any);
  const dryRunService = new DryRunService();

  const fakeIngestionClient = {
    ingest: async () => ({ blocks: [{ id: 'b0' }] }),
    level: async (_doc: unknown, _customerId: string | null) => ({
      nodes: [{ local_id: 'n0', fidelity_hash: `hash-${nextAdoId++}`, customer_id: 'CUST-LOAD' }],
    }),
  };

  const startTime = Date.now();
  const jobs = Array.from({ length: concurrency }, (_, i) =>
    runPipelineJob(
      { id: `load-job-${i}`, areaPath: 'Project\\LoadTest', customerId: 'CUST-LOAD', fileBuffer: Buffer.from(`doc-${i}`), filename: `doc-${i}.txt` },
      { ingestionClient: fakeIngestionClient as any, dryRunService, idempotencyService, prisma: fakePrisma as any },
    ),
  );

  const results = await Promise.allSettled(jobs);
  const durationMs = Date.now() - startTime;
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(`Load test: ${concurrency} concurrent jobs, ${succeeded} succeeded, ${failed} failed, ${durationMs}ms total`);
  if (failed > 0) {
    console.error('FAILED jobs:', results.filter((r) => r.status === 'rejected'));
    process.exitCode = 1;
  }
}

main();
