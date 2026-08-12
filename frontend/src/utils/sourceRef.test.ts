import { describe, it, expect } from 'vitest';
import { basenameOf, sourceRefRows } from './sourceRef';

describe('basenameOf', () => {
  it('strips a posix-style path down to just the filename', () => {
    expect(basenameOf('folder/spec.docx')).toBe('spec.docx');
  });

  it('strips a Windows-style path down to just the filename', () => {
    expect(basenameOf('C:\\docs\\spec.docx')).toBe('spec.docx');
  });

  it('returns the input unchanged when it has no path separators', () => {
    expect(basenameOf('spec.docx')).toBe('spec.docx');
  });
});

describe('sourceRefRows', () => {
  const base = { documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: null as number | null };

  it('returns no rows when neither sectionPath nor page is present', () => {
    expect(sourceRefRows(base)).toEqual([]);
  });

  it('returns only a Section row when sectionPath is present and page is null', () => {
    const rows = sourceRefRows({ ...base, sectionPath: ['3 Power', '3.2 Backplane'] });
    expect(rows).toEqual([{ label: 'Section', value: '3 Power > 3.2 Backplane' }]);
  });

  it('returns only a Page row when page is present and sectionPath is empty', () => {
    const rows = sourceRefRows({ ...base, page: 12 });
    expect(rows).toEqual([{ label: 'Page', value: '12' }]);
  });

  it('returns Section then Page, in that order, when both are present', () => {
    const rows = sourceRefRows({ ...base, page: 12, sectionPath: ['3 Power'] });
    expect(rows).toEqual([
      { label: 'Section', value: '3 Power' },
      { label: 'Page', value: '12' },
    ]);
  });

  it('never emits a Section row for an empty sectionPath array', () => {
    const rows = sourceRefRows({ ...base, page: 12, sectionPath: [] });
    expect(rows).toEqual([{ label: 'Page', value: '12' }]);
  });

  it('renders a page RANGE with label "Pages" when pageEnd is strictly after page', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: 14 });
    expect(rows).toEqual([{ label: 'Pages', value: '12-14' }]);
  });

  it('keeps the singular "Page" label when pageEnd equals page', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: 12 });
    expect(rows).toEqual([{ label: 'Page', value: '12' }]);
  });

  it('keeps the singular "Page" label when pageEnd is null', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: null });
    expect(rows).toEqual([{ label: 'Page', value: '12' }]);
  });

  it('appends an "(approx.)" qualifier to a single page when pageProvenance is non-null', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageProvenance: 'rendered' });
    expect(rows).toEqual([{ label: 'Page', value: '12 (approx.)' }]);
  });

  it('appends "(approx.)" to a page RANGE too, and never exposes the raw provenance string', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: 14, pageProvenance: 'interpolated' });
    expect(rows).toEqual([{ label: 'Pages', value: '12-14 (approx.)' }]);
    expect(rows[0].value).not.toContain('interpolated');
  });

  it('uses the "Slide" label for a .pptx source, singular', () => {
    const rows = sourceRefRows({ ...base, documentPath: 'deck.pptx', page: 4 });
    expect(rows).toEqual([{ label: 'Slide', value: '4' }]);
  });

  it('uses the "Slides" label for a .pptx source RANGE', () => {
    const rows = sourceRefRows({ ...base, documentPath: 'deck.pptx', page: 4, pageEnd: 6 });
    expect(rows).toEqual([{ label: 'Slides', value: '4-6' }]);
  });

  it('matches .pptx case-insensitively and against a full path, not just a bare filename', () => {
    const rows = sourceRefRows({ ...base, documentPath: 'C:\\Decks\\Review.PPTX', page: 1 });
    expect(rows).toEqual([{ label: 'Slide', value: '1' }]);
  });

  it('never renders startOffset/endOffset in any row', () => {
    const rows = sourceRefRows({ ...base, page: 12, sectionPath: ['3 Power'], startOffset: 9182, endOffset: 9196 });
    const joined = rows.map((r) => r.value).join(' ');
    expect(joined).not.toContain('9182');
    expect(joined).not.toContain('9196');
    expect(joined).not.toContain('chars');
  });

  it('never renders § or › or an en dash in any row', () => {
    const rows = sourceRefRows({ ...base, page: 12, pageEnd: 14, sectionPath: ['3 Power', '3.2 Backplane'] });
    const joined = rows.map((r) => `${r.label} ${r.value}`).join(' ');
    expect(joined).not.toContain('§');
    expect(joined).not.toContain('›');
    expect(joined).not.toContain('\u2013'); // en dash
  });
});
