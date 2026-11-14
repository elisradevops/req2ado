import { EntrySourceReader, ENTRY_SOURCE_CACHE_MAX_ENTRIES, ENTRY_SOURCE_CACHE_TTL_MS, ENTRY_SOURCE_TIMEOUT_MS } from '../src/modules/pipeline/source-excerpt';

const REF = { documentPath: 'spec.docx', startOffset: 108, endOffset: 151, page: 3 };
const entry = (over: Record<string, unknown> = {}) => ({ localId: 'n4', type: 'Requirement', customerId: null, sourceRef: REF, ...over });
const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  mode: 'baseline',
  originalFilename: 'spec.docx',
  dryRunDiff: [entry()],
  ...over,
});
const TEXT = { text: 'The unit must report an undervoltage fault.', truncated: false, kind: 'text' as const };

function makeReader(options: { original?: Buffer | null; excerpt?: jest.Mock; now?: () => number } = {}) {
  const loadOriginal = jest.fn().mockResolvedValue(options.original === undefined ? Buffer.from('docx bytes') : options.original);
  const fetchExcerpt = options.excerpt ?? jest.fn().mockResolvedValue(TEXT);
  const reader = new EntrySourceReader(loadOriginal, fetchExcerpt, { now: options.now });
  return { reader, loadOriginal, fetchExcerpt };
}

describe('EntrySourceReader', () => {
  it("re-reads the stored original through ingestion at the entry's own span and returns its wording", async () => {
    const { reader, loadOriginal, fetchExcerpt } = makeReader();

    await expect(reader.read(job(), 'n4')).resolves.toEqual(TEXT);

    expect(loadOriginal).toHaveBeenCalledWith('job-1');
    expect(fetchExcerpt).toHaveBeenCalledWith(
      Buffer.from('docx bytes'),
      'spec.docx',
      { startOffset: 108, endOffset: 151, page: 3, extent: 'span', rowHint: null },
      expect.any(AbortSignal),
    );
  });

  it('asks for the whole section for a SURVEY item: every item of a section shares the section start as its ref', async () => {
    const { reader, fetchExcerpt } = makeReader({ excerpt: jest.fn().mockResolvedValue({ text: 'Input Voltage\n\nThe unit…', truncated: false, kind: 'section' }) });

    await expect(reader.read(job({ mode: 'survey' }), 'n4')).resolves.toEqual({ text: 'Input Voltage\n\nThe unit…', truncated: false, kind: 'section' });
    expect(fetchExcerpt.mock.calls[0][2]).toMatchObject({ extent: 'section' });
  });

  it("passes the item's document id as the row hint, so a table row's excerpt is that row, not the whole table", async () => {
    const { reader, fetchExcerpt } = makeReader();

    await reader.read(job({ dryRunDiff: [entry({ customerId: 'PWR-7' })] }), 'n4');

    expect(fetchExcerpt.mock.calls[0][2]).toMatchObject({ rowHint: 'PWR-7' });
  });

  it('returns null for an entry the job does not have (the route answers 404)', async () => {
    const { reader, loadOriginal } = makeReader();

    await expect(reader.read(job(), 'n99')).resolves.toBeNull();
    await expect(reader.read(job({ dryRunDiff: null }), 'n4')).resolves.toBeNull();
    expect(loadOriginal).not.toHaveBeenCalled();
  });

  it('says no_span, without loading the file, for an entry with no usable location', async () => {
    const { reader, loadOriginal } = makeReader();
    const diff = [
      entry({ localId: 'manual', sourceRef: null }),
      entry({ localId: 'empty', sourceRef: { ...REF, startOffset: 0, endOffset: 0 } }),
      // A grouping item the pipeline added borrows a member's ref: it has no wording of its own.
      entry({ localId: 'synth_feature_n7' }),
    ];

    for (const localId of ['manual', 'empty', 'synth_feature_n7']) {
      await expect(reader.read(job({ dryRunDiff: diff }), localId)).resolves.toEqual({ kind: 'unavailable', reason: 'no_span' });
    }
    expect(loadOriginal).not.toHaveBeenCalled();
  });

  it('says no_original, never an error, when the original was not kept', async () => {
    const { reader, fetchExcerpt } = makeReader({ original: null });

    await expect(reader.read(job(), 'n4')).resolves.toEqual({ kind: 'unavailable', reason: 'no_original' });
    expect(fetchExcerpt).not.toHaveBeenCalled();
  });

  it('says no_span when ingestion finds no wording at the span (a table placeholder, a figure)', async () => {
    const { reader } = makeReader({ excerpt: jest.fn().mockResolvedValue({ text: '', truncated: false, kind: 'unavailable' }) });

    await expect(reader.read(job(), 'n4')).resolves.toEqual({ kind: 'unavailable', reason: 'no_span' });
  });

  it('says parse_failed when ingestion fails or times out, and tries again on the next open', async () => {
    const excerpt = jest.fn().mockRejectedValueOnce(new Error('Ingestion /source-excerpt request failed: 500')).mockResolvedValueOnce(TEXT);
    const { reader } = makeReader({ excerpt });

    await expect(reader.read(job(), 'n4')).resolves.toEqual({ kind: 'unavailable', reason: 'parse_failed' });
    await expect(reader.read(job(), 'n4')).resolves.toEqual(TEXT);
  });

  it('answers a repeated open from memory, and again from ingestion once the entry has expired', async () => {
    let now = 1_000;
    const { reader, loadOriginal, fetchExcerpt } = makeReader({ now: () => now });

    await reader.read(job(), 'n4');
    await reader.read(job(), 'n4');
    expect(fetchExcerpt).toHaveBeenCalledTimes(1);
    expect(loadOriginal).toHaveBeenCalledTimes(1);

    now += ENTRY_SOURCE_CACHE_TTL_MS + 1;
    await reader.read(job(), 'n4');
    expect(fetchExcerpt).toHaveBeenCalledTimes(2);
  });

  it('keeps one job apart from another with the same span', async () => {
    const { reader, fetchExcerpt } = makeReader();

    await reader.read(job(), 'n4');
    await reader.read(job({ id: 'job-2' }), 'n4');

    expect(fetchExcerpt).toHaveBeenCalledTimes(2);
  });

  it('holds a bounded number of answers, dropping the least recently used', async () => {
    const { reader, fetchExcerpt } = makeReader();
    const many = Array.from({ length: ENTRY_SOURCE_CACHE_MAX_ENTRIES + 1 }, (_, i) => entry({ localId: `n${i}`, sourceRef: { ...REF, startOffset: i * 10, endOffset: i * 10 + 5 } }));

    for (const e of many) await reader.read(job({ dryRunDiff: many }), e.localId);
    expect(fetchExcerpt).toHaveBeenCalledTimes(ENTRY_SOURCE_CACHE_MAX_ENTRIES + 1);

    await reader.read(job({ dryRunDiff: many }), 'n0'); // the oldest was dropped
    expect(fetchExcerpt).toHaveBeenCalledTimes(ENTRY_SOURCE_CACHE_MAX_ENTRIES + 2);
    await reader.read(job({ dryRunDiff: many }), `n${ENTRY_SOURCE_CACHE_MAX_ENTRIES}`); // the newest is still held
    expect(fetchExcerpt).toHaveBeenCalledTimes(ENTRY_SOURCE_CACHE_MAX_ENTRIES + 2);
  });
});

describe('the wait for a re-parse', () => {
  it('is long enough for a first parse of a large PDF (about 10 s for 89 pages), which a 10 s limit failed on every open', () => {
    expect(ENTRY_SOURCE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
