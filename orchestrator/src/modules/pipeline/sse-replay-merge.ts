// Supports JobEventsController.streamEvents's subscribe-first-then-replay
// ordering. Before that reorder, the controller read its replay snapshot
// (GET :current + LRANGE :narration-log) BEFORE calling subscribe(), because
// a .subscribe()'d ioredis connection can no longer issue any other command
// -- which meant any event published in between was delivered to nobody, and
// a terminal stage landing in that window left the client stalled on
// "running" until the page was reloaded. Subscribing first closes the gap but
// opens a mirror-image one: an event published while the replay reads are in
// flight arrives BOTH in the snapshot (the producer wrote it to the replay
// store) and live on the channel. These two helpers are what makes it
// exactly once.

// Depth of the live-message buffer held while the replay reads are in
// flight. Realistically 0 -- that window is one GET plus one LRANGE against
// Redis on the same network, and these are narration events (each one gated
// behind a real LLM/DB/vector round trip), not raw data. Bounded anyway
// because the pathological case is a slow or hung Redis, which is exactly
// what widens the window, and this array is per open SSE connection.
//
// 50 is not a new number: it is NARRATION_LOG_MAX_ENTRIES
// (job-events.publisher.ts), _NARRATION_LOG_MAX_ENTRIES
// (narration_publisher.py, ingestion side) and JobDetail.tsx's own
// `.slice(-50)` client-side history cap. Buffering deeper than the frontend
// retains would be wasted.
export const MAX_REPLAY_BUFFER_ENTRIES = 50;

// Drop-oldest. Safe for the terminal-stage stall this whole reorder exists
// to fix: a terminal stage could only be evicted by 50 further publishes
// AFTER it, and nothing is ever published after a terminal stage -- so no
// terminal-message special case is needed here. What overflow can lose is
// old narration lines, which remain durably readable via
// GET /jobs/:id/event-history (JobEventPersistenceService persists every
// event independently of this stream).
export function pushBoundedReplayBuffer(buffer: string[], raw: string): void {
  buffer.push(raw);
  if (buffer.length > MAX_REPLAY_BUFFER_ENTRIES) buffer.shift();
}

// Returns the buffered messages that still need delivering after the replay
// snapshot has already been written to the stream.
//
// The dedup key is the RAW PUBLISHED STRING, byte for byte. That works
// because every producer on this channel serializes an event exactly once
// and then uses that same string for both the replay store and the publish
// -- JobEventsPublisher.publish (`const payload = JSON.stringify(...)`, then
// SET :current + PUBLISH), JobEventsPublisher.publishNarration (RPUSH
// narration-log + PUBLISH), and NarrationPublisher.publish on the Python
// side (one json.dumps, then rpush + publish). So the only duplicate this
// reorder can create is byte-identical by construction, and no field-subset
// key has to be guessed at.
//
// False positives are ruled out by `emittedAt`, which all three producers
// stamp at publish time (millisecond resolution in TS, microsecond in
// Python) and which therefore acts as a de-facto nonce: two genuinely
// different events would have to share a timestamp tick AND every other
// field to collide.
//
// Deliberately NOT the `${phase}|${message}` key
// JobEventPersistenceService.existingKeysFor uses -- that one is
// intentionally lossy (its own comment: a repeated identical figure caption
// must only insert once), which is right for Postgres row uniqueness and
// wrong for an activity-log stream where two identically-worded events are
// two real events.
//
// Count-aware rather than set-membership: replay `[X]` against buffer
// `[X, X]` must leave one X standing, because only one of the two is the
// replay's duplicate and the other is a genuine second publish.
//
// Scoped to one replay window: the caller builds `replayed` from the
// snapshot it just wrote and discards it after the flush. Nothing arriving
// later in the job is ever compared against it -- a long-lived seen-set
// would turn a legitimately repeated narration line into a silently
// missing one.
export function mergeReplayBuffer(replayed: readonly string[], buffered: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const raw of replayed) remaining.set(raw, (remaining.get(raw) ?? 0) + 1);
  const out: string[] = [];
  for (const raw of buffered) {
    const count = remaining.get(raw);
    if (count) {
      remaining.set(raw, count - 1);
      continue;
    }
    out.push(raw);
  }
  return out;
}
