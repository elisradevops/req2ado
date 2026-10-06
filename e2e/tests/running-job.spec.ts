import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  DOC_KINDS, DUPLICATE, conflictFor, conflictSideNames, fixtureFor, heartbeatEvent, liveEvent, narrationEvent, parallelScript,
  progressEvent, smoothScript, stageEvent, type DocFixture,
} from '../fixtures/documents';
import { openRunningJob, type Harness } from '../fixtures/harness';

// The running-job screen's live view, over every kind of document and a set of
// situations a real run goes through. Each cell then runs the same shared
// checks (layout, accessibility, keyboard, motion). The project (see
// playwright.config.ts) supplies the width and the reduced-motion setting.
//
// The plan listed "output limit reached" and "context assumed" as situations;
// those notices belong to the typed-notice work (B12) that is not built, so the
// cells here are the situations the live view does have today: smooth, parallel
// parts, a conflict, a duplicate, a long model request, a lost connection, and
// a reload in the middle of a run.

type Situation =
  | 'smooth' | 'parallel' | 'conflict' | 'duplicate' | 'long-wait' | 'connection-lost' | 'reload-mid-run';
const SITUATIONS: Situation[] = [
  'smooth', 'parallel', 'conflict', 'duplicate', 'long-wait', 'connection-lost', 'reload-mid-run',
];

const panel = (page: Page) => page.getByTestId('live-run-panel');

// The project's `reducedMotion` setting is applied explicitly: with this
// Playwright and Chromium the context option alone left the media query
// unmatched (checked with matchMedia), which would have made the reduced-motion
// projects silently test normal motion.
test.beforeEach(async ({ page }, testInfo) => {
  const wanted = testInfo.project.use.reducedMotion ?? 'no-preference';
  await page.emulateMedia({ reducedMotion: wanted });
});

/**
 * On a phone the app's navigation rail opens at 220px and nothing collapses it,
 * which leaves about 110px for the page (an existing shell limitation, not part
 * of the live view). A phone user collapses it first, so the phone projects do
 * too; the live view is then judged at the width it actually gets.
 */
async function collapseRailOnPhone(page: Page, testInfo: TestInfo): Promise<void> {
  if (!testInfo.project.name.startsWith('phone')) return;
  const toggle = page.getByRole('button', { name: 'Collapse navigation' });
  if (await toggle.count()) await toggle.click();
}

/** The state each situation puts the page in. */
async function arrange(situation: Situation, page: Page, h: Harness, fx: DocFixture): Promise<void> {
  const outline = fx.refs.length > 0;
  switch (situation) {
    case 'smooth':
      await h.push(smoothScript(fx));
      break;
    case 'parallel':
      await h.push(parallelScript(fx));
      break;
    case 'conflict':
      await h.push([...smoothScript(fx), liveEvent(50, 0, 'compare', { compare: conflictFor(fx) })]);
      break;
    case 'duplicate':
      await h.push([...smoothScript(fx), liveEvent(50, 0, 'compare', { compare: DUPLICATE })]);
      break;
    case 'long-wait':
      await h.push([...smoothScript(fx), heartbeatEvent(15, [{ lane: 0, kind: 'working_on' }])]);
      for (const idle of [30, 45, 60, 75]) {
        await h.tick(15_000);
        await h.push([heartbeatEvent(idle, [{ lane: 0, kind: 'working_on' }])]);
      }
      break;
    case 'connection-lost':
      await h.push(smoothScript(fx));
      await h.streamError();
      await h.tick(31_000);
      break;
    case 'reload-mid-run': {
      const script = smoothScript(fx);
      await h.push(script);
      const finished = outline ? fx.refs.slice(0, 5) : null;
      h.setDone(finished);
      const lastProgress = [...script].reverse().find(([type]) => type === 'progress');
      const lastLive = [...script].reverse().find(([type, data]) => type === 'live' && (data as { kind: string }).kind !== 'item');
      await h.reloadWith([stageEvent(), narrationEvent(), ...(lastProgress ? [lastProgress] : []), ...(lastLive ? [lastLive] : [])]);
      break;
    }
  }
}

/** What each situation must show. */
async function expectSituation(situation: Situation, page: Page, fx: DocFixture): Promise<void> {
  const outline = fx.refs.length > 0;
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('document-metrics')).toBeVisible();
  await expect(page.getByTestId('document-metrics')).toContainText('words');

  if (outline) await expect(page.getByTestId('document-outline')).toBeVisible();
  else await expect(page.getByTestId('document-outline')).toHaveCount(0);

  switch (situation) {
    case 'smooth':
    case 'conflict':
    case 'duplicate':
    case 'connection-lost':
    case 'long-wait':
    case 'reload-mid-run':
      await expect(page.getByTestId('working-on-card')).toBeVisible();
      if (fx.kind === 'scanned') await expect(page.getByTestId('working-on-card')).toContainText('Reading page 4 of 12');
      if (outline) {
        await expect(page.getByTestId('document-metrics')).toContainText('5 of');
        await expect(page.getByTestId('document-outline').getByRole('region')).toHaveAttribute('aria-label', /5 of \d+ written/);
      }
      break;
    case 'parallel':
      await expect(page.getByTestId('working-on-card')).toContainText('3 parts in parallel');
      await expect(page.getByTestId('working-on-lane')).toHaveCount(3);
      break;
  }

  if (situation === 'conflict') {
    const pair = page.getByTestId('compare-pair');
    await expect(pair).toContainText('These two statements may disagree');
    const [firstName, secondName] = conflictSideNames(fx);
    await expect(pair.getByRole('group', { name: firstName }).locator('mark')).toHaveText([/500/, /VAC/]);
    await expect(pair.getByRole('group', { name: secondName }).locator('mark')).toHaveText([/600/, /VDC/]);
    // Where each statement sits: the headings above it in the outline (none when the document has no outline).
    const where = pair.getByTestId('compare-where');
    if (fx.kind === 'docx') {
      await expect(where).toHaveText(['In: Subsystem 1 › Function 1.1', 'In: Subsystem 1 › Function 1.2']);
    } else if (fx.kind === 'spreadsheet') {
      await expect(where).toHaveText(['In: Row R1: input range 1 V', 'In: Row R1: input range 1 V']);
    } else {
      await expect(where).toHaveCount(0);
    }
  } else if (situation === 'duplicate') {
    const pair = page.getByTestId('compare-pair');
    await expect(pair).toContainText('matches an existing work item');
    await expect(pair.getByRole('group', { name: 'Proposed item' })).toBeVisible();
    await expect(pair.getByRole('group', { name: 'Existing work item 1001' }).locator('mark')).toHaveText([/2/]);
  } else {
    await expect(page.getByTestId('compare-pair')).toHaveCount(0);
  }

  if (situation === 'long-wait') {
    await expect(page.getByTestId('long-wait-note')).toContainText('Still working');
    await expect(page.getByRole('alert')).toHaveCount(0);
  } else {
    await expect(page.getByTestId('long-wait-note')).toHaveCount(0);
  }

  if (situation === 'connection-lost') {
    await expect(page.getByRole('alert').filter({ hasText: 'Connection lost' })).toBeVisible();
  } else {
    await expect(page.getByRole('alert').filter({ hasText: 'Connection lost' })).toHaveCount(0);
  }
}

/** The checks every cell passes, whatever the document or situation. */
async function sharedChecks(page: Page, h: Harness, testInfo: TestInfo): Promise<void> {
  // 1. Layout: nothing forces a horizontal scroll.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);

  // 1b. Nothing in the live view shows an internal id (node ids, map refs, store ids).
  const shown = (await page.getByTestId('live-run-panel').textContent()) ?? '';
  expect(shown, 'internal id visible in the live view').not.toMatch(/det\d+_|\bs\d+\.\d+\b|\bg\d+\.\d+\b|ado-\d+/);

  // 2. One bar for one quantity, named, with an honest value text.
  const bars = page.getByRole('progressbar');
  await expect(bars).toHaveCount(1);
  await expect(bars.first()).toHaveAttribute('aria-label', 'Run progress');
  await expect(bars.first()).toHaveAttribute('aria-valuetext', /.+/);

  // 3. Exactly one polite status region for the run, present throughout.
  const region = page.getByTestId('live-status-region');
  await expect(region).toHaveCount(1);
  await expect(region).toHaveAttribute('role', 'status');
  await expect(region).toHaveAttribute('aria-live', 'polite');

  // 4. The outline's rows take no focus; its scrolling region is its one tab stop (so the keyboard can scroll it).
  const outline = page.locator('[data-testid="document-outline"]');
  if (await outline.count()) {
    const selector = 'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])';
    expect(await outline.locator('li').locator(selector).count(), 'focusable things inside outline rows').toBe(0);
    expect(await outline.locator(selector).count(), 'tab stops in the outline').toBe(1);
  }

  // 5. Accessibility scan of the live view and of the bar's own region.
  const results = await new AxeBuilder({ page })
    .include('[data-testid="live-run-panel"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    'axe violations in the live view',
  ).toEqual([]);

  // 6. Keyboard: tabbing never gets stuck, and anything focused in the live view shows focus.
  const visited: { inPanel: boolean; indicator: boolean; label: string }[] = [];
  let last = '';
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { id: 'body', inPanel: false, indicator: true, label: 'body' };
      const style = getComputedStyle(el);
      const indicator = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
      const rect = el.getBoundingClientRect();
      return {
        id: `${el.tagName}|${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 20)}|${Math.round(rect.x)}|${Math.round(rect.y)}`,
        inPanel: !!el.closest('[data-testid="live-run-panel"], [data-testid="working-on-card"]') ||
          /excerpt|percentage is counted/i.test(el.getAttribute('aria-label') ?? ''),
        indicator, label: el.getAttribute('aria-label') ?? el.tagName,
      };
    });
    expect(info.id, `focus stuck on ${info.label}`).not.toBe(last);
    last = info.id;
    visited.push(info);
  }
  for (const stop of visited.filter((v) => v.inPanel)) {
    expect(stop.indicator, `no visible focus on ${stop.label}`).toBe(true);
  }

  // 7a. The projects really are what they say: the media query matches exactly when asked.
  const reduceMatches = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  expect(reduceMatches, 'prefers-reduced-motion matches').toBe(testInfo.project.name.includes('reduced-motion'));

  // 7. Motion: the live view adds no looping animation, and under reduced
  //    motion nothing on the page loops.
  const looping = await page.evaluate(() =>
    document.getAnimations()
      .filter((a) => a.playState === 'running' && (a.effect?.getTiming().iterations ?? 1) === Infinity)
      .map((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target as HTMLElement | null;
        return { inPanel: !!target?.closest('[data-testid="live-run-panel"]'), name: (a as CSSAnimation).animationName ?? '' };
      }),
  );
  expect(looping.filter((a) => a.inPanel), 'looping animation inside the live view').toEqual([]);
  if (testInfo.project.name.includes('reduced-motion')) {
    expect(looping, 'looping animation under reduced motion').toEqual([]);
  }

  // 8. No uncaught page errors.
  expect(h.pageErrors).toEqual([]);
}

for (const kind of DOC_KINDS) {
  test.describe(`${kind}`, () => {
    for (const situation of SITUATIONS) {
      test(`${situation}`, async ({ page }, testInfo) => {
        const fx = fixtureFor(kind);
        const h = await openRunningJob(page, fx);
        await arrange(situation, page, h, fx);
        await collapseRailOnPhone(page, testInfo);
        await expectSituation(situation, page, fx);
        if (testInfo.project.name.startsWith('phone')) {
          // 390px minus the collapsed rail and the banner's own padding leaves about 228px.
          // The rail's width transition takes a moment, so wait for it to settle.
          await expect.poll(async () => (await panel(page).boundingBox())?.width ?? 0, { message: 'live view width on a phone' })
            .toBeGreaterThan(200);
        }
        await sharedChecks(page, h, testInfo);

        // Screenshot baselines of the live view for the situations people look at.
        if (!testInfo.project.name.includes('reduced-motion') && ['smooth', 'parallel', 'conflict'].includes(situation)) {
          await expect(panel(page)).toHaveScreenshot(`${kind}-${situation}.png`);
        }
      });
    }
  });
}

// Situations that are not tied to a document kind.
test.describe('behaviour across the whole run', () => {
  test('the status region announces a change of step at most every 15 seconds and never an item or a number', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx);
    const steps: [string, string, string][] = [
      ['improve', 'items', 'Writing titles and tags'], ['summarize', 'items', 'Summarizing epics and features'],
      ['score', 'requirements', 'Checking requirement wording'], ['link', 'passes', 'Linking related requirements'],
    ];
    let seq = 1;
    for (const [stage, unit] of steps) {
      await h.push([progressEvent(seq, seq * 10, stage, unit, 1, 10), liveEvent(seq + 100, 0, 'item', { ref: fx.refs[seq], title: `Item number ${seq}` })]);
      seq += 1;
      await h.tick(4_000); // steps change faster than the throttle allows
    }
    await h.tick(20_000);
    const said = await h.announcements();
    expect(said.length).toBeGreaterThan(0);
    expect(said.length).toBeLessThanOrEqual(3); // 36 simulated seconds: at most 1 + 36/15
    for (const text of said) {
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain('Item number');
    }
    // It ends on the latest step, not an old one.
    expect(said[said.length - 1]).toBe('Linking related requirements');
  });

  test('a screen reader meets the live view in a sensible order, with names and no internal ids', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx);
    await h.push([...smoothScript(fx), liveEvent(50, 0, 'compare', { compare: conflictFor(fx) })]);
    // The accessibility tree is what a screen reader reads; this checks its content and order.
    const tree = await page.getByTestId('live-run-panel').ariaSnapshot();
    const position = (text: string): number => tree.indexOf(text);
    const order = [
      'words',                              // the document in numbers
      'region "What the model is working on"',
      'region "These two statements may disagree"',
      'region "Document outline, 5 of',
    ];
    const at = order.map(position);
    expect(at.every((i) => i >= 0), `missing from the accessibility tree: ${order.filter((_, i) => at[i] < 0).join(' | ')}`).toBe(true);
    expect(at, 'order in the accessibility tree').toEqual([...at].sort((a, b) => a - b));
    expect(tree).toContain('group "Statement: ');
    expect(tree).toContain('Written: ');
    expect(tree).toContain('Waiting: ');
    expect(tree).not.toMatch(/det\d+_/);
    // The excerpt is not inside the page's one live region, so it is not read out unprompted.
    const live = await page.getByTestId('live-status-region').ariaSnapshot();
    expect(live).not.toContain('Measured at the connector');
  });

  test('with the feature off the banner is exactly the old one: no live view and the block-based estimate', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx, { liveFeature: false });
    await h.push([
      ['narration', {
        type: 'narration', phase: 'analyze_section', branchIndex: 1, branchCount: 4, blocksDone: 100, blocksTotal: 400,
        kbGrounded: false, kbCitations: [], message: 'x',
      }],
    ]);
    await expect(page.getByTestId('live-run-panel')).toHaveCount(0);
    await expect(page.getByText(/of this section \(est\.\)/)).toBeVisible();
    await expect(page.getByText(/of the run/)).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(1);
  });

  test('an unknown event kind from a newer server changes nothing and breaks nothing', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx);
    await h.push([...smoothScript(fx), liveEvent(60, 0, 'telepathy', { ref: fx.refs[1] }), ['brand_new_event', { x: 1 }]]);
    await expect(page.getByTestId('working-on-card')).toBeVisible();
    expect(h.pageErrors).toEqual([]);
  });

  test('the counted percentage replaces the estimate in the one bar and carries its explanation', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx);
    await h.push([progressEvent(1, 38, 'improve', 'items', 12, 36)]);
    await expect(page.getByText('38% of the run (est.) — 12 of 36 items in this step')).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '38');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '38 percent of the run, estimated');
    await expect(page.getByRole('button', { name: 'How the percentage is counted' })).toBeVisible();
  });

  test('a long outline stays a window: only a handful of rows exist however large the map is', async ({ page }) => {
    const fx = fixtureFor('docx');
    const big = {
      ...fx.map,
      totalItems: 4000,
      items: Array.from({ length: 4000 }, (_, i) => ({ ref: `det0_${i}`, title: `Item ${i}`, words: 5, depth: i % 3, type: 'Requirement' })),
    };
    fx.map = big;
    await openRunningJob(page, fx);
    await page.getByTestId('document-outline').waitFor();
    expect(await page.getByTestId('document-outline').getByRole('listitem').count()).toBeLessThan(40);
  });

  test('live events with no document map still show the counted percentage and what is being worked on', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx, { mapAvailable: false });
    await h.push(smoothScript(fx));
    await expect(page.getByTestId('working-on-card')).toBeVisible();
    await expect(page.getByText(/% of the run \(est\.\)/)).toBeVisible();
    await expect(page.getByTestId('document-metrics')).toHaveCount(0);
    await expect(page.getByTestId('document-outline')).toHaveCount(0);
    expect(h.pageErrors).toEqual([]);
  });

  for (const endState of ['failed', 'diff_ready'] as const) {
    test(`when the run ends as ${endState} the live view goes away and the page stays healthy`, async ({ page }) => {
      const fx = fixtureFor('docx');
      const h = await openRunningJob(page, fx);
      await h.push(smoothScript(fx));
      await expect(page.getByTestId('live-run-panel')).toBeVisible();
      h.setJobStatus(endState);
      await h.push([['stage', { stage: endState }]]);
      await expect(page.getByTestId('live-run-panel')).toHaveCount(0);
      await expect(page.getByRole('progressbar', { name: 'Run progress' })).toHaveCount(0);
      // The one stream is closed, and nothing tries to open another.
      await expect.poll(async () => (await h.streams()).open).toBe(0);
      expect((await h.streams()).opened).toBe(1);
      expect(h.pageErrors).toEqual([]);
    });
  }

  test('one event stream per page, however many events arrive and however often the view updates', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx);
    for (let i = 0; i < 6; i++) await h.push(smoothScript(fx, 1 + i * 20));
    expect(await h.streams()).toEqual({ opened: 1, open: 1 });
  });

  test('leaving the page closes its stream', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx);
    await page.getByRole('link', { name: 'Jobs', exact: true }).first().click();
    await expect(page).toHaveURL(/\/jobs$/);
    await expect.poll(async () => (await h.streams()).open).toBe(0);
  });

  test('a hidden tab holds the updates and applies them when it comes back', async ({ page }) => {
    const fx = fixtureFor('docx');
    const h = await openRunningJob(page, fx);
    await h.push([progressEvent(1, 10, 'improve', 'items', 3, 30)]);
    await expect(page.getByText(/10% of the run/).first()).toBeVisible();
    await h.setHidden(true);
    await h.push([progressEvent(2, 57, 'improve', 'items', 17, 30), liveEvent(2, 0, 'working_on', { ref: fx.refs[4] })]);
    await h.tick(5_000);
    await expect(page.getByText(/10% of the run/).first()).toBeVisible(); // nothing applied while hidden
    await expect(page.getByText(/57% of the run/)).toHaveCount(0);
    await h.setHidden(false);
    await expect(page.getByText(/57% of the run/).first()).toBeVisible();
    await expect(page.getByTestId('working-on-card')).toBeVisible();
  });
});

