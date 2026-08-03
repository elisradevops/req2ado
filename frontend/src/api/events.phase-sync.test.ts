import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INGESTION_NARRATION_PHASES } from './events';

// A REAL cross-file guardrail, not two hand-copied lists trusted to stay in
// sync on their own -- reads ingestion's actual narration_publisher.py
// source and extracts its `Phase` Literal's string values, then asserts
// they're the exact same set INGESTION_NARRATION_PHASES declares in
// events.ts. This is the guardrail for the exact bug class that caused this
// session's own detect_conflicts/regroup_roots stepper regression: a phase
// added to ingestion's Phase Literal with no matching update on the
// frontend previously failed silently at runtime; this fails loudly here
// instead, at test time, with a message pointing at both files to fix.
function readIngestionPhaseLiteral(): string[] {
  const path = join(__dirname, '../../../ingestion/app/leveling/narration_publisher.py');
  const source = readFileSync(path, 'utf-8');
  const literalMatch = source.match(/Phase = Literal\[([\s\S]*?)\]/);
  if (!literalMatch) {
    throw new Error(`Could not find "Phase = Literal[...]" in ${path} -- did narration_publisher.py change shape?`);
  }
  return [...literalMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe('ingestion <-> frontend narration phase sync', () => {
  it('INGESTION_NARRATION_PHASES (events.ts) matches narration_publisher.py Phase Literal exactly', () => {
    const ingestionPhases = readIngestionPhaseLiteral();

    expect(ingestionPhases.length).toBeGreaterThan(0); // sanity: the regex above actually matched something real

    const frontendSet = new Set(INGESTION_NARRATION_PHASES);
    const ingestionSet = new Set(ingestionPhases);

    const missingFromFrontend = ingestionPhases.filter((p) => !frontendSet.has(p));
    const extraOnFrontend = INGESTION_NARRATION_PHASES.filter((p) => !ingestionSet.has(p));

    expect(
      missingFromFrontend,
      `ingestion/app/leveling/narration_publisher.py's Phase Literal has phase(s) missing from ` +
        `INGESTION_NARRATION_PHASES in frontend/src/api/events.ts -- add them to BOTH events.ts's ` +
        `INGESTION_NARRATION_PHASES/NarrationEvent['phase'] union AND wherever the frontend needs to react to them.`,
    ).toEqual([]);
    expect(
      extraOnFrontend,
      `frontend/src/api/events.ts's INGESTION_NARRATION_PHASES has phase(s) not present in ingestion's own ` +
        `Phase Literal -- remove them, or confirm narration_publisher.py just hasn't been updated yet.`,
    ).toEqual([]);
  });
});
