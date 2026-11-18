import { describe, it, expect } from 'vitest';
import { extensionOf, JOB_FILE_EXTENSIONS, JOB_FILE_TYPE_LABELS } from './extension';

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

describe('the file types a job can be made from', () => {
  it('include the older Word and Excel formats and CSV, as well as the current ones', () => {
    expect(JOB_FILE_EXTENSIONS.split(',')).toEqual(['.txt', '.md', '.docx', '.doc', '.pdf', '.xlsx', '.xls', '.csv']);
  });

  it('are the same set the dropzone shows as labels, so the page never offers a type it then refuses', () => {
    const accepted = JOB_FILE_EXTENSIONS.split(',').map((e) => e.slice(1)).sort();
    expect([...JOB_FILE_TYPE_LABELS].sort()).toEqual(accepted);
  });
});

