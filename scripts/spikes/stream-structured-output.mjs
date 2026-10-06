#!/usr/bin/env node
// Job transparency spikes A and B (docs/job-transparency-implementation-plan.md, section 4).
//
// A: does the deployed model backend stream schema-constrained JSON
//    incrementally (many chunks over time) rather than as one block at the end?
// B: do the per-item entries come back in INPUT order?
//
// Calls the orchestrator's own /llm/chat/stream proxy -- the exact path the
// drafting calls would use -- so it measures the real stack, not a guess.
// Prints timing and order statistics only. It never prints model output,
// prompts or credentials.
//
// Usage (from req2ado/):
//   ORCHESTRATOR_URL=http://localhost:3001 LLM_PROXY_BEARER=... REQ2ADO_USER_ID=... \
//   [MODEL=name] [RUNS=5] [ITEMS=20] node scripts/spikes/stream-structured-output.mjs
const url = (process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const bearer = process.env.LLM_PROXY_BEARER;
const userId = process.env.REQ2ADO_USER_ID;
const model = process.env.MODEL;
const runs = Number(process.env.RUNS ?? 5);
const itemCount = Number(process.env.ITEMS ?? 20);
if (!bearer || !userId) {
  console.error('Set LLM_PROXY_BEARER and REQ2ADO_USER_ID (and optionally ORCHESTRATOR_URL, MODEL, RUNS, ITEMS).');
  process.exit(2);
}

const ids = Array.from({ length: itemCount }, (_, i) => `r${String(i + 1).padStart(3, '0')}`);
const texts = ids.map((id, i) => `The BP shall provide ${[28, 12, 5, 3.3][i % 4]} V DC to connector J${1 + (i % 6)} with a maximum ripple of ${[50, 30, 80][i % 3]} mV.`);
const schema = {
  type: 'object',
  properties: Object.fromEntries(ids.map((id) => [id, { type: 'object', properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'tags'] }])),
  required: ids,
};
const messages = [
  { role: 'system', content: 'For each input id return a short scannable title and zero or more tags. Answer with one JSON object keyed by the input ids, in the same order as the input.' },
  { role: 'user', content: JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, texts[i]]))) },
];

async function once() {
  const started = performance.now();
  const response = await fetch(`${url}/llm/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, 'x-req2ado-user-id': userId },
    body: JSON.stringify({ messages, temperature: 0, seed: 42, responseSchema: schema, ...(model ? { model } : {}) }),
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const contentChunkTimes = [];
  let reasoningChunks = 0;
  const firstSeen = new Map();
  let sawFinishMarker = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let chunk;
      try { chunk = JSON.parse(line); } catch { continue; }
      if (chunk.done || chunk.finishReason) sawFinishMarker = true;
      if (chunk.reasoningDelta) reasoningChunks++;
      if (chunk.delta) {
        const t = performance.now() - started;
        contentChunkTimes.push(t);
        content += chunk.delta;
        for (const id of ids) {
          if (!firstSeen.has(id) && content.includes(`"${id}"`)) firstSeen.set(id, t);
        }
      }
    }
  }
  const total = performance.now() - started;
  let validJson = true;
  try { JSON.parse(content); } catch { validJson = false; }
  // Order: items sorted by when their key first appeared, compared with input order.
  const appearance = ids.filter((id) => firstSeen.has(id)).sort((a, b) => firstSeen.get(a) - firstSeen.get(b));
  const inOrderPairs = appearance.slice(1).filter((id, k) => ids.indexOf(id) > ids.indexOf(appearance[k])).length;
  const orderRatio = appearance.length > 1 ? inOrderPairs / (appearance.length - 1) : 0;
  const first = contentChunkTimes[0] ?? NaN;
  return { total, first, chunks: contentChunkTimes.length, reasoningChunks, validJson, items: appearance.length, orderRatio, sawFinishMarker };
}

const results = [];
for (let i = 0; i < runs; i++) {
  try {
    const r = await once();
    results.push(r);
    console.log(`run ${i + 1}: total ${(r.total / 1000).toFixed(1)}s, first content ${(r.first / 1000).toFixed(1)}s, ${r.chunks} content chunks, ${r.reasoningChunks} reasoning chunks, ${r.items}/${itemCount} items seen, order ${(r.orderRatio * 100).toFixed(0)}%, valid JSON ${r.validJson}`);
  } catch (e) {
    console.log(`run ${i + 1}: failed (${e.message})`);
  }
}
const ok = results.filter((r) => Number.isFinite(r.first));
if (!ok.length) { console.log('No successful runs.'); process.exit(1); }
const incremental = ok.every((r) => r.chunks >= 10 && (r.first - 0) < 0.5 * r.total);
const avgOrder = ok.reduce((s, r) => s + r.orderRatio, 0) / ok.length;
console.log('');
console.log(`Spike A (incremental structured streaming): ${incremental ? 'PASS' : 'FAIL'}  (needs >=10 content chunks and first content before half of total time, every run)`);
console.log(`Spike B (input order): ${avgOrder >= 0.95 ? 'PASS' : 'FAIL'}  (average ${(avgOrder * 100).toFixed(0)}%, needs >=95%)`);
console.log(`Spike C (finish marker on the stream today): ${ok.some((r) => r.sawFinishMarker) ? 'present' : 'absent (expected before work package B7 adds it)'}`);
