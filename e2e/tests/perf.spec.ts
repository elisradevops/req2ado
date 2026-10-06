import { expect, test } from '@playwright/test';
import { fixtureFor, liveEvent, progressEvent, type DocMap } from '../fixtures/documents';
import { openRunningJob } from '../fixtures/harness';

// Cost of the live view's updates on the browser's main thread, on a document with
// 5,000 headings. Budget (plan, Phase 3): under 5% of a core over the same page
// with no live events, and no long task (over 50 ms) from them.
// Real clock; desktop project only (a laptop-class profile; a phone would need its own budget).

const WINDOW_MS = 20_000;
const ITEMS = 5000;

function bigMap(): DocMap {
  const base = fixtureFor('docx').map;
  const items = Array.from({ length: ITEMS }, (_, i) => ({
    ref: `det0_${i}`, title: `Requirement ${i}: the unit shall meet limit ${i}`, words: 20, depth: i % 7 === 0 ? 0 : i % 7 === 1 ? 1 : 2, type: 'Requirement',
  }));
  return { ...base, totalItems: ITEMS, items, stats: { ...base.stats, headings: ITEMS, words: ITEMS * 20 } };
}

test.describe('browser cost of live updates', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'measured on the desktop profile only');
  });
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  async function measure(live: boolean, page: import('@playwright/test').Page): Promise<{ cpuMs: number; longTasks: number[]; frames: number }> {
    const fx = fixtureFor('docx');
    fx.map = bigMap();
    fx.refs = fx.map.items.map((i) => i.ref);
    await page.addInitScript(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    });
    const h = await openRunningJob(page, fx, { realTime: true });
    await page.getByTestId('document-outline').waitFor();
    await page.waitForTimeout(1_500); // let the first render settle
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const taskDuration = async (): Promise<number> => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return (metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000;
    };
    await page.evaluate(() => ((window as unknown as { __longTasks: number[] }).__longTasks.length = 0));
    const before = await taskDuration();
    const start = Date.now();
    let frames = 0;
    let seq = 1;
    while (Date.now() - start < WINDOW_MS) {
      if (live) {
        // What a busy run produces: a progress event every second, frames at the 4/s budget, an item finishing.
        const events = [
          liveEvent(seq++, 0, 'working_on', { ref: `det0_${(seq * 3) % ITEMS}`, excerpt: 'The unit shall meet limit under condition measured at the connector.' }),
          liveEvent(seq++, 1, 'item', { ref: `det0_${seq % ITEMS}`, title: `Requirement ${seq}` }),
        ];
        if (seq % 8 < 2) events.push(progressEvent(seq, Math.min(99, Math.floor(seq / 30)), 'improve', 'items', seq, 100_000));
        await page.evaluate((list) => {
          const sse = (window as unknown as { __sse: { emit: (t: string, d: unknown) => void } }).__sse;
          for (const [type, data] of list) sse.emit(type, data);
        }, events);
        frames += events.length;
      }
      await page.waitForTimeout(500); // two pushes a second of ~2 frames = about 4 frames a second
    }
    const elapsed = Date.now() - start;
    const cpuMs = (await taskDuration()) - before;
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.slice());
    void h;
    return { cpuMs: (cpuMs / elapsed) * WINDOW_MS, longTasks, frames };
  }

  let baseline = 0;

  test('baseline: the same page with no live events', async ({ page }) => {
    const result = await measure(false, page);
    baseline = result.cpuMs;
    console.log(`PERF baseline  main-thread ${result.cpuMs.toFixed(0)} ms over ${WINDOW_MS / 1000} s (${((result.cpuMs / WINDOW_MS) * 100).toFixed(2)} % of a core)`);
  });

  test('with live updates at the frame budget the extra cost stays under 5% of a core and adds no long task', async ({ page }) => {
    const result = await measure(true, page);
    const extraPct = ((result.cpuMs - baseline) / WINDOW_MS) * 100;
    console.log(`PERF live      main-thread ${result.cpuMs.toFixed(0)} ms over ${WINDOW_MS / 1000} s, ${result.frames} frames, extra ${extraPct.toFixed(2)} % of a core, long tasks ${JSON.stringify(result.longTasks.map(Math.round))}`);
    expect(extraPct, 'extra main-thread cost, % of a core').toBeLessThan(5);
    expect(result.longTasks.filter((d) => d > 50), 'long tasks (ms)').toEqual([]);
  });
});
