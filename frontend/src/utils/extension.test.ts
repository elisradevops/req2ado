import { describe, it, expect } from 'vitest';
import { extensionOf } from './extension';

describe('extensionOf', () => {
  it('returns the extension with a leading dot, lowercased', () => {
    expect(extensionOf('Requirements.DOCX')).toBe('.docx');
  });

  it('returns an empty string for a name with no dot', () => {
    expect(extensionOf('README')).toBe('');
  });

  it('uses only the LAST dot, so a dotted filename keeps its real extension', () => {
    expect(extensionOf('AirPro_BP_ICD_Revision_0.3.docx')).toBe('.docx');
  });

  it('returns an empty extension for a name ending in a dot', () => {
    expect(extensionOf('trailing.')).toBe('.');
  });
});
