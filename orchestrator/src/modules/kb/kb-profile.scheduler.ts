import { createHash } from 'node:crypto';
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { IngestionHttpClient } from '../pipeline/ingestion-http.client';

const logger = new Logger('KbProfile');

export const KB_PROFILE_QUEUE = 'req2ado-kb-profile';
/** Several ingests in a row (a folder, a few files one after another) cause one build, after this quiet period. */
const DEBOUNCE_MS = 20_000;

export interface ProfileQueue {
  add(name: string, data: { userId: string }, opts: { jobId: string; delay: number; removeOnComplete: boolean; removeOnFail: boolean }): Promise<unknown>;
  close?(): Promise<unknown>;
}

export interface ProfileModelResolver {
  resolve(userId: string): Promise<{ chatModel?: string } | null | undefined>;
}

export interface KbProfileSchedulerDeps {
  queue: ProfileQueue;
  ingestion: Pick<IngestionHttpClient, 'buildKbProfile'>;
  resolver: ProfileModelResolver;
  /** `KB_PROFILE_MODEL`; empty means the user's own default chat model. */
  profileModel: string;
  /** When set, `onModuleInit` starts the queue's worker on this Redis. */
  redisUrl?: string;
}

/** BullMQ job ids may not contain ':', and user ids do. */
export function profileJobId(userId: string): string {
  return `kb-profile-${createHash('sha1').update(userId).digest('hex').slice(0, 20)}`;
}

/**
 * Builds a user's KB profile in the background after their knowledge base changes, so the first job after an ingest does
 * not pay for it (ingestion would otherwise build it lazily at job start). A managed queue and worker, one debounced job
 * per user; the build itself is ingestion's `POST /kb/profile`, which only rebuilds when a document or the model changed.
 * Nothing here can fail the KB action that triggered it.
 */
export class KbProfileScheduler implements OnModuleInit, OnModuleDestroy {
  private worker?: { close(): Promise<void> };

  constructor(private readonly deps: KbProfileSchedulerDeps) {}

  async onModuleInit(): Promise<void> {
    if (!this.deps.redisUrl) return;
    const { Worker } = await import('bullmq');
    const worker = new Worker(KB_PROFILE_QUEUE, async (job) => this.run(job.data as { userId: string }), {
      connection: { url: this.deps.redisUrl } as never,
      concurrency: 1,
    });
    worker.on('error', (err) => logger.error(`kb profile worker error: ${err.message}`));
    this.worker = worker;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.deps.queue.close?.();
  }

  async schedule(userId: string): Promise<void> {
    try {
      await this.deps.queue.add('build', { userId }, { jobId: profileJobId(userId), delay: DEBOUNCE_MS, removeOnComplete: true, removeOnFail: true });
    } catch (err) {
      logger.warn(`could not schedule a KB profile build: ${(err as Error).message}`);
    }
  }

  async run(data: { userId: string }): Promise<void> {
    try {
      const model = this.deps.profileModel || (await this.deps.resolver.resolve(data.userId))?.chatModel;
      if (!model) return; // no model connection: the first job builds it lazily with its own model
      const built = await this.deps.ingestion.buildKbProfile(data.userId, model);
      if (built) logger.log(`KB profile ready: documents=${built.docsInKb} contributing=${built.docsContributing} model=${built.builtWith}`);
    } catch (err) {
      logger.warn(`KB profile build failed: ${(err as Error).message}`);
    }
  }
}
