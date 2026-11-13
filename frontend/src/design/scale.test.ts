import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// DESIGN.md §4/§5: type sizes and radii come from the token scale (text-micro..text-metric, rounded-sm/md/lg). Tailwind's default
// text-lg/xl/2xl/3xl and rounded-xl/2xl are off-scale. Zero tolerance.
const SRC_DIR = join(__dirname, '..');
const OFF_SCALE = /(?<![\w-])(text-(lg|xl|2xl|3xl|4xl)|rounded-(xl|2xl|3xl))(?![\w-])/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) return files(f);
    return /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [f] : [];
  });
}

describe('type and radius scale ratchet', () => {
  it('uses no off-scale text size or radius utilities', () => {
    const offenders = files(SRC_DIR).flatMap((f) => {
      const hits = readFileSync(f, 'utf8').match(OFF_SCALE) ?? [];
      return hits.length ? [`${relative(SRC_DIR, f)}: ${[...new Set(hits)].join(', ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });
});
