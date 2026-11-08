import { buildExclusionChecker } from '../src/modules/pipeline/diff-summary';
import {
  buildWritePreview,
  selectEntriesToCreate,
  selectEntriesToLink,
  selectTraceLinks,
  type WritePlanEntry,
} from '../src/modules/pipeline/write-plan';

function entry(partial: Partial<WritePlanEntry> & { localId: string }): WritePlanEntry {
  return { parentLocalId: null, type: 'Requirement', action: 'create', existingAdoId: null, ...partial };
}

describe('selectEntriesToCreate', () => {
  it('creates new entries and resolves reuse and dedup_skip entries to their existing ids', () => {
    const diff = [
      entry({ localId: 'a', type: 'Epic' }),
      entry({ localId: 'b', action: 'reuse', existingAdoId: 11 }),
      entry({ localId: 'c', action: 'dedup_skip', existingAdoId: 12 }),
    ];
    const result = selectEntriesToCreate(diff, buildExclusionChecker(diff), { resumedAdoIdByLocalId: new Map() });
    expect(result.toCreate.map((e) => e.localId)).toEqual(['a']);
    expect([...result.resolvedAdoIdByLocalId]).toEqual([['b', 11], ['c', 12]]);
  });

  it('drops excluded entries and everything under an excluded ancestor', () => {
    const diff = [
      entry({ localId: 'a', excluded: true }),
      entry({ localId: 'b', parentLocalId: 'a' }),
      entry({ localId: 'c' }),
    ];
    const result = selectEntriesToCreate(diff, buildExclusionChecker(diff), { resumedAdoIdByLocalId: new Map() });
    expect(result.toCreate.map((e) => e.localId)).toEqual(['c']);
  });

  it('keeps only the selected ids when a selection is given, and skips entries already written by a prior attempt', () => {
    const diff = [entry({ localId: 'a' }), entry({ localId: 'b' }), entry({ localId: 'c' })];
    const result = selectEntriesToCreate(diff, buildExclusionChecker(diff), {
      resumedAdoIdByLocalId: new Map([['c', 99]]),
      selectedLocalIds: ['a', 'c'],
    });
    expect(result.toCreate.map((e) => e.localId)).toEqual(['a']);
  });

  it('treats a reuse entry without an existing id as an ordinary create', () => {
    const diff = [entry({ localId: 'a', action: 'reuse', existingAdoId: null })];
    const result = selectEntriesToCreate(diff, buildExclusionChecker(diff), { resumedAdoIdByLocalId: new Map() });
    expect(result.toCreate.map((e) => e.localId)).toEqual(['a']);
  });
});

describe('selectEntriesToLink', () => {
  const ids = (localIds: string[]) => new Map(localIds.map((id, index) => [id, index + 1] as const));

  it('links a new child to its parent when both ends have an ADO id', () => {
    const diff = [entry({ localId: 'p', type: 'Epic' }), entry({ localId: 'c', parentLocalId: 'p' })];
    const result = selectEntriesToLink(diff, buildExclusionChecker(diff), ids(['p', 'c']), new Set());
    expect(result.map((e) => e.localId)).toEqual(['c']);
  });

  it('never links a root, an excluded entry, a reuse or dedup_skip child, or one already linked', () => {
    const diff = [
      entry({ localId: 'p' }),
      entry({ localId: 'ex', parentLocalId: 'p', excluded: true }),
      entry({ localId: 'ru', parentLocalId: 'p', action: 'reuse', existingAdoId: 5 }),
      entry({ localId: 'dd', parentLocalId: 'p', action: 'dedup_skip', existingAdoId: 6 }),
      entry({ localId: 'done', parentLocalId: 'p' }),
    ];
    const result = selectEntriesToLink(diff, buildExclusionChecker(diff), ids(['p', 'ex', 'ru', 'dd', 'done']), new Set(['done']));
    expect(result).toEqual([]);
  });

  it('skips a child whose parent was never created', () => {
    const diff = [entry({ localId: 'p' }), entry({ localId: 'c', parentLocalId: 'p' })];
    expect(selectEntriesToLink(diff, buildExclusionChecker(diff), ids(['c']), new Set())).toEqual([]);
  });
});

describe('selectTraceLinks', () => {
  it('resolves intra-job targets through the id map and cross-job targets only when resolved', () => {
    const diff = [
      entry({
        localId: 's',
        traceLinks: [
          { sourceLocalId: 's', referenceName: 'Covers', targetKind: 'intraJob', targetLocalId: 't', resolutionStatus: 'resolved' },
          { sourceLocalId: 's', referenceName: 'Covers', targetKind: 'crossJob', resolvedAdoId: 77, resolutionStatus: 'resolved' },
          { sourceLocalId: 's', referenceName: 'Covers', targetKind: 'crossJob', resolutionStatus: 'unresolved' },
          { sourceLocalId: 's', referenceName: 'Covers', targetKind: 'intraJob', targetLocalId: 'gone', resolutionStatus: 'resolved' },
        ],
      }),
      entry({ localId: 't' }),
    ];
    const result = selectTraceLinks(diff, buildExclusionChecker(diff), new Map([['s', 1], ['t', 2]]));
    expect(result.get(1)).toEqual([
      { targetAdoId: 2, referenceName: 'Covers', sourceLocalId: 's' },
      { targetAdoId: 77, referenceName: 'Covers', sourceLocalId: 's' },
    ]);
  });

  it('ignores trace links on an excluded entry', () => {
    const diff = [
      entry({
        localId: 's',
        excluded: true,
        traceLinks: [{ sourceLocalId: 's', referenceName: 'Covers', targetKind: 'crossJob', resolvedAdoId: 7, resolutionStatus: 'resolved' }],
      }),
    ];
    expect(selectTraceLinks(diff, buildExclusionChecker(diff), new Map([['s', 1]])).size).toBe(0);
  });
});

describe('buildWritePreview', () => {
  it('counts new items by type and the parent links that will be written', () => {
    const diff = [
      entry({ localId: 'e', type: 'Epic' }),
      entry({ localId: 'f', type: 'Feature', parentLocalId: 'e' }),
      entry({ localId: 'r1', parentLocalId: 'f' }),
      entry({ localId: 'r2', parentLocalId: 'f' }),
    ];
    const preview = buildWritePreview(diff);
    expect(preview.createdTotal).toBe(4);
    expect(preview.createdLocalIds).toEqual(['e', 'f', 'r1', 'r2']);
    expect(preview.createdByType).toEqual({ Epic: 1, Feature: 1, Requirement: 2 });
    expect(preview.parentLinks).toBe(3);
  });

  it('separates directly excluded entries from children dropped by an excluded ancestor', () => {
    const diff = [
      entry({ localId: 'f', type: 'Feature', excluded: true }),
      entry({ localId: 'r1', parentLocalId: 'f' }),
      entry({ localId: 'r2', parentLocalId: 'f', excluded: true }),
      entry({ localId: 'r3' }),
    ];
    const preview = buildWritePreview(diff);
    expect(preview.createdTotal).toBe(1);
    expect(preview.excluded).toEqual({ direct: 2, viaAncestor: 1 });
  });

  it('reports existing items that receive new children but get no new parent link', () => {
    const diff = [
      entry({ localId: 'f', type: 'Feature', action: 'reuse', existingAdoId: 40, parentLocalId: 'e' }),
      entry({ localId: 'e', type: 'Epic' }),
      entry({ localId: 'r', parentLocalId: 'f' }),
    ];
    const preview = buildWritePreview(diff);
    expect(preview.existingGettingChildren).toBe(1);
    expect(preview.existingWithoutNewParentLink).toBe(1);
    expect(preview.parentLinks).toBe(1);
  });

  it('counts planned and skipped trace links', () => {
    const diff = [
      entry({
        localId: 's',
        traceLinks: [
          { sourceLocalId: 's', referenceName: 'Covers', targetKind: 'intraJob', targetLocalId: 't', resolutionStatus: 'resolved' },
          { sourceLocalId: 's', referenceName: 'Covers', targetKind: 'intraJob', targetLocalId: 'x', resolutionStatus: 'resolved' },
          { sourceLocalId: 's', referenceName: 'Covers', targetKind: 'crossJob', resolutionStatus: 'pending' },
        ],
      }),
      entry({ localId: 't' }),
      entry({ localId: 'x', excluded: true }),
    ];
    const preview = buildWritePreview(diff);
    expect(preview.traceLinks).toEqual({ planned: 1, skipped: 2 });
  });

  it('counts already-written items from a prior attempt as written, not as new', () => {
    const diff = [entry({ localId: 'a' }), entry({ localId: 'b', parentLocalId: 'a' })];
    const preview = buildWritePreview(diff, { resumedAdoIdByLocalId: new Map([['a', 5]]), alreadyLinkedLocalIds: new Set() });
    expect(preview.createdTotal).toBe(1);
    expect(preview.parentLinks).toBe(1);
  });

  it('reports a write of zero items', () => {
    expect(buildWritePreview([]).createdTotal).toBe(0);
    expect(buildWritePreview([entry({ localId: 'a', excluded: true })]).createdTotal).toBe(0);
  });
});
