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
});
