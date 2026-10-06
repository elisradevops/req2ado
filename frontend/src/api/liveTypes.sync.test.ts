import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPARE_KINDS,
  IN_FLIGHT_KINDS,
  LIVE_KINDS,
  NOTICE_KINDS,
  NOTICE_SEVERITIES,
  PROGRESS_UNITS,
  STAGE_NAMES,
} from './liveTypes';

// The frontend cannot import the generated shared types (its image builds from
// ./frontend alone), so liveTypes.ts is kept by hand. This reads the real schema
// and fails, naming both files, when a stage, unit or kind drifts.
const schema = JSON.parse(
  readFileSync(join(__dirname, '../../../shared/schemas/job-live.schema.json'), 'utf-8'),
) as { definitions: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[]; items?: unknown }> }> };

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value) => b.includes(value));

describe('shared/schemas/job-live.schema.json <-> frontend/src/api/liveTypes.ts', () => {
  it('stage names match', () => {
    expect(sameSet(STAGE_NAMES, schema.definitions.StageName.enum ?? [])).toBe(true);
  });

  it('progress units match', () => {
    expect(sameSet(PROGRESS_UNITS, schema.definitions.ProgressEvent.properties?.unit.enum ?? [])).toBe(true);
    expect(sameSet(PROGRESS_UNITS, schema.definitions.StageUnits.properties?.unit.enum ?? [])).toBe(true);
  });

  it('live frame kinds match', () => {
    expect(sameSet(LIVE_KINDS, schema.definitions.LiveFrame.properties?.kind.enum ?? [])).toBe(true);
  });

  it('compare kinds match', () => {
    expect(sameSet(COMPARE_KINDS, schema.definitions.ComparePayload.properties?.kind.enum ?? [])).toBe(true);
  });

  it('notice kinds and severities match', () => {
    expect(sameSet(NOTICE_KINDS, schema.definitions.Notice.properties?.kind.enum ?? [])).toBe(true);
    expect(sameSet(NOTICE_SEVERITIES, schema.definitions.Notice.properties?.severity.enum ?? [])).toBe(true);
  });

  it('in-flight kinds in a heartbeat match', () => {
    const items = schema.definitions.Heartbeat.properties?.inFlight.items as {
      properties: { kind: { enum: string[] } };
    };
    expect(sameSet(IN_FLIGHT_KINDS, items.properties.kind.enum)).toBe(true);
  });
});
