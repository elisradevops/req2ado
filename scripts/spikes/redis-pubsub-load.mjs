#!/usr/bin/env node
// Job transparency spike E (docs/job-transparency-implementation-plan.md, section 4):
// does Redis pub/sub keep up with the planned live-frame load?
//
// Simulates JOBS concurrent jobs, each publishing frames at HZ per second of
// BYTES bytes to its own channel, with SUBS subscribers per job (viewers).
// Reports delivery latency percentiles and lost messages. Uses throwaway
// channel names ("spike-job:*"); touches no real job keys.
//
// Usage (from req2ado/):
//   REDIS_URL=redis://localhost:6379 [JOBS=50] [HZ=4] [BYTES=2000] [SUBS=3] [SECONDS=30] \
//   node scripts/spikes/redis-pubsub-load.mjs
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../orchestrator/', import.meta.url));
const Redis = require('ioredis');
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const jobs = Number(process.env.JOBS ?? 50);
const hz = Number(process.env.HZ ?? 4);
const bytes = Number(process.env.BYTES ?? 2000);
const subsPerJob = Number(process.env.SUBS ?? 3);
const seconds = Number(process.env.SECONDS ?? 30);

const publisher = new Redis(redisUrl);
const latencies = [];
let received = 0;
const subscribers = [];
for (let j = 0; j < jobs; j++) {
  for (let s = 0; s < subsPerJob; s++) {
    const sub = new Redis(redisUrl);
    await sub.subscribe(`spike-job:${j}`);
    sub.on('message', (_c, message) => {
      received++;
      latencies.push(Date.now() - Number(message.slice(0, 13)));
    });
    subscribers.push(sub);
  }
}
const padding = 'x'.repeat(Math.max(0, bytes - 13));
let sent = 0;
const timers = [];
for (let j = 0; j < jobs; j++) {
  timers.push(setInterval(() => { sent++; void publisher.publish(`spike-job:${j}`, `${Date.now()}${padding}`); }, 1000 / hz));
}
await new Promise((r) => setTimeout(r, seconds * 1000));
timers.forEach(clearInterval);
await new Promise((r) => setTimeout(r, 1000));
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? NaN;
const expected = sent * subsPerJob;
console.log(`jobs ${jobs}, ${hz} Hz each, ${bytes} B frames, ${subsPerJob} viewers per job, ${seconds}s`);
console.log(`published ${sent}, expected deliveries ${expected}, received ${received}, lost ${expected - received}`);
console.log(`latency ms: p50 ${pct(0.5)}, p95 ${pct(0.95)}, p99 ${pct(0.99)}, max ${latencies[latencies.length - 1]}`);
console.log(`Spike E: ${expected - received === 0 && pct(0.99) < 100 ? 'PASS' : 'REVIEW'}  (no loss and p99 under 100 ms)`);
await Promise.all([publisher.quit(), ...subscribers.map((s) => s.quit())]);
