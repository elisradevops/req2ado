#!/usr/bin/env node
// Load and soak test for the live run view's server path (job transparency, Phase 3, S1).
//
// N jobs x M viewers go through the REAL orchestrator SSE endpoint and the REAL Redis. Jobs are created
// pending (stop the pipeline worker first so nothing runs), and a publisher stands in for ingestion,
// writing live and progress frames at a chosen rate straight to each job's Redis channels.
//
//   docker stop req2ado-pipeline-worker-1
//   node scripts/load/live-sse-load.mjs --doc path/to/small.docx --jobs 20 --viewers 3 --seconds 600 --live-hz 4
//   (add --api2 http://localhost:3012 --container2 req2ado-orchestrator2-1 to spread viewers over a second orchestrator replica)
//
// Prints delivery (published vs received), end-to-end latency, /health latency (a stand-in for event-loop
// lag), orchestrator CPU and memory, Redis memory/keys/clients, and what is left after the viewers leave.
// Cleans up the jobs and their keys. Needs the compose stack on the default ports and a fake identity
// endpoint, which this script starts on :4102.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Redis = require(path.resolve('orchestrator/node_modules/ioredis'));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const JOBS = Number(args.jobs ?? 20);
const VIEWERS = Number(args.viewers ?? 3);
const SECONDS = Number(args.seconds ?? 600);
const LIVE_HZ = Number(args['live-hz'] ?? 4);
const PROGRESS_HZ = Number(args['progress-hz'] ?? 1);
const DOC = args.doc;
const API = args.api ?? 'http://localhost:3001';
const ORCH_CONTAINER = args.container ?? 'req2ado-orchestrator-1';
const API2 = args.api2; // optional second orchestrator replica
const ORCH_CONTAINER2 = args.container2 ?? 'req2ado-orchestrator2-1';
if (!DOC) throw new Error('--doc <a small docx> is required');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);
const dockerStats = (container = ORCH_CONTAINER) => {
  try {
    const [cpu, mem] = execSync(`docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' ${container}`, { encoding: 'utf8' }).trim().split('|');
    const used = mem.split('/')[0].trim();
    return { cpu: parseFloat(cpu), memMiB: parseFloat(used) * (used.includes('GiB') ? 1024 : used.includes('KiB') ? 1 / 1024 : 1) };
  } catch { return { cpu: NaN, memMiB: NaN }; }
};

// --- identity stub and login --------------------------------------------------------------------------
const identity = http.createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ authenticatedUser: { descriptor: 'verify-user', providerDisplayName: 'Load Test' } }));
}).listen(4102, '0.0.0.0');

let cookie = '';
async function api(method, url, body, headers = {}) {
  const res = await fetch(`${API}${url}`, { method, body, headers: { ...headers, cookie } });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return res;
}
const login = await api('POST', '/auth/login', JSON.stringify({ adoOrgUrl: 'http://host.docker.internal:4102', pat: 'load-test-pat' }), { 'content-type': 'application/json' });
if (!login.ok) throw new Error(`login failed: ${login.status}`);

// --- jobs ------------------------------------------------------------------------------------------
const jobIds = [];
const docBytes = readFileSync(DOC);
for (let i = 0; i < JOBS; i++) {
  const form = new FormData();
  form.append('file', new Blob([docBytes]), 'load.docx');
  form.append('areaPath', 'Project\\Load');
  form.append('adoProject', 'Project');
  form.append('mode', 'survey');
  const res = await api('POST', '/jobs', form);
  if (!res.ok) throw new Error(`job ${i} failed: ${res.status} ${await res.text()}`);
  jobIds.push((await res.json()).jobId);
}
console.log(`created ${jobIds.length} pending jobs`);

const redis = new Redis();
const memory = async () => {
  const info = await redis.info('memory');
  const clients = await redis.info('clients');
  return {
    usedMiB: Number(/used_memory:(\d+)/.exec(info)?.[1] ?? 0) / 1048576,
    clients: Number(/connected_clients:(\d+)/.exec(clients)?.[1] ?? 0),
    keys: await redis.dbsize(),
  };
};
const before = await memory();

// --- viewers ------------------------------------------------------------------------------------------
const received = { live: 0, progress: 0, heartbeat: 0, stage: 0 };
const latencies = [];
const controllers = [];
let streamErrors = 0;
async function view(jobId, base = API) {
  const controller = new AbortController();
  controllers.push(controller);
  try {
    const res = await fetch(`${base}/jobs/${jobId}/events`, { headers: { cookie, accept: 'text/event-stream' }, signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:') && event in received) {
          received[event]++;
          if (event === 'live') {
            const sent = JSON.parse(line.slice(5)).emittedAt;
            if (sent) latencies.push(Date.now() - Date.parse(sent));
          }
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) streamErrors++;
  }
}
const viewerTasks = [];
let viewerNo = 0;
for (const id of jobIds) for (let v = 0; v < VIEWERS; v++) viewerTasks.push(view(id, API2 && viewerNo++ % 2 === 1 ? API2 : API));
await sleep(2000);
const connected = await memory();
console.log(`viewers connected: ${JOBS * VIEWERS}; Redis clients ${before.clients} -> ${connected.clients}`);

// --- probes ---------------------------------------------------------------------------------------------
async function probeHealth(seconds, base = API) {
  const times = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const t0 = performance.now();
    await fetch(`${base}/health`).then((r) => r.text()).catch(() => undefined);
    times.push(performance.now() - t0);
    await sleep(100);
  }
  return times.sort((a, b) => a - b);
}
const summarize = (label, times) =>
  console.log(`${label}: n=${times.length} p50=${pct(times, 50).toFixed(1)} ms p99=${pct(times, 99).toFixed(1)} ms max=${times[times.length - 1].toFixed(1)} ms`);

// Baseline: viewers connected, nothing published.
const idle = await probeHealth(15);
summarize('/health idle (viewers connected, no frames)', idle);

// --- publisher ------------------------------------------------------------------------------------------
const published = { live: 0, progress: 0 };
const publishers = new Redis();
let seq = 0;
const excerpt = 'The unit shall meet limit under condition measured at the connector at 25 C and 28 V, with ripple below 50 mV peak to peak across the full range. '.slice(0, 240);
const stop = { value: false };
async function publish() {
  const tickMs = 250;
  let tick = 0;
  while (!stop.value) {
    const started = Date.now();
    const pipeline = publishers.pipeline();
    const framesPerTick = (LIVE_HZ * tickMs) / 1000;
    for (const id of jobIds) {
      for (let f = 0; f < framesPerTick; f++) {
        seq++;
        const frame = { type: 'live', seq, lane: seq % 3, kind: seq % 4 === 0 ? 'item' : 'working_on', ref: `det0_${seq % 5000}`, excerpt, emittedAt: new Date().toISOString() };
        pipeline.publish(`job-events:${id}:live`, JSON.stringify(frame));
        published.live++;
      }
      if (tick % Math.max(1, Math.round(1000 / tickMs / PROGRESS_HZ)) === 0) {
        pipeline.publish(`job-events:${id}:progress`, JSON.stringify({ type: 'progress', seq: ++seq, pct: Math.min(99, tick % 100), stage: 'improve', unit: 'items', done: tick, total: 100000, estimated: true, emittedAt: new Date().toISOString() }));
        published.progress++;
      }
    }
    await pipeline.exec();
    tick++;
    await sleep(Math.max(0, tickMs - (Date.now() - started)));
  }
}
const publisherTask = publish();

// --- soak -------------------------------------------------------------------------------------------------
const samples = [];
const healthLoaded = [];
const healthLoaded2 = [];
const soakEnd = Date.now() + SECONDS * 1000;
let lastSample = 0;
while (Date.now() < soakEnd) {
  const t0 = performance.now();
  await fetch(`${API}/health`).then((r) => r.text()).catch(() => undefined);
  healthLoaded.push(performance.now() - t0);
  if (API2) {
    const t1 = performance.now();
    await fetch(`${API2}/health`).then((r) => r.text()).catch(() => undefined);
    healthLoaded2.push(performance.now() - t1);
  }
  if (Date.now() - lastSample > 10_000) {
    lastSample = Date.now();
    const stats = dockerStats();
    const stats2 = API2 ? dockerStats(ORCH_CONTAINER2) : { memMiB: NaN, cpu: NaN };
    const mem = await memory();
    samples.push({ t: Math.round((Date.now() - (soakEnd - SECONDS * 1000)) / 1000), ...stats, mem2MiB: stats2.memMiB, redisMiB: mem.usedMiB, keys: mem.keys, clients: mem.clients });
  }
  await sleep(100);
}
stop.value = true;
await publisherTask;
await sleep(1500);

healthLoaded.sort((a, b) => a - b);
latencies.sort((a, b) => a - b);
console.log('\n=== results ===');
console.log(`rate: ${LIVE_HZ} live + ${PROGRESS_HZ} progress per second per job, ${JOBS} jobs x ${VIEWERS} viewers, ${SECONDS} s`);
console.log(`published: live ${published.live}, progress ${published.progress}  (per viewer expected: live ${published.live / JOBS}, progress ${published.progress / JOBS})`);
console.log(`received:  live ${received.live}, progress ${received.progress}, heartbeat ${received.heartbeat}  (expected live ${published.live * VIEWERS}, progress ${published.progress * VIEWERS})`);
console.log(`delivery: live ${(100 * received.live / (published.live * VIEWERS)).toFixed(2)} %, progress ${(100 * received.progress / (published.progress * VIEWERS)).toFixed(2)} %, stream errors ${streamErrors}`);
console.log(`end-to-end latency (publish -> viewer): p50=${pct(latencies, 50)} ms p99=${pct(latencies, 99)} ms max=${latencies[latencies.length - 1]} ms`);
summarize('/health under load (replica 1)', healthLoaded);
if (API2) { healthLoaded2.sort((a, b) => a - b); summarize('/health under load (replica 2)', healthLoaded2); }
const memStart = samples[0]; const memEnd = samples[samples.length - 1];
if (API2) console.log(`replica 2 memory: ${memStart?.mem2MiB?.toFixed(0)} MiB -> ${memEnd?.mem2MiB?.toFixed(0)} MiB`);
console.log(`orchestrator memory: ${memStart?.memMiB?.toFixed(0)} MiB -> ${memEnd?.memMiB?.toFixed(0)} MiB; cpu avg ${(samples.reduce((s, x) => s + (x.cpu || 0), 0) / Math.max(1, samples.length)).toFixed(1)} %, max ${Math.max(...samples.map((x) => x.cpu || 0)).toFixed(1)} %`);
console.log(`redis memory: ${before.usedMiB.toFixed(2)} MiB idle -> ${memEnd?.redisMiB?.toFixed(2)} MiB; keys ${before.keys} -> ${memEnd?.keys}; clients ${before.clients} -> ${memEnd?.clients}`);
console.table(samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 8)) === 0));

// --- leave and clean up ---------------------------------------------------------------------------------------
controllers.forEach((c) => c.abort());
await Promise.allSettled(viewerTasks);
await sleep(3000);
const after = await memory();
console.log(`after viewers left: Redis clients ${connected.clients} -> ${after.clients} (started at ${before.clients})`);
for (const id of jobIds) {
  await api('POST', `/jobs/${id}/cancel`).catch(() => undefined);
  await api('DELETE', `/jobs/${id}`).catch(() => undefined);
  const keys = await redis.keys(`job-events:${id}*`);
  if (keys.length) await redis.del(...keys);
}
const afterClean = await memory();
console.log(`after cleanup: keys ${afterClean.keys}, clients ${afterClean.clients}, redis ${afterClean.usedMiB.toFixed(2)} MiB`);
identity.close();
redis.disconnect(); publishers.disconnect();
process.exit(0);
