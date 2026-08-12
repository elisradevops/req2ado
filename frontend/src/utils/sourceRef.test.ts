import { describe, it, expect } from 'vitest';
import { formatSourceRef } from './sourceRef';

describe('formatSourceRef', () => {
  it('formats filename, page, and char range when page is present', () => {
    const result = formatSourceRef({ documentPath: 'folder/spec.docx', startOffset: 3400, endOffset: 3820, page: 12 });
    expect(result).toBe('spec.docx · p. 12 · chars 3400–3820');
  });

  it('omits the page segment when page is null', () => {
    const result = formatSourceRef({ documentPath: 'spec.txt', startOffset: 0, endOffset: 10, page: null });
    expect(result).toBe('spec.txt · chars 0–10');
  });

  it('strips a Windows-style path down to just the filename', () => {
    const result = formatSourceRef({ documentPath: 'C:\\docs\\spec.docx', startOffset: 0, endOffset: 10, page: null });
    expect(result).toBe('spec.docx · chars 0–10');
  });

  it('renders the section path with a § prefix, joined by ›, when present', () => {
    const result = formatSourceRef({
      documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 12,
      sectionPath: ['3 Power', '3.2 Backplane'],
    });
    expect(result).toBe('spec.docx · § 3 Power › 3.2 Backplane · p. 12 · chars 0–10');
  });

  it('omits the section segment when sectionPath is empty', () => {
    const result = formatSourceRef({ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 12, sectionPath: [] });
    expect(result).toBe('spec.docx · p. 12 · chars 0–10');
  });

  it('renders a page range when pageEnd is strictly after page', () => {
    const result = formatSourceRef({ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 12, pageEnd: 14 });
    expect(result).toBe('spec.docx · pp. 12–14 · chars 0–10');
  });

  it('renders a single page (not a range) when pageEnd equals page', () => {
    const result = formatSourceRef({ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 12, pageEnd: 12 });
    expect(result).toBe('spec.docx · p. 12 · chars 0–10');
  });

  it('appends an "(approx.)" qualifier to the page segment when pageProvenance is non-null, without exposing the raw provenance value', () => {
    const result = formatSourceRef({ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 12, pageProvenance: 'rendered' });
    expect(result).toBe('spec.docx · p. 12 (approx.) · chars 0–10');
    expect(result).not.toContain('rendered');
  });

  it('appends the same "(approx.)" qualifier to a page RANGE too, for "interpolated" provenance', () => {
    const result = formatSourceRef({
      documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 12, pageEnd: 14, pageProvenance: 'interpolated',
    });
    expect(result).toBe('spec.docx · pp. 12–14 (approx.) · chars 0–10');
  });

  it('shows no "(approx.)" qualifier when pageProvenance is null', () => {
    const result = formatSourceRef({ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 12, pageProvenance: null });
    expect(result).toBe('spec.docx · p. 12 · chars 0–10');
  });
});
