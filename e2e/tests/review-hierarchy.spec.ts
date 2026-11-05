import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { HEBREW_TITLE, LONG_TITLE, MIXED_TITLE, type WarningVariant } from '../fixtures/diff-ready';
import { openDiffReadyJob } from '../fixtures/harness';

// The review screen of a finished job (P14: one approval gate, the title shown
// once in the details dialog, first Feature open, two different row signals).
// The project (see playwright.config.ts) supplies the width: 320, 390, 1024, 1440.
// No backend: the API is mocked and the tree is fixtures/diff-ready.ts.

const dialog = (page: Page) => page.getByRole('dialog');
const openDetails = async (page: Page, title: string) => {
  await page.getByRole('button', { name: `Details for ${title}` }).click();
  await dialog(page).waitFor();
  // The dialog scales in; measuring mid-animation reports a tiny box (seen at 320px).
  await dialog(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
};

/** Horizontal overflow of the page itself, in px (0 = none). */
const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * WCAG contrast ratio of an element's text/icon colour against the first
 * opaque background found walking up. Colours go through a canvas so modern
 * colour syntax (oklch, color-mix) resolves to plain RGB.
 */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const rgb = (css: string): [number, number, number, number] => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    const fg = rgb(getComputedStyle(el).color);
    let bg: [number, number, number, number] = [255, 255, 255, 1];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const candidate = rgb(getComputedStyle(node).backgroundColor);
      if (candidate[3] > 0.99) { bg = candidate; break; }
    }
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }, selector);
}

test.describe('approval gate line', () => {
  const cases: [WarningVariant, RegExp | null][] = [
    ['none', null],
    ['one', /^[\d\s]*warning needs your attention before you approve\.$/],
    ['many', /^[\d\s]*warnings need your attention before you approve\.$/],
  ];
  for (const [variant, wording] of cases) {
    test(`${variant} warning(s): ${wording ? 'states the gate once, with matching grammar' : 'no gate line'}`, async ({ page }) => {
      await openDiffReadyJob(page, variant);
      const gate = page.getByTestId('approval-gate');
      if (!wording) {
        await expect(gate).toHaveCount(0);
        return;
      }
      await expect(gate).toHaveCount(1);
      // The count is an animated odometer whose text is every digit column ("0123456789") and exposes no readable value,
      // so only the wording around it is checked; singular vs plural still tells one warning kind from several.
      await expect(gate).toHaveText(wording);
      // The separate banner this line replaced must be gone.
      await expect(page.getByRole('button', { name: 'Go to warnings' })).toHaveCount(0);
    });
  }
});

test.describe('tree defaults', () => {
  test('first Feature with children is open, the next is closed, a childless one has no toggle', async ({ page }) => {
    // The tree is virtualized: a tall viewport (same width) keeps every fixture row mounted.
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 1800 });
    await openDiffReadyJob(page);
    await expect(page.getByRole('button', { name: 'Collapse Core module' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'Expand Power and thermal' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Hidden until the Feature is opened')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /(expand|collapse) childless feature/i })).toHaveCount(0);
  });

  test('flag icon and issue triangle are two different, named signals', async ({ page }) => {
    await openDiffReadyJob(page);
    // Wide rows carry the icons; phone rows use their own narrow marker (unchanged by P14).
    test.skip((page.viewportSize()?.width ?? 0) < 768, 'phone rows use the narrow marker');
    await expect(page.getByRole('img', { name: 'Needs review' }).first()).toBeVisible();
    await expect(page.getByRole('img', { name: /quality issues?/i }).first()).toBeVisible();
  });
});

test.describe('layout at this width', () => {
  test('no horizontal page scroll, header controls stay on screen and never overlap', async ({ page }) => {
    await openDiffReadyJob(page);
    expect(await pageOverflow(page)).toBe(0);

    const names = ['Reject', 'Write to Azure DevOps', 'Download summary', 'Resubmit', 'Delete'];
    const boxes: { name: string; x: number; y: number; w: number; h: number }[] = [];
    for (const name of names) {
      const button = page.getByRole('button', { name }).first();
      if (!(await button.isVisible().catch(() => false))) continue;
      const box = await button.boundingBox();
      if (box) boxes.push({ name, x: box.x, y: box.y, w: box.width, h: box.height });
    }
    const viewportWidth = page.viewportSize()!.width;
    for (const b of boxes) {
      expect(b.x, `${b.name} starts on screen`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, `${b.name} ends on screen`).toBeLessThanOrEqual(viewportWidth + 0.5);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
  });
});

test.describe('details dialog title', () => {
  const cases: [string, string][] = [
    ['long English title', LONG_TITLE],
    ['Hebrew title', HEBREW_TITLE],
    ['mixed Hebrew and Latin title', MIXED_TITLE],
  ];
  for (const [label, title] of cases) {
    test(`${label}: shown once, never collapses to a sliver, no page overflow`, async ({ page }, testInfo) => {
      await openDiffReadyJob(page);
      await openDetails(page, title);

      const header = dialog(page).locator('span[title]', { hasText: title.slice(0, 20) }).first();
      await expect(header).toBeVisible();
      await expect(header).toHaveAttribute('title', title);
      // The bug this guards: a flex item shrinking to a few px wide and thousands of px tall.
      const box = (await header.boundingBox())!;
      expect(box.width, 'title is a readable width').toBeGreaterThan(Math.min(140, page.viewportSize()!.width * 0.4));
      expect(box.height, 'title is not a tall sliver').toBeLessThan(400);
      // Shown once: the header heading carries it, and the body no longer has its own title heading.
      await expect(dialog(page).getByRole('heading', { name: title })).toHaveCount(1);
      await expect(dialog(page).getByRole('heading', { level: 3 })).toHaveCount(0);
      expect(await pageOverflow(page)).toBe(0);

      const shot = await page.screenshot();
      await testInfo.attach(`${label}-${testInfo.project.name}`, { body: shot, contentType: 'image/png' });
      // E2E_SHOTS=<dir> also writes the images there, since a passing test's attachments are not kept.
      if (process.env.E2E_SHOTS) {
        mkdirSync(process.env.E2E_SHOTS, { recursive: true });
        writeFileSync(`${process.env.E2E_SHOTS}/${label.replace(/\s+/g, '-')}-${testInfo.project.name}.png`, shot);
      }
    });
  }

  test('has an accessible name and the Edit button only on an editable item', async ({ page }) => {
    await openDiffReadyJob(page);
    await openDetails(page, 'Flagged only');
    await expect(dialog(page)).toHaveAccessibleName(/flagged only/i);
    await expect(dialog(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(1);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await openDetails(page, 'Already in Azure DevOps');
    await expect(dialog(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  });

  test('Hebrew text direction is reported (a finding, not a gate)', async ({ page }, testInfo) => {
    await openDiffReadyJob(page);
    await openDetails(page, HEBREW_TITLE);
    const info = await dialog(page).locator('span[title]', { hasText: HEBREW_TITLE.slice(0, 8) }).first().evaluate((el) => ({
      dirAttr: el.getAttribute('dir'),
      direction: getComputedStyle(el).direction,
      textAlign: getComputedStyle(el).textAlign,
    }));
    testInfo.annotations.push({ type: 'hebrew-title-direction', description: JSON.stringify(info) });
  });
});

test.describe('contrast of the P14 signals', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`flag icon >= 3:1 and gate line >= 4.5:1 (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openDiffReadyJob(page);
      test.skip((page.viewportSize()?.width ?? 0) < 768, 'the flag icon is a wide-row element');
      expect(await contrastOf(page, '[role="img"][aria-label="Needs review"]')).toBeGreaterThanOrEqual(3);
      expect(await contrastOf(page, '[data-testid="approval-gate"]')).toBeGreaterThanOrEqual(4.5);
    });
  }
});

test.describe('accessibility scan', () => {
  type Results = Awaited<ReturnType<AxeBuilder['analyze']>>;
  const summary = (results: Results) =>
    results.violations.map((v) => `${v.impact} ${v.id} x${v.nodes.length}`);
  const seriousOnly = (results: Results) =>
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length}`);

  test('the warnings card header (where the approval gate now lives) has no serious or critical violations', async ({ page }) => {
    await openDiffReadyJob(page, 'many');
    // Header only: the card's per-warning progress bar has no accessible name (reported below, not part of P14).
    const results = await new AxeBuilder({ page }).include('section[aria-label="Integrity warnings"] > div:first-child').analyze();
    expect(seriousOnly(results)).toEqual([]);
  });

  // Report only: whole-page violations found so far are in parts P14 did not touch
  // (progress bar name, also inside the warnings card, iteration swatch label, tab aria-controls, an unnamed combobox,
  // the "Needs review" filter chip contrast), so they are listed, not gated.
  test('whole page and open dialog: violations are reported, not gated', async ({ page }, testInfo) => {
    await openDiffReadyJob(page, 'many');
    testInfo.annotations.push({ type: 'axe-page', description: JSON.stringify(summary(await new AxeBuilder({ page }).analyze())) });
    await openDetails(page, LONG_TITLE);
    testInfo.annotations.push({ type: 'axe-dialog', description: JSON.stringify(summary(await new AxeBuilder({ page }).analyze())) });
  });
});
