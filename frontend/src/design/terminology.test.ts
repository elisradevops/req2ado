import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// DESIGN.md §12 (glossary): user-visible text says "Azure DevOps" and "work item", never "ADO" or "WI" as prose, and the write is
// "Write to Azure DevOps", never "Confirm". `WI-12345` is an identifier (mono, §0.1), not prose, so it is allowed. Comments are not
// user-visible and are not checked. Zero tolerance: this started at a count of about 25.
const SRC_DIR = join(__dirname, '..');
const BANNED: Array<[RegExp, string]> = [
  [/(?<![\w-])ADO(?![\w-])/g, '"ADO" (say Azure DevOps)'],
  [/(?<![\w-])WI(?![\w-])/g, '"WI" as prose (say work item; WI-12345 as an id is fine)'],
  [/Confirm and write|before confirming|on Confirm(?![\w])/g, '"Confirm" for the write (say Write to Azure DevOps)'],
];

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes(`${SRC_DIR}/test/`)) out.push(full);
  }
  return out;
}

describe('terminology ratchet (DESIGN.md §12)', () => {
  it('keeps "ADO", "WI" and "Confirm" out of user-visible text', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const [pattern, why] of BANNED) {
        const hits = text.match(pattern) ?? [];
        if (hits.length > 0) offenders.push(`${relative(SRC_DIR, file)}: ${hits.length} x ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('allows identifiers such as WI-12345 and constants such as ADO_BACKEND, and still catches prose', () => {
    expect('Links to WI-436'.match(BANNED[1][0])).toBeNull();
    expect('process.env.ADO_BACKEND'.match(BANNED[0][0])).toBeNull();
    expect('Add direct child WI'.match(BANNED[1][0])).not.toBeNull();
    expect('written to ADO'.match(BANNED[0][0])).not.toBeNull();
  });
});
