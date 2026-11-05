import { computeDeterministicCaveat, parseDocumentOverview } from '../src/modules/pipeline/document-overview.service';
import type { DocumentMapSection } from '../src/modules/pipeline/document-map';

const USER_ID = 'user-1';

function section(blockCount: number): DocumentMapSection {
  return { number: null, title: 'Section', blockCount, figureCount: 0 };
}

describe('computeDeterministicCaveat', () => {
  it('returns null for a small, shallow document', () => {
    const documentMap = Array.from({ length: 6 }, () => section(10));
    expect(computeDeterministicCaveat(6, 2, documentMap)).toBeNull();
  });

  it('returns a caveat when max heading depth is unusually deep', () => {
    const documentMap = Array.from({ length: 6 }, () => section(10));
    expect(computeDeterministicCaveat(6, 5, documentMap)).not.toBeNull();
  });

  it('returns a caveat when the document is large and fragmented (many tiny sections)', () => {
    // Mirrors the real AirPro ICD shape used throughout this feature's
    // design review: 79 sections, most with 0-2 blocks.
    const documentMap = [
      ...Array.from({ length: 50 }, () => section(1)),
      ...Array.from({ length: 29 }, () => section(20)),
    ];
    expect(computeDeterministicCaveat(79, 3, documentMap)).not.toBeNull();
  });

  it('does not fire on a large document that is NOT fragmented', () => {
    const documentMap = Array.from({ length: 40 }, () => section(15));
    expect(computeDeterministicCaveat(40, 3, documentMap)).toBeNull();
  });
});


describe('parseDocumentOverview', () => {
  it('keeps a well-formed overview with its lines and hint', () => {
    expect(parseDocumentOverview(JSON.stringify({ synopsis: 's', caveat: 'c', lines: ['a', 'b'], structureHint: 'hint' }))).toEqual({ synopsis: 's', caveat: 'c', lines: ['a', 'b'], structureHint: 'hint' });
  });

  it('is null for anything that is not an overview, never throwing', () => {
    for (const raw of [undefined, '', '{nope', '[]', '{"caveat":null}', '{"synopsis":5}']) expect(parseDocumentOverview(raw)).toBeNull();
  });

  it('drops lines that are too many, too long or not text, and makes the hint one bounded line', () => {
    expect(parseDocumentOverview(JSON.stringify({ synopsis: 's', lines: Array.from({ length: 41 }, () => 'x') }))).toEqual({ synopsis: 's', caveat: null });
    expect(parseDocumentOverview(JSON.stringify({ synopsis: 's', lines: ['x'.repeat(2001)] }))).toEqual({ synopsis: 's', caveat: null });
    expect(parseDocumentOverview(JSON.stringify({ synopsis: 's', lines: [1] }))).toEqual({ synopsis: 's', caveat: null });
    const hint = parseDocumentOverview(JSON.stringify({ synopsis: 's', structureHint: `a\n\nb${'c'.repeat(2000)}` }))!.structureHint!;
    expect(hint).not.toMatch(/\n/);
    expect(hint.length).toBeLessThanOrEqual(1000);
  });
});

describe('the stored AI summary', () => {
  it('is kept as one bounded paragraph, and is optional', () => {
    const out = parseDocumentOverview(JSON.stringify({ synopsis: 's', aiSummary: `First.\n\nSecond.${'x'.repeat(2000)}` }))!;
    expect(out.aiSummary).not.toMatch(/\n/);
    expect(Array.from(out.aiSummary!).length).toBeLessThanOrEqual(1500);
    expect(parseDocumentOverview(JSON.stringify({ synopsis: 's' }))).not.toHaveProperty('aiSummary');
    expect(parseDocumentOverview(JSON.stringify({ synopsis: 's', aiSummary: 5 }))).not.toHaveProperty('aiSummary');
  });
});

describe('the overview contract bounds', () => {
  it('cuts a synopsis and a caveat to the schema bound, in code points', () => {
    const out = parseDocumentOverview(JSON.stringify({ synopsis: '😀'.repeat(9000), caveat: 'c'.repeat(2000) }))!;
    expect(Array.from(out.synopsis)).toHaveLength(8000);
    expect(out.caveat).toHaveLength(1000);
  });

  it('counts a line in code points, as the schema does, so a long emoji line is not dropped', () => {
    expect(parseDocumentOverview(JSON.stringify({ synopsis: 's', lines: ['😀'.repeat(1500)] }))!.lines).toHaveLength(1);
  });
});

describe('the overview contract', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const schema = require('../../shared/schemas/document-overview.schema.json');

  it('the parser accepts exactly what the shared schema describes, with the same bounds', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(['aiSummary', 'caveat', 'lines', 'structureHint', 'synopsis']);
    const full = parseDocumentOverview(JSON.stringify({ synopsis: 's', caveat: 'c', lines: Array.from({ length: schema.properties.lines.maxItems }, () => 'x'.repeat(schema.properties.lines.items.maxLength)), structureHint: 'h'.repeat(schema.properties.structureHint.maxLength) }))!;
    expect(full.lines).toHaveLength(schema.properties.lines.maxItems);
    expect(full.structureHint).toHaveLength(schema.properties.structureHint.maxLength);
    expect(parseDocumentOverview(JSON.stringify({ synopsis: 's', lines: Array.from({ length: schema.properties.lines.maxItems + 1 }, () => 'x') }))!.lines).toBeUndefined();
  });
});
