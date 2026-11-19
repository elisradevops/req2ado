import { buildFileOverview, buildPreviewOverview, FILE_OVERVIEW_PARSE_MS } from '../src/modules/pipeline/document-preview';

const doc = (blocks: any[]) => ({ document: { format: 'docx' }, blocks, tables: [], figures: [] }) as any;
const h = (level: number, number_label: string, text: string) => ({ kind: 'heading', heading_level: level, number_label, text }) as any;
const p = (text: string) => ({ kind: 'paragraph', text }) as any;

describe('buildPreviewOverview', () => {
  const blocks = [h(1, '1', 'Scope'), p('It covers the unit and its interfaces in full.'), h(2, '1.1', 'Detail')];

  it('builds the overview, the caveat and the hint from the parsed document, with the baseline tree when it is had', async () => {
    const level = jest.fn().mockResolvedValue({ nodes: [{ local_id: 'e', type: 'Epic', parent_local_id: null }] });
    const overview = await buildPreviewOverview(doc(blocks), level, { sectionCount: 2, depth: 2, documentMap: [] });
    expect(level).toHaveBeenCalledWith(expect.anything(), 'baseline', undefined, undefined, undefined, undefined, undefined, undefined, expect.any(AbortSignal));
    expect(overview.profile.baselineTree).toEqual({ epics: 1, features: 0, requirements: 0, depth: 1, roots: 1 });
    expect(overview.lines?.join(' ')).not.toMatch(/headings alone/);
    expect(overview.structureHint).toMatch(/1 Epic\b/);
    expect(overview.structureHint).toMatch(/context only/i);
    expect(overview.caveat).toBeNull();
  });

  it('answers without the tree when ingestion fails, and logs that it did', async () => {
    const warn = jest.fn();
    const overview = await buildPreviewOverview(doc(blocks), jest.fn().mockRejectedValue(new Error('down')), { sectionCount: 2, depth: 2, documentMap: [] }, { warn });
    expect(overview.profile.baselineTree).toBeUndefined();
    expect(overview.lines?.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('baseline tree'));
  });

  it('gives up on a hung ingestion after the bound and cancels the call', async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    const level = jest.fn().mockImplementation((...args: unknown[]) => new Promise((_resolve, reject) => {
      seen = args[8] as AbortSignal;
      seen.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    try {
      const pending = buildPreviewOverview(doc(blocks), level, { sectionCount: 2, depth: 2, documentMap: [] });
      await jest.advanceTimersByTimeAsync(9_000);
      expect((await pending).profile.baselineTree).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
    expect(seen?.aborted).toBe(true);
  });

  it('still answers within the bound when the ingestion call ignores the cancel signal and never returns', async () => {
    jest.useFakeTimers();
    try {
      const pending = buildPreviewOverview(doc(blocks), jest.fn().mockImplementation(() => new Promise(() => undefined)), { sectionCount: 2, depth: 2, documentMap: [] });
      await jest.advanceTimersByTimeAsync(9_000);
      expect((await pending).profile.baselineTree).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('buildFileOverview (a batch SURVEY file, from its stored bytes)', () => {
  const level = () => jest.fn().mockResolvedValue({ nodes: [] });

  it('parses the bytes once and builds the same overview the preview does, with counts read the same way', async () => {
    const deep = [h(1, '1', 'A'), h(2, '1.1', 'B'), h(3, '1.1.1', 'C'), h(4, '1.1.1.1', 'D'), p('Some text in the deepest clause here.')];
    const ingest = jest.fn().mockResolvedValue(doc(deep));
    const overview = await buildFileOverview(Buffer.from('bytes'), 'spec.docx', ingest, level());
    expect(ingest).toHaveBeenCalledWith(Buffer.from('bytes'), 'spec.docx', expect.any(AbortSignal));
    expect(overview.caveat).toMatch(/deep and fragmented/); // depth 4 from the heading levels, as in /jobs/preview
    expect(overview.structureHint).toMatch(/context only/i);
  });

  it('gives up on a parse that runs past its bound, cancelling it, so the claimed file is never left waiting', async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    const ingest = jest.fn().mockImplementation((_b: Buffer, _n: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      seen = signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    try {
      const pending = buildFileOverview(Buffer.from('bytes'), 'spec.docx', ingest, level());
      const settled = expect(pending).rejects.toThrow();
      await jest.advanceTimersByTimeAsync(FILE_OVERVIEW_PARSE_MS + 1);
      await settled;
    } finally {
      jest.useRealTimers();
    }
    expect(seen?.aborted).toBe(true);
  });
});
