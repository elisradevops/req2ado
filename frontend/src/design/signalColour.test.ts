import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// DESIGN.md §0 item 2 and §16.7: exactly one colour means "this cannot be undone", and it appears on exactly one element
// class: the confirm-to-Azure-DevOps control (the `cta` Button variant). Anywhere else, a reader would habituate to it and
// stop reading it as a warning. Zero tolerance, no baseline: a search highlight once used it and nothing caught that.
const SRC_DIR = join(__dirname, '..');
const SIGNAL_UTILITY = /(?<![\w-])(?:[\w:[\]-]+:)?(?:bg|text|border|ring|outline|shadow|fill|stroke|from|to|via|decoration|divide|accent|caret)-signal(?:-[a-z]+)?(?![\w-])/g;
// The raw custom property and arbitrary-value forms bypass the utility names above.
const SIGNAL_RAW = /--color-signal|bg-\[#fde134\]|\[var\(--color-signal/g;
// The one place that may spell it out: the Button's `cta` variant (its hover and shadow tokens are named after it).
const ALLOWED = new Set(['ui/Button.tsx']);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'index.css') out.push(full);
  }
  return out;
}

describe('signal colour ratchet (DESIGN.md §16.7)', () => {
  it('appears only in the cta Button variant', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const rel = relative(SRC_DIR, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      const hits = [...(text.match(SIGNAL_UTILITY) ?? []), ...(text.match(SIGNAL_RAW) ?? [])];
      if (hits.length > 0) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('also catches the raw custom property and arbitrary-value forms', () => {
    expect('className="bg-[var(--color-signal)]"'.match(SIGNAL_RAW)).not.toBeNull();
    expect('style={{ color: "var(--color-signal)" }}'.match(SIGNAL_RAW)).not.toBeNull();
    expect('className="bg-accent-soft"'.match(SIGNAL_RAW)).toBeNull();
  });

  it('would catch the offence it exists for', () => {
    expect('<mark className="rounded-sm bg-signal px-0 text-signal-ink">'.match(SIGNAL_UTILITY)).toEqual(['bg-signal', 'text-signal-ink']);
    expect('className="hover:bg-signal-hover"'.match(SIGNAL_UTILITY)).toEqual(['hover:bg-signal-hover']);
  });
});
