import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqualBearer } from '../src/auth/timingSafeEqualBearer';

// Mechanical drift guard for the intentional duplication documented in this
// function's own header comment: timingSafeEqualBearer is duplicated (not
// imported) between mcp-ado-server and orchestrator because they are
// separate deployables with no shared runtime TS package today. Mirrors
// frontend/src/lib/canNest.test.ts's own drift-guard pattern exactly.
const ORCHESTRATOR_PATH = join(__dirname, '../../orchestrator/src/modules/llm/timing-safe-equal-bearer.ts');

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

describe('timingSafeEqualBearer drift guard', () => {
  it('keeps this file byte-identical (function body) to the orchestrator copy', () => {
    const orchestratorSource = readFileSync(ORCHESTRATOR_PATH, 'utf-8');
    const ownSource = readFileSync(join(__dirname, '../src/auth/timingSafeEqualBearer.ts'), 'utf-8');

    const orchestratorBody = extractFunctionBody(orchestratorSource, 'timingSafeEqualBearer');
    const ownBody = extractFunctionBody(ownSource, 'timingSafeEqualBearer');
    expect(ownBody, 'timingSafeEqualBearer has drifted from orchestrator\'s copy').toBe(orchestratorBody);
  });
});

describe('timingSafeEqualBearer', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualBearer('a-real-token', 'a-real-token')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeEqualBearer('a-real-token', 'a-fake-token')).toBe(false);
  });

  it('returns false, not throw, for strings of different lengths', () => {
    expect(timingSafeEqualBearer('short', 'a-much-longer-token')).toBe(false);
  });

  it('returns false for an empty actual against a non-empty expected', () => {
    expect(timingSafeEqualBearer('', 'a-real-token')).toBe(false);
  });
});
