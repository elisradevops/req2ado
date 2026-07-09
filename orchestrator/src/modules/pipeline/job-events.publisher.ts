import { Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

export type JobStage =
  | 'parse'
  | 'infer_hierarchy_start'
  | 'infer_hierarchy_done'
  | 'generate_requirements_start'
  | 'generate_requirements_done'
  | 'diff_ready'
  | 'failed';

// Publishes coarse pipeline-progress events over Redis pub/sub so the
// orchestrator HTTP process's JobEventsController can relay them to SSE
// clients. Worker (pipeline.worker.ts, its own process/container) and HTTP
// server (jobs.module.ts) share one Redis instance (REDIS_URL) but are
// separate processes — pub/sub is the only cross-process signaling channel
// available, same as BullMQ's own use of Redis for job queuing.
//
// In practice the worker only ever publishes 'parse', 'infer_hierarchy_start',
// 'generate_requirements_done', 'diff_ready', and 'failed' — ingestion's
// /level call runs infer_hierarchy + generate_requirements in one HTTP
// round trip with no intermediate signal back to the orchestrator, so the
// finer-grained stages in this union are unreachable until a Phase 2+
// ingestion API change (chunking/webhooks) exposes that sub-boundary.
@Injectable()
export class JobEventsPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(jobId: string, stage: JobStage): Promise<void> {
    await this.redis.publish(`job-events:${jobId}`, JSON.stringify({ stage }));
  }
}
