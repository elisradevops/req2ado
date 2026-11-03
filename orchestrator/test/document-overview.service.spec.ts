import { computeDeterministicCaveat, DocumentOverviewService } from '../src/modules/pipeline/document-overview.service';
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

const FACTS = {
  purpose_statements: ['This document specifies the tracker interface.'], glossary_terms: 2, standards: ['MIL-STD-704'], standards_total: 1,
  verification_statements: 0, placeholder_tokens: [], placeholder_tokens_total: 0, table_roles: [], windows_studied: 1, windows_total: 1,
};
const FILE = { buffer: Buffer.from('doc'), originalname: 'x.docx' };

function makeService(studyOverview: jest.Mock) {
  return new DocumentOverviewService({ studyOverview } as any);
}

// The overview now comes from a study of the document (ingestion's extractive, verified reading), composed into text in code. No model writes
// it, and a document the study could not read gets no overview. (It used to be a model's paragraph written from the section headings alone: a
// document with no headings produced an invented subject.)
describe('DocumentOverviewService.generate', () => {
  const documentMap = Array.from({ length: 6 }, () => section(10));
  const input = { file: FILE, documentMap, sectionCount: 6, depth: 2 };

  it('studies the document for this user and model and composes the overview from what the study found', async () => {
    const studyOverview = jest.fn().mockResolvedValue({ read: true, facts: FACTS, reason: null, warnings: [] });

    const result = await makeService(studyOverview).generate({ ...input, model: 'gemma4:12b' }, USER_ID);

    expect(studyOverview).toHaveBeenCalledWith(FILE.buffer, 'x.docx', USER_ID, 'gemma4:12b', undefined, undefined);
    expect(result).toEqual({
      synopsis: 'Stated in the document: “This document specifies the tracker interface.” Defines 2 terms. Cites 1 standard or document: MIL-STD-704.',
      caveat: null,
    });
  });

  it('passes the progress callback and the abort signal through to the study', async () => {
    const studyOverview = jest.fn().mockResolvedValue({ read: true, facts: FACTS, reason: null, warnings: [] });
    const onProgress = jest.fn();
    const signal = new AbortController().signal;

    await makeService(studyOverview).generate({ ...input, model: 'm', onProgress, signal }, USER_ID);

    expect(studyOverview).toHaveBeenCalledWith(FILE.buffer, 'x.docx', USER_ID, 'm', onProgress, signal);
  });

  it('attaches the deterministic structure caveat', async () => {
    const studyOverview = jest.fn().mockResolvedValue({ read: true, facts: FACTS, reason: null, warnings: [] });
    const result = await makeService(studyOverview).generate({ ...input, depth: 5 }, USER_ID);
    expect(result?.caveat).not.toBeNull();
  });

  it('gives no overview when the study read nothing', async () => {
    const studyOverview = jest.fn().mockResolvedValue({ read: false, facts: null, reason: 'unread', warnings: [] });
    expect(await makeService(studyOverview).generate(input, USER_ID)).toBeNull();
  });

  it('gives no overview when the study found nothing to say', async () => {
    const empty = { ...FACTS, purpose_statements: [], glossary_terms: 0, standards: [], standards_total: 0 };
    const studyOverview = jest.fn().mockResolvedValue({ read: true, facts: empty, reason: null, warnings: [] });
    expect(await makeService(studyOverview).generate(input, USER_ID)).toBeNull();
  });

  it('fails open to null when ingestion fails, logging only the error type', async () => {
    const studyOverview = jest.fn().mockRejectedValue(Object.assign(new TypeError('connect ECONNREFUSED http://secret-host'), { code: 'ECONNREFUSED' }));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await makeService(studyOverview).generate(input, USER_ID)).toBeNull();

    expect(String(error.mock.calls[0][0])).toContain('TypeError');
    expect(error.mock.calls.flat().join(' ')).not.toContain('secret-host');
    error.mockRestore();
  });

  it('fails open to null when documentMap is malformed and the caveat cannot be computed', async () => {
    const studyOverview = jest.fn();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await makeService(studyOverview).generate({ ...input, documentMap: null as any }, USER_ID)).toBeNull();
    expect(studyOverview).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
