import {
  PROGRESS_WEIGHTS,
  ProgressService,
  ProgressTracker,
  computeOverall,
  progressChannel,
  progressLatestKey,
  resolvePath,
  unitsChannel,
  unitsLatestKey,
  type ProgressUnits,
  type StageName,
} from '../src/modules/pipeline/progress.service';

const units = (stage: StageName, done: number, total: number, extra: Partial<ProgressUnits> = {}): ProgressUnits => ({
  stage,
  unit: stage === 'parse' ? 'figures' : stage === 'link' ? 'passes' : stage === 'score' ? 'requirements' : 'items',
  done,
  total,
  ...extra,
});

const seenOf = (...entries: ProgressUnits[]): Map<StageName, ProgressUnits> => new Map(entries.map((e) => [e.stage, e]));

// Expected values come from the weight table itself, so a recalibration changes the table and nothing here.
type PathName = keyof typeof PROGRESS_WEIGHTS;
const weightOf = (path: PathName, stage: StageName): number =>
  (PROGRESS_WEIGHTS[path].find((entry) => entry.stage === stage) as { weight: number }).weight;
const D = (stage: StageName): number => weightOf('det', stage);
const L = (stage: StageName): number => weightOf('llm', stage);
const S = (stage: StageName): number => weightOf('scan', stage);
// On the deterministic path the two section stages are optional, so while they have
// not reported the weights that count are all the others.
const DET = 1 - D('skeleton') - D('write');
// The same, with the draft pass planned at zero (skipped) as well.
const DET_NO_DRAFT = DET - D('draft');
const detPct = (draftShare: number): number => Math.round((100 * (D('parse') + D('draft') * draftShare)) / DET);

describe('progress weights', () => {
  it.each(Object.keys(PROGRESS_WEIGHTS))('the %s path weights sum to 1', (path) => {
    const sum = PROGRESS_WEIGHTS[path as keyof typeof PROGRESS_WEIGHTS].reduce((s, e) => s + e.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe('resolvePath', () => {
  it('uses the deterministic path once a draft or improve stage reports', () => {
    expect(resolvePath(seenOf(units('draft', 0, 10)))).toBe('det');
    expect(resolvePath(seenOf(units('improve', 0, 10)))).toBe('det');
  });
  it('uses the section path once skeleton, map or write reports', () => {
    expect(resolvePath(seenOf(units('skeleton', 0, 9)))).toBe('llm');
    expect(resolvePath(seenOf(units('write', 0, 9)))).toBe('llm');
  });
  it('uses the scanned path when parse counts pages', () => {
    expect(resolvePath(seenOf({ stage: 'parse', unit: 'pages', done: 3, total: 48 }))).toBe('scan');
  });
  it('defaults to the deterministic table before anything is known', () => {
    expect(resolvePath(new Map())).toBe('det');
  });
});

describe('computeOverall', () => {
  it('is zero before any stage reports', () => {
    expect(computeOverall(new Map()).value).toBe(0);
  });


  it('weights parse figures by the parse share', () => {
    expect(computeOverall(seenOf(units('parse', 17, 35))).value).toBeCloseTo((D('parse') * (17 / 35)) / DET, 10);
  });

  it('counts an earlier stage that never reported as done', () => {
    // Draft reports 50%: parse (never reported, but a later stage has) is full.
    expect(computeOverall(seenOf(units('draft', 50, 100))).value).toBeCloseTo((D('parse') + D('draft') * 0.5) / DET, 10);
  });

  it('counts every stage at its own fraction, not as done because a later one started', () => {
    const overall = computeOverall(seenOf(units('draft', 10, 100), units('improve', 0, 41)));
    expect(overall.value).toBeCloseTo((D('parse') + D('draft') * 0.1) / DET, 10);
    expect(overall.stage).toBe('draft'); // still unfinished, so it is the step running
  });

  it('names the earliest unfinished step as the current one, not the last to report', () => {
    // The plan reports every pass up front, so summarize has "reported" from the start.
    const seen = seenOf(units('draft', 0, 0, { complete: true }), units('improve', 12, 36), units('summarize', 0, 12));
    expect(computeOverall(seen, units('summarize', 0, 12))).toMatchObject({ stage: 'improve', done: 12, total: 36 });
  });

  it('moves the current step on once the earlier one is finished, and skips a skipped one', () => {
    const seen = seenOf(units('draft', 0, 0, { complete: true }), units('improve', 36, 36, { complete: true }), units('summarize', 3, 12));
    expect(computeOverall(seen)).toMatchObject({ stage: 'summarize', done: 3, total: 12 });
  });

  it('falls back to the latest report when every reported step is finished', () => {
    const seen = seenOf(units('improve', 36, 36, { complete: true }), units('summarize', 12, 12, { complete: true }));
    expect(computeOverall(seen, units('summarize', 12, 12, { complete: true }))).toMatchObject({ stage: 'summarize' });
  });

  it('counts whole-document passes finished', () => {
    const overall = computeOverall(seenOf(units('score', 153, 153, { complete: true }), units('link', 1, 3)));
    expect(overall.value).toBeCloseTo((D('parse') + D('draft') + D('improve') + D('summarize') + D('score') + D('link') / 3) / DET, 10);
  });

  it('honours the complete flag even with a zero total', () => {
    expect(computeOverall(seenOf(units('parse', 0, 0, { complete: true }))).value).toBeCloseTo(D('parse') / DET, 10);
  });

  it('treats an unreported total as no progress inside the stage', () => {
    expect(computeOverall(seenOf(units('draft', 5, 0))).value).toBeCloseTo(D('parse') / DET, 10);
  });

  it('drops a pass planned at zero items instead of handing out its share', () => {
    // The plan arrives right after parsing: nothing to draft, 36 titles to improve, 12 parents.
    const seen = seenOf(
      units('parse', 0, 0, { complete: true }),
      units('draft', 0, 0, { complete: true }),
      units('improve', 0, 36),
      units('summarize', 0, 12),
    );
    // Weights that count: everything but the skipped draft pass and the unseen section stages.
    expect(computeOverall(seen).value).toBeCloseTo(D('parse') / DET_NO_DRAFT, 10);
    // Before this, the skipped 58%-class share was credited at once.
    expect(computeOverall(seen).value).toBeLessThan(0.05);
  });

  it('keeps a skipped pass out even while a later pass advances', () => {
    const seen = seenOf(
      units('parse', 0, 0, { complete: true }),
      units('draft', 0, 0, { complete: true }),
      units('improve', 36, 36, { complete: true }),
      units('summarize', 6, 12),
    );
    expect(computeOverall(seen).value).toBeCloseTo((D('parse') + D('improve') + D('summarize') * 0.5) / DET_NO_DRAFT, 10);
  });

  it('counts the optional section stages only once they report', () => {
    const base = [units('parse', 0, 0, { complete: true }), units('improve', 36, 36, { complete: true })];
    const without = computeOverall(seenOf(...base, units('summarize', 12, 12, { complete: true }))).value;
    const withSkeleton = computeOverall(
      seenOf(...base, units('summarize', 12, 12, { complete: true }), units('skeleton', 0, 1)),
    ).value;
    expect(without).toBeCloseTo((D('parse') + D('draft') + D('improve') + D('summarize')) / DET, 10);
    // skeleton (.03) joins the weights that count and has done nothing yet.
    expect(withSkeleton).toBeCloseTo((D('parse') + D('draft') + D('improve') + D('summarize')) / (DET + D('skeleton')), 10);
  });

  it('a pass that is only partly counted can still end complete', () => {
    const seen = seenOf(units('improve', 30, 36, { complete: true }));
    expect(computeOverall(seen).value).toBeCloseTo((D('parse') + D('draft') + D('improve')) / DET, 10);
  });

  it('uses the section path table for sections', () => {
    const overall = computeOverall(seenOf(units('skeleton', 9, 9), units('write', 4, 9)));
    expect(overall.value).toBeCloseTo(L('parse') + L('skeleton') + L('map') + L('write') * (4 / 9), 10);
  });

  it('reads pages as the biggest parse share on the scanned path', () => {
    const overall = computeOverall(seenOf({ stage: 'parse', unit: 'pages', done: 24, total: 48 }));
    expect(overall.value).toBeCloseTo(S('parse') * 0.5, 10);
  });

  it('ignores stages outside the path table', () => {
    expect(computeOverall(seenOf(units('write_ado', 5, 10))).value).toBe(0);
  });
});

describe('steps that never say they finished (found by calibrating on real runs)', () => {
  const stageUnits = (stage: StageName, unit: ProgressUnits['unit'], done: number, total: number, extra: Partial<ProgressUnits> = {}): ProgressUnits =>
    ({ stage, unit, done, total, ...extra });

  it('counts the section skeleton as done once a later step has reported, and names the later step', () => {
    // The skeleton step only ever reports "section N of M" at its start.
    const seen = seenOf(stageUnits('skeleton', 'sections', 0, 1), stageUnits('write', 'sections', 0, 1));
    const overall = computeOverall(seen);
    // llm table: parse .03 (never reported, a later step has) + skeleton .20 done + map .03 (unseen, before write) done.
    expect(overall.value).toBeCloseTo(L('parse') + L('skeleton') + L('map'), 10);
    expect(overall.stage).toBe('write');
  });

  it('keeps the skeleton unfinished while it is the latest step', () => {
    const overall = computeOverall(seenOf(stageUnits('skeleton', 'sections', 0, 1)));
    expect(overall.value).toBeCloseTo(L('parse'), 10); // only parse counts (skeleton has not finished)
    expect(overall.stage).toBe('skeleton');
  });

  it('counts the last trace-link pass as done once duplicate checking starts (the pass has no end event)', () => {
    const seen = seenOf(
      stageUnits('skeleton', 'sections', 0, 1), stageUnits('write', 'sections', 1, 1), stageUnits('score', 'requirements', 36, 36, { complete: true }),
      stageUnits('link', 'passes', 2, 3), stageUnits('dedup', 'items', 49, 49, { complete: true }),
    );
    expect(computeOverall(seen).value).toBeCloseTo(1, 10);
  });

  it('on the scanned path, a finished run reaches the end without a final jump', () => {
    const seen = seenOf(
      { stage: 'parse', unit: 'pages', done: 12, total: 12, complete: true },
      stageUnits('skeleton', 'sections', 0, 1), stageUnits('map', 'passes', 0, 1), stageUnits('write', 'sections', 1, 1),
      stageUnits('score', 'requirements', 5, 5, { complete: true }), stageUnits('link', 'passes', 2, 3), stageUnits('dedup', 'items', 6, 6),
    );
    expect(computeOverall(seen).value).toBeGreaterThan(0.99);
  });

  it('does not treat a pass that interleaves as finished just because the next interleaving pass started', () => {
    const seen = seenOf(stageUnits('improve', 'items', 12, 36), stageUnits('summarize', 'items', 1, 12));
    const withBoth = computeOverall(seen).value;
    expect(withBoth).toBeCloseTo((D('parse') + D('draft') + D('improve') * (12 / 36) + D('summarize') * (1 / 12)) / DET, 10);
    expect(computeOverall(seen).stage).toBe('improve');
  });

  it('does count the deterministic passes as finished once a sequential step after them reports', () => {
    const seen = seenOf(stageUnits('improve', 'items', 12, 36), stageUnits('summarize', 'items', 1, 12), stageUnits('skeleton', 'sections', 0, 1));
    const overall = computeOverall(seen);
    expect(overall.value).toBeCloseTo((D('parse') + D('draft') + D('improve') + D('summarize')) / (DET + D('skeleton')), 10);
    expect(overall.stage).toBe('skeleton');
  });
});

describe('which path a run is on (a planned-at-zero marker is not evidence)', () => {
  const marker = (stage: StageName): ProgressUnits => ({ stage, unit: 'items', done: 0, total: 0, complete: true });

  it('stays off the deterministic path when only zero-item markers have been seen', () => {
    expect(resolvePath(seenOf(marker('summarize'), { stage: 'skeleton', unit: 'sections', done: 0, total: 1 }))).toBe('llm');
    expect(resolvePath(seenOf(marker('draft'), marker('improve'), marker('summarize'), { stage: 'write', unit: 'sections', done: 0, total: 3 }))).toBe('llm');
  });

  it('is deterministic once a pass has real work', () => {
    expect(resolvePath(seenOf(marker('draft'), { stage: 'improve', unit: 'items', done: 0, total: 36 }))).toBe('det');
    expect(resolvePath(seenOf({ stage: 'summarize', unit: 'items', done: 1, total: 12 }))).toBe('det');
  });

  it('a text document with only markers uses the section weights, so its skeleton is worth what the section table says', () => {
    const seen = seenOf(marker('summarize'), { stage: 'skeleton', unit: 'sections', done: 0, total: 1 }, { stage: 'write', unit: 'sections', done: 0, total: 1 });
    expect(computeOverall(seen).value).toBeCloseTo(L('parse') + L('skeleton') + L('map'), 10);
  });
});

describe('ProgressTracker', () => {
  const fixed = () => new Date('2026-10-05T10:00:00.000Z');

  it('emits only when the percentage or stage changes', () => {
    const tracker = new ProgressTracker(fixed);
    expect(tracker.ingest(units('draft', 0, 1000))?.pct).toBe(detPct(0)); // stage changed, parse share is full
    expect(tracker.ingest(units('draft', 0, 1000))).toBeNull();
    expect(tracker.ingest(units('draft', 1, 1000))).toBeNull(); // rounds to the same percent
    expect(tracker.ingest(units('draft', 500, 1000))?.pct).toBe(detPct(0.5));
  });

  it('never decreases', () => {
    const tracker = new ProgressTracker(fixed);
    tracker.ingest(units('draft', 80, 100));
    const before = tracker.ingest(units('draft', 90, 100))?.pct ?? 0;
    // An out-of-order, smaller count (concurrent chunks) must not lower it.
    expect(tracker.ingest(units('draft', 10, 100))?.pct ?? before).toBeGreaterThanOrEqual(before);
  });

  it('caps at 99 until finish()', () => {
    const tracker = new ProgressTracker(fixed);
    const event = tracker.ingest(units('dedup', 153, 153, { complete: true }));
    expect(event?.pct).toBe(99);
    expect(tracker.finish()?.pct).toBe(100);
  });

  it('keeps a scanned run on the scanned path when parse then reports figures complete (B10)', () => {
    const tracker = new ProgressTracker(fixed);
    expect(tracker.ingest(units('parse', 5, 10, { unit: 'pages' }))?.pct).toBe(6); // 12% share, half done
    // The ordinary "parse finished" event counts figures; pages and the path stay.
    expect(tracker.ingest(units('parse', 0, 0, { unit: 'figures', complete: true }))?.pct).toBe(12);
    expect(tracker.ingest(units('skeleton', 0, 4))?.pct).toBe(12);
    expect(tracker.ingest(units('skeleton', 2, 4))?.pct).toBe(Math.round(100 * (S('parse') + S('skeleton') * 0.5)));
  });

  it('after a restart the saved pages and figures units still read as a scanned run (B10 follow-up)', () => {
    for (const hashOrder of [['parse_pages', 'parse'], ['parse', 'parse_pages']]) {
      const tracker = new ProgressTracker(fixed);
      const saved: Record<string, ProgressUnits> = {
        parse_pages: units('parse', 3, 3, { unit: 'pages' }),
        parse: units('parse', 3, 3, { unit: 'figures', complete: true }),
      };
      tracker.seed(hashOrder.map((key) => saved[key]), { seq: 2, pct: 12, stage: 'parse' });
      // Skeleton 2 of 4 on the scanned table, not the text table's value.
      expect(tracker.ingest(units('skeleton', 2, 4))?.pct).toBe(Math.round(100 * (S('parse') + S('skeleton') * 0.5)));
    }
  });

  it('finish() only fires once', () => {
    const tracker = new ProgressTracker(fixed);
    expect(tracker.finish()).not.toBeNull();
    expect(tracker.finish()).toBeNull();
  });

  it('numbers events in sequence and stamps them', () => {
    const tracker = new ProgressTracker(fixed);
    const first = tracker.ingest(units('draft', 0, 10));
    const second = tracker.ingest(units('draft', 9, 10));
    expect([first?.seq, second?.seq]).toEqual([1, 2]);
    expect(first?.emittedAt).toBe('2026-10-05T10:00:00.000Z');
    expect(first?.type).toBe('progress');
    expect(first?.estimated).toBe(true);
  });

  it('resumes the sequence and floor after a restart', () => {
    const tracker = new ProgressTracker(fixed);
    tracker.seed([units('draft', 50, 100)], { seq: 7, pct: detPct(0.5), stage: 'draft' });
    const next = tracker.ingest(units('draft', 60, 100));
    expect(next?.seq).toBe(8);
    expect(next?.pct).toBeGreaterThanOrEqual(detPct(0.5));
  });
});

class FakeRedis {
  published: Array<[string, string]> = [];
  store = new Map<string, string>();
  hashes = new Map<string, Record<string, string>>();
  failPublish = false;
  async publish(channel: string, message: string): Promise<number> {
    if (this.failPublish) throw new Error('redis is down');
    this.published.push([channel, message]);
    return 1;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.hashes.get(key) ?? {};
  }
}

class FakeSubscriber {
  listener: ((channel: string, message: string) => void) | null = null;
  subscribed: string[] = [];
  unsubscribed: string[] = [];
  quit = jest.fn().mockResolvedValue('OK');
  on(_event: 'message', listener: (channel: string, message: string) => void): this {
    this.listener = listener;
    return this;
  }
  async subscribe(channel: string): Promise<void> {
    this.subscribed.push(channel);
  }
  async unsubscribe(channel: string): Promise<void> {
    this.unsubscribed.push(channel);
  }
  emit(channel: string, payload: unknown): void {
    this.listener?.(channel, typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const unitsMessage = (u: ProgressUnits) => ({ type: 'units', ...u, complete: u.complete ?? false, emittedAt: 'x' });

describe('ProgressService', () => {
  const setup = () => {
    const redis = new FakeRedis();
    const subscriber = new FakeSubscriber();
    const service = new ProgressService(redis, () => subscriber, () => new Date('2026-10-05T10:00:00.000Z'));
    return { redis, subscriber, service };
  };

  it('subscribes to the job units channel and publishes progress on its own channel', async () => {
    const { redis, subscriber, service } = setup();
    await service.track('job-1');
    expect(subscriber.subscribed).toEqual([unitsChannel('job-1')]);
    subscriber.emit(unitsChannel('job-1'), unitsMessage(units('draft', 50, 100)));
    await flush();
    expect(redis.published).toHaveLength(1);
    const [channel, message] = redis.published[0];
    expect(channel).toBe(progressChannel('job-1'));
    expect(JSON.parse(message)).toMatchObject({ type: 'progress', stage: 'draft', pct: detPct(0.5), seq: 1 });
    expect(JSON.parse(redis.store.get(progressLatestKey('job-1')) as string).pct).toBe(detPct(0.5));
  });

  it('never publishes to the browser job-events channel', async () => {
    const { redis, subscriber, service } = setup();
    await service.track('job-1');
    subscriber.emit(unitsChannel('job-1'), unitsMessage(units('draft', 50, 100)));
    await flush();
    expect(redis.published.every(([channel]) => channel !== 'job-events:job-1')).toBe(true);
  });

  it('ignores malformed and unrelated messages', async () => {
    const { redis, subscriber, service } = setup();
    await service.track('job-1');
    subscriber.emit(unitsChannel('job-1'), 'not json');
    subscriber.emit(unitsChannel('job-1'), { type: 'narration', phase: 'x' });
    subscriber.emit(unitsChannel('job-1'), { type: 'units', stage: 'draft' });
    await flush();
    expect(redis.published).toHaveLength(0);
  });

  it('seeds from the latest units and last progress after a restart', async () => {
    const { redis, subscriber, service } = setup();
    redis.hashes.set(unitsLatestKey('job-1'), { draft: JSON.stringify(unitsMessage(units('draft', 50, 100))) });
    redis.store.set(progressLatestKey('job-1'), JSON.stringify({ type: 'progress', seq: 7, pct: detPct(0.5), stage: 'draft' }));
    await service.track('job-1');
    subscriber.emit(unitsChannel('job-1'), unitsMessage(units('draft', 80, 100)));
    await flush();
    expect(JSON.parse(redis.published[0][1])).toMatchObject({ seq: 8 });
    expect(JSON.parse(redis.published[0][1]).pct).toBeGreaterThan(detPct(0.5));
  });

  it('records orchestrator-side duplicate-check units and finishes at 100', async () => {
    const { redis, service } = setup();
    await service.record('job-1', { stage: 'dedup', unit: 'items', done: 10, total: 20 });
    await service.finish('job-1');
    const pcts = redis.published.map(([, message]) => JSON.parse(message).pct);
    expect(pcts[pcts.length - 1]).toBe(100);
    expect(pcts[0]).toBeLessThan(100);
  });

  it('stop() unsubscribes and closes the subscriber', async () => {
    const { subscriber, service } = setup();
    const stop = await service.track('job-1');
    await stop();
    expect(subscriber.unsubscribed).toEqual([unitsChannel('job-1')]);
    expect(subscriber.quit).toHaveBeenCalled();
  });

  it('never throws when Redis is down', async () => {
    const { redis, subscriber, service } = setup();
    redis.failPublish = true;
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await service.track('job-1');
    subscriber.emit(unitsChannel('job-1'), unitsMessage(units('draft', 50, 100)));
    await flush();
    await expect(service.record('job-1', units('dedup', 1, 2))).resolves.toBeUndefined();
    await expect(service.finish('job-1')).resolves.toBeUndefined();
    errors.mockRestore();
  });

  it('survives a subscriber that cannot subscribe', async () => {
    const { subscriber, service } = setup();
    subscriber.subscribe = jest.fn().mockRejectedValue(new Error('no connection'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const stop = await service.track('job-1');
    await expect(stop()).resolves.toBeUndefined();
    errors.mockRestore();
  });
});
