import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Repo-hygiene ratchet, same shape as ./palette.test.ts, for DESIGN.md §14's
// second and third enforcement mechanisms: arbitrary Tailwind values that
// bypass the token scales (type, radius, duration, easing) and the two
// "bare" utilities that silently fall back to Tailwind's own deprecated
// defaults instead of a project token (bare `rounded` -> 4px, never
// overridden by this repo's @theme; bare `transition` -> an implicit,
// unreviewed property list). Zero tolerance would fail on day one and get
// disabled; instead this fails only if a file's banned-pattern count
// INCREASES beyond the recorded baseline, or a brand-new offending file
// appears. Existing debt is expected to burn down over time (DESIGN.md
// Track A, phase A4) -- each cleanup updates BASELINE_COUNTS as a
// deliberate, visible edit, not a silent pass.
const SRC_DIR = join(__dirname, '..');

// Each pattern below corresponds to a DESIGN.md §15 negative constraint.
const BANNED_PATTERNS: RegExp[] = [
  /text-\[\d+(\.\d+)?px\]/g, // §15.3 -- exactly 8 type-scale rungs exist
  /rounded-\[\d+px\]/g, // §15.5 -- exactly 4 radius values exist
  /(?<![\w-])rounded(?![\w-])/g, // §15.5 -- bare `rounded` silently resolves to Tailwind's deprecated 4px fallback, not this repo's radius-sm/md/lg
  /(?<![\w-])transition(?![\w-])/g, // §15.6 -- the property list must always be explicit
  /animate-\[[A-Za-z-]+_\d+ms/g, // §15.4 -- durations must reference var(--duration-*)
  /duration-\[\d+ms\]/g, // §15.4
  /cubic-bezier\(/g, // §15.4 -- easing must reference var(--ease-*)
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'index.css') continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function countBannedPatterns(content: string): number {
  return BANNED_PATTERNS.reduce((sum, pattern) => sum + (content.match(pattern) ?? []).length, 0);
}

// Recorded per-file counts as of the last deliberate check-in. A file NOT
// listed here is assumed to have 0 -- if it's found with any banned
// pattern, that's a NEW offender and fails immediately. To reduce a file's
// debt: replace the arbitrary value with a token from index.css's @theme
// block, then lower this file's count here in the SAME change -- never
// lower it without actually removing the usage.
// The three entries below are false positives from the bare-`transition`
// pattern, not Tailwind utility debt: each is either an inline style
// object's real CSS `transition: 'width 900ms ...'` property (ui/ProgressBar.tsx,
// components/ProgressBanner.tsx's MiniProgress) or the English word
// "transition" inside a code comment (pages/JobDetail.tsx). Recorded here
// rather than refining the regex to exclude them, since a genuinely NEW
// bare-transition class added to any of these three files still pushes
// the count past baseline and fails correctly.
const BASELINE_COUNTS: Record<string, number> = {
  'ui/ProgressBar.tsx': 1,
  'components/ProgressBanner.tsx': 1,
  'pages/JobDetail.tsx': 1,
};

describe('design-token ratchet', () => {
  it('never introduces a new arbitrary-value count above its recorded baseline', () => {
    const offenders: string[] = [];
    for (const fullPath of listSourceFiles(SRC_DIR)) {
      const relPath = relative(SRC_DIR, fullPath).split('\\').join('/');
      const count = countBannedPatterns(readFileSync(fullPath, 'utf8'));
      const baseline = BASELINE_COUNTS[relPath] ?? 0;
      if (count > baseline) {
        offenders.push(
          `${relPath}: ${count} banned pattern(s), baseline is ${baseline}. ` +
            'Use a token from src/index.css (@theme block) instead of an arbitrary ' +
            'text-[Npx]/rounded-[Npx]/duration-[Nms]/cubic-bezier(...)/bare rounded/bare transition — see DESIGN.md §15.',
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not let a baseline count drift without the usages actually being removed', () => {
    const mismatches: string[] = [];
    for (const [relPath, baseline] of Object.entries(BASELINE_COUNTS)) {
      const fullPath = join(SRC_DIR, relPath);
      const count = countBannedPatterns(readFileSync(fullPath, 'utf8'));
      if (count !== baseline) {
        mismatches.push(`${relPath}: recorded baseline ${baseline}, real count is ${count} — update BASELINE_COUNTS`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
