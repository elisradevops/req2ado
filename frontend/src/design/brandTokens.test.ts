import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// DESIGN.md §2 (brand colours): the two brand colours exist for the non-interactive brand panel of the sign-in page and nowhere else.
// They must never colour a control, a status, a chip or a focus ring, and signal yellow keeps meaning "irreversible write". The
// mechanical guard: no file other than the sign-in page (and the stylesheet that defines them) may mention them.

const SRC = join(__dirname, '..');
const ALLOWED = new Set(['index.css', join('pages', 'Login.tsx'), join('pages', 'Login.test.tsx'), join('design', 'brandTokens.test.ts')]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('brand colours', () => {
  it('are used only by the sign-in page', () => {
    const offenders = walk(SRC)
      .filter((file) => /\.(tsx?|css)$/.test(file))
      .filter((file) => !ALLOWED.has(relative(SRC, file)))
      .filter((file) => /brand-(blue|yellow)/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  it('are defined, once, in the stylesheet', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');

    expect(css).toMatch(/--color-brand-blue:\s*#1b4a8f;/i);
    expect(css).toMatch(/--color-brand-yellow:\s*#fde134;/i);
  });
});
