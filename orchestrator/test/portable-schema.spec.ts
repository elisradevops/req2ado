import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { portableSchemaViolations } from '../src/modules/llm/portable-schema';

// The same vectors the ingestion side runs (shared/test-vectors/portable-schema.json): one definition of "portable".
const { vectors } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'shared', 'test-vectors', 'portable-schema.json'), 'utf8')) as {
  vectors: { name: string; schema: Record<string, unknown>; violations: string[] }[];
};

describe('portable strict-schema rules', () => {
  it.each(vectors.map((v) => [v.name, v] as const))('agrees with the shared vector: %s', (_name, vector) => {
    expect(portableSchemaViolations(vector.schema)).toEqual([...vector.violations].sort());
  });
});

import { ROWS_SCHEMA } from '../src/modules/llm/model-health';

describe('schemas the orchestrator itself sends', () => {
  it('the model-health probe schema is portable', () => {
    expect(portableSchemaViolations(ROWS_SCHEMA.schema)).toEqual([]);
  });
});
