import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildWritePreview, type WritePlanEntry } from '../src/modules/pipeline/write-plan';

// shared/schemas/write-preview.schema.json is the contract; buildWritePreview must produce exactly its properties (no more, no fewer).
const schema = JSON.parse(readFileSync(path.resolve(__dirname, '../../shared/schemas/write-preview.schema.json'), 'utf8'));

describe('WritePreview contract', () => {
  const diff: WritePlanEntry[] = [
    { localId: 'e', parentLocalId: null, type: 'Epic', action: 'create', existingAdoId: null },
    { localId: 'r', parentLocalId: 'e', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f1'] },
  ];
  const preview = buildWritePreview(diff, { resumedAdoIdByLocalId: new Map(), alreadyLinkedLocalIds: new Set(), pendingFigureIds: new Set(['f1']) });

  it("the schema's property names equal the keys buildWritePreview returns", () => {
    expect(Object.keys(preview).sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('every schema property is required, so the server always sends the full contract', () => {
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('nested object shapes match too', () => {
    expect(Object.keys(preview.excluded).sort()).toEqual(Object.keys(schema.properties.excluded.properties).sort());
    expect(Object.keys(preview.traceLinks).sort()).toEqual(Object.keys(schema.properties.traceLinks.properties).sort());
  });
});
