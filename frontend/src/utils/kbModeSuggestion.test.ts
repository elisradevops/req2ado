import { describe, expect, it } from 'vitest';
import { LARGE_FILE_WARNING_BYTES, suggestRetrievalMode } from './kbModeSuggestion';

const MB = 1024 * 1024;

describe('suggestRetrievalMode', () => {
  it.each([
    'Requirements_Writing_Standard.pdf',
    'HowToWriteRequirements.pptx',
    'Principles_of_Writing_Software_Requirements.pptx',
    'CMMI style guide.docx',
    'Review checklist.xlsx',
    'Naming conventions.md',
    'Glossary.docx',
    'Document template.dotx',
    'Security policy.pdf',
  ])('suggests Reference for a guide-like name: %s', (name) => {
    expect(suggestRetrievalMode(name, 200 * 1024)).toEqual({ mode: 'always_include', reason: 'the name looks like a guide or standard' });
  });

  it.each(['מדריך כתיבת דרישות.docx', 'הנחיות עבודה.pdf', 'תקן תוכנה.pptx'])('recognises Hebrew guide words: %s', (name) => {
    expect(suggestRetrievalMode(name, 200 * 1024)?.mode).toBe('always_include');
  });

  it.each(['Customer_SRS_v3.docx', 'ICD_CubeADCS.pdf', 'Meeting notes.docx', 'דרישות לקוח.docx'])('suggests nothing for a name that is not guide-like: %s', (name) => {
    expect(suggestRetrievalMode(name, 200 * 1024)).toBeNull();
  });

  it('does not let a large file size alone block the suggestion: a deck is mostly images', () => {
    expect(suggestRetrievalMode('HowToWriteRequirements.pptx', 6 * MB)?.mode).toBe('always_include');
  });

  it('suggests nothing for a very large file, whatever its name', () => {
    expect(suggestRetrievalMode('Requirements_Writing_Standard.pdf', 11 * MB)).toBeNull();
  });

  it('warns about a large file from 5 MB', () => {
    expect(LARGE_FILE_WARNING_BYTES).toBe(5 * MB);
  });

  it('is case-insensitive', () => {
    expect(suggestRetrievalMode('STYLE GUIDE.PDF', 1024)?.mode).toBe('always_include');
  });
});
