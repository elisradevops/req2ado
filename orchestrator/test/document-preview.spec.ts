import { buildPreviewOverview } from '../src/modules/pipeline/document-preview';

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
    expect(overview.lines?.join(' ')).toMatch(/1 Epics/);
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
