import { buildDocumentMap } from '../src/modules/pipeline/document-map';

describe('buildDocumentMap', () => {
  it('starts a new section on every heading block, attributing content up to (not including) the next heading', () => {
    const sections = buildDocumentMap([
      { kind: 'heading', number_label: '1', text: 'Introduction' } as any,
      { kind: 'paragraph' } as any,
      { kind: 'paragraph' } as any,
      { kind: 'heading', number_label: '2', text: 'Requirements' } as any,
      { kind: 'paragraph' } as any,
    ]);

    expect(sections).toEqual([
      { number: '1', title: 'Introduction', blockCount: 3, figureCount: 0 },
      { number: '2', title: 'Requirements', blockCount: 2, figureCount: 0 },
    ]);
  });

  it('counts figure blocks within a section, not just the aggregate figures array', () => {
    const sections = buildDocumentMap([
      { kind: 'heading', number_label: '1', text: 'Diagrams' } as any,
      { kind: 'figure' } as any,
      { kind: 'figure' } as any,
      { kind: 'paragraph' } as any,
    ]);

    expect(sections).toEqual([{ number: '1', title: 'Diagrams', blockCount: 4, figureCount: 2 }]);
  });

  it('starts every heading as its own section, not just top-level ones -- matches preview()\'s own sectionCount', () => {
    const sections = buildDocumentMap([
      { kind: 'heading', heading_level: 1, number_label: '1', text: 'A' } as any,
      { kind: 'heading', heading_level: 2, number_label: '1.1', text: 'A.1' } as any,
      { kind: 'paragraph' } as any,
    ]);

    expect(sections).toHaveLength(2);
    expect(sections[1]).toEqual({ number: '1.1', title: 'A.1', blockCount: 2, figureCount: 0 });
  });

  it('drops content before the first heading rather than attributing it to a section that does not exist', () => {
    const sections = buildDocumentMap([
      { kind: 'paragraph' } as any,
      { kind: 'heading', number_label: '1', text: 'Introduction' } as any,
      { kind: 'paragraph' } as any,
    ]);

    expect(sections).toEqual([{ number: '1', title: 'Introduction', blockCount: 2, figureCount: 0 }]);
  });

  it('returns null for a heading with no number_label, rather than a fabricated one', () => {
    const sections = buildDocumentMap([{ kind: 'heading', text: 'Unnumbered Preface' } as any]);
    expect(sections[0].number).toBeNull();
  });

  it('returns an empty array for a document with no headings at all', () => {
    expect(buildDocumentMap([{ kind: 'paragraph' } as any])).toEqual([]);
  });

  it('returns an empty array for an empty document', () => {
    expect(buildDocumentMap([])).toEqual([]);
  });
});
