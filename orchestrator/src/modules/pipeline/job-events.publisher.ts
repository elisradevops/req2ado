import { Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

export type JobStage =
  | 'parse'
  | 'infer_hierarchy_start'
  | 'infer_hierarchy_done'
  | 'generate_requirements_start'
  | 'generate_requirements_done'
  | 'diff_ready'
  | 'failed'
  | 'cancelled';

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
// How long a job's last-known stage stays readable after being set --
// generous relative to any real job's lifetime, just bounding unbounded
// key growth in Redis rather than modeling an actual expectation.
const CURRENT_STAGE_TTL_SECONDS = 3600;

@Injectable()
export class JobEventsPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(jobId: string, stage: JobStage): Promise<void> {
    const payload = JSON.stringify({ stage });
    // Pub/sub only reaches subscribers connected AT THE MOMENT of publish --
    // a client that opens the SSE stream after this event (e.g. the user
    // left the job page mid-run and came back) would otherwise see nothing
    // until the NEXT stage fires, which can be minutes away during a real
    // LLM call. Persisting the last-known stage lets a fresh subscriber
    // (see JobEventsController.streamEvents) replay it immediately instead
    // of waiting on the future.
    await this.redis.set(`job-events:${jobId}:current`, payload, 'EX', CURRENT_STAGE_TTL_SECONDS);
    await this.redis.publish(`job-events:${jobId}`, payload);
  }
}
