import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Repo-hygiene ratchet, not a wall -- there is real, pre-existing hex-color
// debt in this codebase (chrome that duplicates or should have a design
// token, per index.css's own token comment: "identifiers get a distinct
// face... never hardcode these in components beyond this token"). Zero
// tolerance would fail on day one and get disabled; instead this fails only
// if a file's hex-literal count INCREASES beyond the recorded baseline, or a
// brand-new offending file appears. Existing debt is expected to burn down
// over time -- each cleanup updates BASELINE_HEX_COUNTS as a deliberate,
// visible edit, not a silent pass.
const SRC_DIR = join(__dirname, '..');
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}/g;

// Legitimate categorical DATA palettes, not chrome -- excluded entirely from
// counting (not just baselined at their current count): a semantic tag/type/
// file-extension color mapping is real content the palette conveys, not
// polish that duplicates a design token. Each is documented at its own
// definition site too.
const ALLOWLISTED_FILES = new Set([
  'utils/tagColors.ts', // 11 requirement-tag colors, no equivalent token exists
  'components/WorkItemTypeBadge.tsx', // Azure DevOps' OWN official work-item-type colors + an rgba() alpha-compositing helper for live ADO-fetched colors, not hardcoded chrome
  'components/FileTypeIcon.tsx', // per-file-extension icon colors (docx/pdf/xlsx/etc.), same genre as tagColors
]);

// Recorded per-file hex-literal counts as of the last deliberate check-in.
// A file NOT listed here is assumed to have 0 -- if it's found with any hex
// literal, that's a NEW offender and fails immediately. To reduce a file's
// debt: replace the hex literal(s) with a token from index.css's @theme
// block (adding a new token there first if none fits), then lower this
// file's count here in the SAME change -- never lower it without actually
// removing the literals, and never raise it to make a new violation pass.
const BASELINE_HEX_COUNTS: Record<string, number> = {
  'components/SharePointFolderTree.tsx': 2,
  'components/TraceLinkChips.tsx': 1,
  'components/ActionBadge.tsx': 4,
  'components/TagChips.tsx': 1,
  'components/IssueChips.tsx': 2,
};

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

function countHexLiterals(content: string): number {
  return (content.match(HEX_PATTERN) ?? []).length;
}

describe('hex-color ratchet', () => {
  it('never introduces a new hex-literal count above its recorded baseline', () => {
    const offenders: string[] = [];
    for (const fullPath of listSourceFiles(SRC_DIR)) {
      const relPath = relative(SRC_DIR, fullPath).split('\\').join('/');
      if (ALLOWLISTED_FILES.has(relPath)) continue;
      const count = countHexLiterals(readFileSync(fullPath, 'utf8'));
      const baseline = BASELINE_HEX_COUNTS[relPath] ?? 0;
      if (count > baseline) {
        offenders.push(
          `${relPath}: ${count} hex literal(s), baseline is ${baseline}. ` +
            'Move new colors to a token in src/index.css (@theme block) and reference it as var(--color-…) ' +
            'instead of a raw hex — see ActionBadge.tsx/WorkItemTypeBadge.tsx for the existing token pattern.',
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not let a baseline count drift without the literals actually being removed', () => {
    // Guards the baseline itself: lowering a count here without removing the
    // matching hex literals would silently mask real debt. Every recorded
    // baseline must still match the file's REAL current count exactly (not
    // just be <=) -- a mismatch means BASELINE_HEX_COUNTS is stale in either
    // direction and must be updated in the same change as whatever touched
    // the file.
    const mismatches: string[] = [];
    for (const [relPath, baseline] of Object.entries(BASELINE_HEX_COUNTS)) {
      const fullPath = join(SRC_DIR, relPath);
      const count = countHexLiterals(readFileSync(fullPath, 'utf8'));
      if (count !== baseline) {
        mismatches.push(`${relPath}: recorded baseline ${baseline}, real count is ${count} — update BASELINE_HEX_COUNTS`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
