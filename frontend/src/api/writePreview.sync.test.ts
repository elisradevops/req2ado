import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WritePreview } from './jobs';

// The frontend cannot import the generated shared types, so WritePreview in jobs.ts is kept by hand. This reads the real schema and
// fails when a field is added or removed on one side only.
const schema = JSON.parse(
  readFileSync(join(__dirname, '../../../shared/schemas/write-preview.schema.json'), 'utf-8'),
) as { properties: Record<string, unknown>; required: string[] };

// Every property filled in. `satisfies` fails type-checking when the interface gains or loses a key.
const FULL = {
  createdTotal: 0,
  createdLocalIds: [],
  createdByType: {},
  excluded: { direct: 0, viaAncestor: 0 },
  parentLinks: 0,
  existingGettingChildren: 0,
  existingWithoutNewParentLink: 0,
  traceLinks: { planned: 0, skipped: 0 },
  alreadyWritten: 0,
  figuresToAttach: 0,
  figuresUnavailable: 0,
  hasWork: false,
  figuresOnly: false,
} satisfies Record<keyof WritePreview, unknown>;

const sameKeys = (a: string[], b: string[]): boolean => a.length === b.length && a.every((key) => b.includes(key));

describe('shared/schemas/write-preview.schema.json <-> frontend/src/api/jobs.ts WritePreview', () => {
  it('property keys match', () => {
    expect(sameKeys(Object.keys(schema.properties), Object.keys(FULL))).toBe(true);
  });

  it('every property is required', () => {
    expect(sameKeys(schema.required, Object.keys(schema.properties))).toBe(true);
  });

  it('the sync test fails when a key is missing', () => {
    const keys = Object.keys(FULL);
    expect(sameKeys(Object.keys(schema.properties), keys.slice(1))).toBe(false);
    expect(sameKeys(Object.keys(schema.properties), [...keys, 'extra'])).toBe(false);
  });
});
