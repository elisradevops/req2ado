import { Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

export type JobStage =
  | 'parse'
  | 'infer_hierarchy_start'
  | 'infer_hierarchy_done'
  | 'generate_requirements_start'
  | 'generate_requirements_done'
  | 'diff_ready'
  // Two real pipeline phases that previously published NO stage/narration
  // signal at all: the dedup-check burst (DryRunService.diff(), one
  // idempotency/similarity lookup per proposed node -- confirmed live, a
  // real job ran ~543 of these with the UI showing nothing) and the
  // Confirm/writing phase (JobsService.confirm(), the actual real-ADO
  // write-back -- previously JobsService held no JobEventsPublisher at
  // all, so it was structurally incapable of publishing anything; a
  // 'writing' job rendered no progress UI whatsoever, see JobDetail.tsx's
  // own status branches before this fix).
  | 'dedup_check'
  | 'writing'
  | 'failed'
  | 'cancelled';

// Fine-grained progress WITHIN dedup_check/writing -- same wire shape and
// same Redis channel/key convention as ingestion's own narration events
// (see narration_publisher.py's own doc comment for the shared-channel,
// type-discriminated design), just published from this TS process instead
// of ingestion's Python one. Reuses the generic done/total counter fields
// (`blocksDone`/`blocksTotal`) rather than inventing new field names, to
// match frontend NarrationEvent's existing convention exactly -- no new
// per-phase fields needed for a plain N-of-M counter.
export interface OrchestratorNarration {
  phase: 'dedup_check' | 'writing';
  blocksDone: number;
  blocksTotal: number;
  // 'writing' only -- confirm() is not one flat write burst but several
  // sequential sub-phases (type/field discovery, create, parent-link,
  // trace-link) with no signal today distinguishing which one is running;
  // null for 'dedup_check', which has only one sub-phase.
  writeSubPhase?: 'discover_types' | 'create' | 'link_parents' | 'trace_links' | null;
  // 'dedup_check' only -- the node that just finished its idempotency/dedup
  // lookup, so the UI can show which actual item is involved instead of
  // just a bare N-of-M count.
  currentTitle?: string;
  message: string;
}

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

// Real gap this closes (user-reported): a reconnecting SSE client (page
// reload, dropped connection) previously only ever replayed the SINGLE
// latest narration event (a SET-overwritten key) -- see
// JobEventsController.streamEvents, which now reads this bounded LIST via
// LRANGE instead. Capped to match JobDetail.tsx's own client-side history
// cap (`.slice(-50)`) -- replaying more than the frontend keeps anyway
// would be wasted bandwidth on reconnect.
const NARRATION_LOG_MAX_ENTRIES = 50;

@Injectable()
export class JobEventsPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(jobId: string, stage: JobStage): Promise<void> {
    // Real gap this closes: JobEventPersistenceService's own
    // backfillMissedEvents() has no way to know when an event ACTUALLY
    // happened versus when it got persisted -- a backfill sweep run long
    // after the fact was inserting rows stamped with the insertion time,
    // making a long-dead job look recently active to the stale-job
    // watchdog. This is the one place a stage transition's real origin time
    // can be captured, at the moment it's actually emitted.
    const payload = JSON.stringify({ stage, emittedAt: new Date().toISOString() });
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

  // Same channel/replay-key convention as ingestion's own narration events
  // (`job-events:{jobId}:narration-log` + the shared `job-events:{jobId}`
  // pub/sub channel, see job-events.controller.ts's own comment on how it
  // tells the two apart) -- `type: 'narration'` is what JobEventsController
  // uses to distinguish this from a plain stage transition on the same
  // channel.
  async publishNarration(jobId: string, narration: OrchestratorNarration): Promise<void> {
    // Frontend's NarrationEvent type declares branchIndex/branchCount/
    // kbGrounded/kbCitations as REQUIRED (not optional) -- every ingestion-
    // side phase always sends them, using null/0/false/[] when meaningless
    // for that phase (see LevelingProgress's own doc comment, Python side,
    // for the exact same convention). Filled in here, once, rather than at
    // every call site, so OrchestratorNarration callers only ever need to
    // supply what's actually meaningful for dedup_check/writing.
    const payload = JSON.stringify({
      type: 'narration',
      branchIndex: null,
      branchCount: 0,
      kbGrounded: false,
      kbCitations: [],
      emittedAt: new Date().toISOString(),
      ...narration,
    });
    // A bounded LIST (not the old single-key SET-overwrite) so a
    // reconnecting client can replay the last N events, not just the very
    // latest one -- see JobEventsController.streamEvents, which reads this
    // same key via LRANGE. Same key/list convention ingestion's own
    // NarrationPublisher (Python side) uses for its own narration events.
    const logKey = `job-events:${jobId}:narration-log`;
    await this.redis.rpush(logKey, payload);
    await this.redis.ltrim(logKey, -NARRATION_LOG_MAX_ENTRIES, -1);
    await this.redis.expire(logKey, CURRENT_STAGE_TTL_SECONDS);
    await this.redis.publish(`job-events:${jobId}`, payload);
  }
}
