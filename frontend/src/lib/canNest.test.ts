import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canNest, canBeRoot } from './canNest';

// Mechanical drift guard for the intentional duplication documented in this
// file's own header comment: canNest.ts is duplicated (not imported) between
// orchestrator and frontend because they are separate deployables with no
// shared runtime package today. A duplicated-but-undocumented convention
// already drifted silently once in this repo (see DESIGN.md's migration
// ledger note on jobs.service.ts's needsReview() comment pointing at a
// frontend file that no longer exists) -- this test is the guard that
// convention lacked. It extracts just the two function bodies (not the full
// file, whose header comments differ by design -- each points at the
// other's path) and asserts they are byte-identical.
const ORCHESTRATOR_PATH = join(__dirname, '../../../orchestrator/src/modules/pipeline/canNest.ts');

function extractFunctionBody(source: string, name: string): string {
  const startPattern = new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{`);
  const match = startPattern.exec(source);
  if (!match) throw new Error(`Could not find function '${name}' in source`);
  const start = match.index;
  let depth = 0;
  let i = start;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return source.slice(start, i);
}

describe('canNest drift guard', () => {
  it('keeps this file byte-identical (function bodies) to the orchestrator copy', () => {
    const orchestratorSource = readFileSync(ORCHESTRATOR_PATH, 'utf-8');
    const frontendSource = readFileSync(join(__dirname, 'canNest.ts'), 'utf-8');

    for (const name of ['canNest', 'canBeRoot']) {
      const orchestratorBody = extractFunctionBody(orchestratorSource, name);
      const frontendBody = extractFunctionBody(frontendSource, name);
      expect(frontendBody, `${name} has drifted from orchestrator's copy`).toBe(orchestratorBody);
    }
  });
});

describe('canNest', () => {
  it('allows advancing exactly one tier', () => {
    expect(canNest('Feature', 'Epic')).toBe(true);
    expect(canNest('Requirement', 'Feature')).toBe(true);
  });

  it('allows repeating the parent tier', () => {
    expect(canNest('Epic', 'Epic')).toBe(true);
    expect(canNest('Feature', 'Feature')).toBe(true);
    expect(canNest('Requirement', 'Requirement')).toBe(true);
  });

  it('rejects skipping a tier', () => {
    expect(canNest('Requirement', 'Epic')).toBe(false);
  });

  it('rejects moving backward', () => {
    expect(canNest('Epic', 'Feature')).toBe(false);
    expect(canNest('Feature', 'Requirement')).toBe(false);
  });

  it('rejects an unrecognized parent category', () => {
    expect(canNest('Requirement', 'Bogus')).toBe(false);
  });
});

describe('canBeRoot', () => {
  it('an Epic is always a valid root', () => {
    expect(canBeRoot('Epic', true)).toBe(true);
    expect(canBeRoot('Epic', false)).toBe(true);
  });

  it('a Feature is root-valid only when no Epic exists', () => {
    expect(canBeRoot('Feature', false)).toBe(true);
    expect(canBeRoot('Feature', true)).toBe(false);
  });

  it('a Requirement is never root-valid', () => {
    expect(canBeRoot('Requirement', false)).toBe(false);
    expect(canBeRoot('Requirement', true)).toBe(false);
  });
});
