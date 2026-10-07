import { describe, expect, it } from 'vitest';
import { formatStepRemaining, observeStep, stepEta, type StepEta, type StepEtaState } from './stepEta';

// Replays of REAL scoring timelines from prod (seconds since the first scoring event, units = requirements scored).
//
// Healthy: job 3df04440 -- scoring 427 requirements in batches of up to 50; every batch returned.
const HEALTHY_TOTAL = 427;
const HEALTHY: [number, number][] = [
  [0, 0], [46.409, 50], [52.648, 53], [56.637, 54], [89.244, 89], [135.613, 139], [179.849, 189],
  [225.296, 239], [269.987, 289], [316.64, 339], [363.351, 389], [400.629, 427],
];
// Failed: job 0b9a134f -- two 150-requirement batches hung for ~15 minutes each (units frozen), then dropped.
const FROZEN_TOTAL = 427;
const FROZEN: [number, number][] = [[0, 0], [109.805, 123], [1021.318, 273], [1901.939, 423], [1909.19, 427]];

const KEY = 'scoring:427';

/** Walks a timeline, observing each completion and sampling the display every 5 s in between. */
function replay(timeline: [number, number][], total: number) {
  const displays: { t: number; eta: StepEta; done: number }[] = [];
  let state: StepEtaState | null = null;
  const end = Math.ceil(timeline[timeline.length - 1][0]);
  let next = 0;
  for (let t = 0; t <= end; t += 1) {
    while (next < timeline.length && timeline[next][0] <= t) {
      state = observeStep(state, KEY, timeline[next][1], total, timeline[next][0] * 1000);
      next += 1;
    }
    const done = timeline.filter(([at]) => at <= t).pop()![1];
    if (t % 5 === 0 || t === end || timeline.some(([at]) => Math.floor(at) === t)) {
      displays.push({ t, eta: stepEta(state, done, total, t * 1000), done });
    }
  }
  return displays;
}

describe('stepEta replay of real prod timelines', () => {
  it('healthy job: the shown time never rises between completions', () => {
    const displays = replay(HEALTHY, HEALTHY_TOTAL);
    const completions = new Set(HEALTHY.map(([at]) => Math.floor(at)));
    let previous: number | null = null;
    let previousDone = -1;
    for (const { t, eta, done } of displays) {
      if (eta.kind !== 'left') {
        previous = null;
        continue;
      }
      if (done === previousDone && previous !== null && !completions.has(t)) {
        expect(eta.ms).toBeLessThanOrEqual(previous); // a gap with nothing landed: only goes down
      }
      previous = eta.ms;
      previousDone = done;
    }
  });

  it('healthy job: within 35% of the true remaining time once 40% is done', () => {
    let checked = 0;
    let state: StepEtaState | null = null;
    for (const [t, done] of HEALTHY) {
      state = observeStep(state, KEY, done, HEALTHY_TOTAL, t * 1000);
      if (done / HEALTHY_TOTAL < 0.4 || done >= HEALTHY_TOTAL) continue;
      const eta = stepEta(state, done, HEALTHY_TOTAL, t * 1000);
      expect(eta.kind).toBe('left');
      if (eta.kind !== 'left') continue;
      const actualMs = (HEALTHY[HEALTHY.length - 1][0] - t) * 1000;
      expect(Math.abs(eta.ms - actualMs) / actualMs).toBeLessThan(0.35);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('healthy job: says it is estimating until it has seen enough, and is done at the end', () => {
    const displays = replay(HEALTHY, HEALTHY_TOTAL);
    expect(displays.find(({ t }) => t === 0)!.eta.kind).toBe('estimating');
    expect(displays[displays.length - 1].eta.kind).toBe('done');
  });

  it('failed job: counts down to the prediction, then says "overdue" -- never a number that grows -- for the whole hang', () => {
    const displays = replay(FROZEN, FROZEN_TOTAL);
    const afterFirstBatch = displays.filter(({ t }) => t >= 110 && t < 1021);
    const numbers = afterFirstBatch.filter(({ eta }) => eta.kind === 'left').map(({ eta }) => (eta as { ms: number }).ms);
    expect(numbers.length).toBeGreaterThan(10);
    for (let i = 1; i < numbers.length; i += 1) expect(numbers[i]).toBeLessThanOrEqual(numbers[i - 1]);
    // ~381 s after the first batch the prediction passes, and for the remaining ~640 s of the hang it is overdue.
    const overdue = afterFirstBatch.filter(({ eta }) => eta.kind === 'overdue');
    expect(overdue.length).toBeGreaterThan(100);
    expect(afterFirstBatch.filter(({ t }) => t > 400).every(({ eta }) => eta.kind === 'overdue')).toBe(true);
  });

  it('failed job: re-fits when the stalled batch finally resolves, and shows a number again', () => {
    let state: StepEtaState | null = null;
    for (const [t, done] of FROZEN.slice(0, 3)) state = observeStep(state, KEY, done, FROZEN_TOTAL, t * 1000);
    const eta = stepEta(state, 273, FROZEN_TOTAL, 1021.318 * 1000);
    expect(eta.kind).toBe('left');
    if (eta.kind === 'left') expect(eta.ms).toBeGreaterThan(300_000); // the real rate is ~0.27 units/s, ~10 min left
  });
});

describe('observeStep', () => {
  const at = (s: number) => s * 1000;

  it('returns the same state for an observation with no new progress, so it is safe to call on every render', () => {
    const first = observeStep(null, KEY, 0, 100, at(0));
    expect(observeStep(first, KEY, 0, 100, at(5))).toBe(first);
  });

  it('starts over for a different step or when progress goes backwards', () => {
    let state = observeStep(null, KEY, 0, 100, at(0));
    state = observeStep(state, KEY, 10, 100, at(30));
    expect(observeStep(state, 'scoring:115', 0, 115, at(40)).samples).toHaveLength(1);
    expect(observeStep(state, KEY, 4, 100, at(40)).samples).toHaveLength(1);
  });

  it('needs two completed intervals, or one after 45 s, before it will show a number', () => {
    let state = observeStep(null, KEY, 0, 100, at(0));
    state = observeStep(state, KEY, 10, 100, at(20));
    expect(state.predictedAt).toBeNull(); // one interval, only 20 s watched
    expect(stepEta(state, 10, 100, at(20)).kind).toBe('estimating');
    state = observeStep(state, KEY, 20, 100, at(40));
    expect(state.predictedAt).not.toBeNull(); // second interval

    let slow = observeStep(null, KEY, 0, 100, at(0));
    slow = observeStep(slow, KEY, 10, 100, at(50));
    expect(slow.predictedAt).not.toBeNull(); // one interval but 50 s watched
  });

  it('lowers the prediction freely but raises it only when it is clearly later', () => {
    let state = observeStep(null, KEY, 0, 100, at(0));
    state = observeStep(state, KEY, 10, 100, at(20));
    state = observeStep(state, KEY, 20, 100, at(40)); // 0.5 units/s -> 80 units left -> done at 40 + 160 = 200 s
    const first = state.predictedAt!;
    expect(first).toBeCloseTo(at(200), -2);

    // a bit slower (within 25% + 30 s of what is shown): the shown completion time stays
    const slightlySlower = observeStep(state, KEY, 25, 100, at(60));
    expect(slightlySlower.predictedAt).toBe(first);

    // a lot slower: adopted
    const muchSlower = observeStep(state, KEY, 21, 100, at(400));
    expect(muchSlower.predictedAt!).toBeGreaterThan(first);

    // faster: adopted immediately
    const faster = observeStep(state, KEY, 60, 100, at(50));
    expect(faster.predictedAt!).toBeLessThan(first);
  });
});

describe('formatStepRemaining', () => {
  it.each([
    [4_000, '10s'],
    [41_000, '40s'],
    [59_000, '60s'],
    [75_000, '1m 30s'],
    [150_000, '2m 30s'],
    [180_000, '3m'],
    [599_000, '10m'],
    [12 * 60_000 + 20_000, '12m'],
    [95 * 60_000, '1h 35m'],
    [120 * 60_000, '2h'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(formatStepRemaining(ms)).toBe(expected);
  });
});
