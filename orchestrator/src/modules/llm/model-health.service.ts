import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { isListed, needsProbe, parseVerdict, probeModel, type ModelVerdict, type ProbeClient } from './model-health';

const logger = new Logger('ModelHealth');

export const MODEL_HEALTH_QUEUE = 'req2ado-model-health';
const VERDICT_KEY_PREFIX = 'model-health:';
/** Verdicts are kept far longer than their time-to-live, so a stale one keeps its answer while it is re-checked. */
const STORE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const WORKER_CONCURRENCY = 3;

/** The slice of a Redis client the verdict store needs (ioredis satisfies it). */
export interface VerdictStore {
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  quit?(): Promise<unknown>;
}

/** The slice of a BullMQ queue used to schedule probes. */
export interface ProbeQueue {
  add(name: string, data: ProbeJobData, opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface ProbeJobData {
  userId: string;
  model: string;
}

/** Resolves the probing client for a user (the user's own token is read at run time, never put in a job). */
export interface ProbeClientSource {
  getClientFor(userId: string): Promise<ProbeClient>;
}

export interface ModelHealthDeps {
  enabled: boolean;
  store: VerdictStore;
  queue: ProbeQueue;
  clients: ProbeClientSource;
  /** When set, `onModuleInit` starts the queue's worker on this Redis. Tests leave it out and call `runProbe`. */
  redisUrl?: string;
  now?: () => number;
}

/**
 * Automatic model health: which models of the catalog actually work for req2ado, found by probing them in the
 * background (a managed BullMQ queue and worker) and remembered in Redis. Verdicts are deployment-wide, since a
 * model's fitness (persona preset, retired alias) is a property of the deployment, not of one user. Listing is
 * never blocked or broken by it: a model without a verdict is listed, and any error here leaves the list as it was.
 */
@Injectable()
export class ModelHealthService implements OnModuleInit, OnModuleDestroy {
  private worker?: { close(): Promise<void> };

  constructor(private readonly deps: ModelHealthDeps) {}

  async onModuleInit(): Promise<void> {
    if (!this.deps.enabled || !this.deps.redisUrl) return;
    const { Worker } = await import('bullmq');
    const worker = new Worker(MODEL_HEALTH_QUEUE, async (job) => this.runProbe(job.data as ProbeJobData), {
      connection: { url: this.deps.redisUrl } as never,
      concurrency: WORKER_CONCURRENCY,
    });
    worker.on('error', (err) => logger.error(`model health worker error: ${err.message}`));
    this.worker = worker;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.deps.queue.close?.();
    await this.deps.store.quit?.();
  }

  private key(model: string): string {
    return `${VERDICT_KEY_PREFIX}${model}`;
  }

  private async verdicts(models: string[]): Promise<Map<string, ModelVerdict | undefined>> {
    const raws = models.length > 0 ? await this.deps.store.mget(...models.map((m) => this.key(m))) : [];
    return new Map(models.map((model, i) => [model, parseVerdict(raws[i])]));
  }

  /**
   * The catalog without the models known to fail. Models that have no verdict, or a stale one, are queued for a
   * probe. Any error leaves the catalog untouched.
   */
  async filterVisible<T extends { id: string }>(userId: string, catalog: T[]): Promise<T[]> {
    if (!this.deps.enabled) return catalog;
    try {
      const verdicts = await this.verdicts(catalog.map((m) => m.id));
      const now = (this.deps.now ?? Date.now)();
      await Promise.all(
        catalog
          .filter((m) => needsProbe(verdicts.get(m.id), now))
          .map((m) =>
            this.deps.queue
              .add('probe', { userId, model: m.id }, { jobId: probeJobId(m.id), removeOnComplete: true, removeOnFail: true })
              .catch((err: Error) => logger.warn(`could not queue a health probe for ${m.id}: ${err.message}`)),
          ),
      );
      return catalog.filter((m) => isListed(verdicts.get(m.id)));
    } catch (err) {
      logger.warn(`model health unavailable, listing every model: ${(err as Error).message}`);
      return catalog;
    }
  }

  /** True when the model is known to fail (job creation refuses it). Unknown and error cases are not failures. */
  async isFailed(model: string): Promise<boolean> {
    if (!this.deps.enabled) return false;
    try {
      return !isListed((await this.verdicts([model])).get(model));
    } catch {
      return false;
    }
  }

  /** Probes one model and stores the verdict. Called by the queue's worker. */
  async runProbe(data: ProbeJobData): Promise<ModelVerdict | undefined> {
    let client: ProbeClient;
    try {
      client = await this.deps.clients.getClientFor(data.userId);
    } catch (err) {
      logger.warn(`health probe for ${data.model} skipped: ${(err as Error).message}`);
      return undefined;
    }
    const previous = (await this.verdicts([data.model])).get(data.model);
    const outcome = await probeModel(client, data.model, { now: this.deps.now });
    if (outcome.status === 'inconclusive') {
      // Rate limit, overload or timeout says nothing about the model: keep what is known. A model that had no verdict
      // stays listed; one that had a verdict keeps it, with a fresh time so it is probed again after its normal wait.
      logger.warn(`model health: model=${data.model} probe inconclusive reason=${outcome.reason}; verdict unchanged`);
      const kept: ModelVerdict = previous
        ? { ...previous, checkedAt: outcome.checkedAt }
        : { status: 'unknown', checkedAt: outcome.checkedAt, reason: outcome.reason };
      await this.deps.store.set(this.key(data.model), JSON.stringify(kept), 'EX', STORE_RETENTION_SECONDS);
      return kept;
    }
    const verdict = outcome;
    await this.deps.store.set(this.key(data.model), JSON.stringify(verdict), 'EX', STORE_RETENTION_SECONDS);
    if (previous?.status !== verdict.status) {
      logger.log(`model health: model=${data.model} ${previous?.status ?? 'unknown'} -> ${verdict.status}${verdict.reason ? ` reason=${verdict.reason}` : ''}`);
    }
    return verdict;
  }
}

/** BullMQ custom ids may not contain ':' and model names carry '/' and ':'. */
export function probeJobId(model: string): string {
  return `probe-${createHash('sha1').update(model).digest('hex').slice(0, 20)}`;
}
