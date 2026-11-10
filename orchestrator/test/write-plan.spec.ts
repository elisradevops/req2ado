import { buildExclusionChecker } from '../src/modules/pipeline/diff-summary';
import {
  buildWritePreview,
  countExclusions,
  existingParentsGettingChildren,
  existingWithoutNewParentLink,
  findOrphanedSelections,
  findUnknownSelections,
  planHasWork,
  selectEntriesToCreate,
  selectEntriesToLink,
  selectFiguresToAttach,
  selectTraceLinks,
  traceLinkTally,
  type WritePlanEntry,
  type WritePreview,
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

  it('an empty selection creates nothing, while an undefined selection creates everything', () => {
    const diff = [entry({ localId: 'a' }), entry({ localId: 'b' })];
    const none = selectEntriesToCreate(diff, buildExclusionChecker(diff), { resumedAdoIdByLocalId: new Map(), selectedLocalIds: [] });
    expect(none.toCreate).toEqual([]);
    const all = selectEntriesToCreate(diff, buildExclusionChecker(diff), { resumedAdoIdByLocalId: new Map() });
    expect(all.toCreate.map((e) => e.localId)).toEqual(['a', 'b']);
    expect(buildWritePreview(diff, undefined, []).createdTotal).toBe(0);
  });

  it('ignores unknown ids and duplicates in a selection', () => {
    const diff = [entry({ localId: 'a' }), entry({ localId: 'b' }), entry({ localId: 'c' })];
    const run = (selectedLocalIds: string[]) =>
      selectEntriesToCreate(diff, buildExclusionChecker(diff), { resumedAdoIdByLocalId: new Map(), selectedLocalIds }).toCreate.map((e) => e.localId);
    expect(run(['c', 'a', 'a', 'zzz', 'c', 'nope'])).toEqual(run(['a', 'c']));
    expect(run(['a', 'c'])).toEqual(['a', 'c']);
  });

  it('resolves a reuse entry with an existing id even when it is not in the selection', () => {
    const diff = [
      entry({ localId: 'r', action: 'reuse', existingAdoId: 7 }),
      entry({ localId: 'd', action: 'dedup_skip', existingAdoId: 8 }),
      entry({ localId: 'a' }),
    ];
    const result = selectEntriesToCreate(diff, buildExclusionChecker(diff), { resumedAdoIdByLocalId: new Map(), selectedLocalIds: [] });
    expect(result.toCreate).toEqual([]);
    expect([...result.resolvedAdoIdByLocalId]).toEqual([['r', 7], ['d', 8]]);
  });

  it('handles a 100000-id selection against a 100000-entry diff without a quadratic scan', () => {
    const size = 100000;
    const diff = Array.from({ length: size }, (_, i) => entry({ localId: `n${i}` }));
    // Reverse order so a linear `includes` scan walks most of the array for every entry.
    const selectedLocalIds = diff.map((e) => e.localId).reverse();
    const isExcluded = () => false;
    const started = Date.now();
    const result = selectEntriesToCreate(diff, isExcluded, { resumedAdoIdByLocalId: new Map(), selectedLocalIds });
    const elapsed = Date.now() - started;
    expect(result.toCreate).toHaveLength(size);
    expect(elapsed).toBeLessThan(1000);
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

  it('alreadyWritten counts resumed items regardless of the selection, but not resumed items that are excluded', () => {
    const diff = [
      entry({ localId: 'a' }), // resumed, deselected
      entry({ localId: 'b' }), // resumed, selected
      entry({ localId: 'x', excluded: true }), // resumed, excluded
      entry({ localId: 'c' }), // new, selected
    ];
    const resume = {
      resumedAdoIdByLocalId: new Map([['a', 1], ['b', 2], ['x', 3]]),
      alreadyLinkedLocalIds: new Set<string>(),
    };
    const preview = buildWritePreview(diff, resume, ['b', 'c']);
    expect(preview.alreadyWritten).toBe(2);
    expect(preview.createdTotal).toBe(1);
    expect(preview.createdLocalIds).toEqual(['c']);
  });

  it('reports a write of zero items', () => {
    expect(buildWritePreview([]).createdTotal).toBe(0);
    expect(buildWritePreview([entry({ localId: 'a', excluded: true })]).createdTotal).toBe(0);
  });
});

describe('buildWritePreview selection, existing parents and parity', () => {
  const noResume = () => ({ resumedAdoIdByLocalId: new Map<string, number>(), alreadyLinkedLocalIds: new Set<string>() });

  it('honours a selection like selectEntriesToCreate: unselected entries are not created and their children get no link', () => {
    const diff = [entry({ localId: 'a' }), entry({ localId: 'b', parentLocalId: 'a' }), entry({ localId: 'c' })];
    const preview = buildWritePreview(diff, noResume(), ['a', 'c']);
    expect(preview.createdLocalIds).toEqual(['a', 'c']);
    expect(preview.parentLinks).toBe(0);
    const deselectParent = buildWritePreview(diff, noResume(), ['b']);
    expect(deselectParent.createdLocalIds).toEqual(['b']);
    expect(deselectParent.parentLinks).toBe(0);
  });

  it('creates a reuse entry without an existing id and does not count it as existing', () => {
    const diff = [
      entry({ localId: 'p', action: 'reuse', existingAdoId: null }),
      entry({ localId: 'c', parentLocalId: 'p' }),
    ];
    const preview = buildWritePreview(diff);
    expect(preview.createdTotal).toBe(2);
    expect(preview.existingGettingChildren).toBe(0);
    expect(preview.existingWithoutNewParentLink).toBe(0);
    expect(preview.parentLinks).toBe(1);
  });

  it('counts only distinct existing parents whose child actually gets a new link', () => {
    const diff = [
      entry({ localId: 'p1', action: 'reuse', existingAdoId: 1 }),
      entry({ localId: 'p2', action: 'reuse', existingAdoId: 2 }),
      entry({ localId: 'p3', action: 'reuse', existingAdoId: 3 }),
      entry({ localId: 'p4', action: 'reuse', existingAdoId: 4 }),
      entry({ localId: 'c1', parentLocalId: 'p1' }),
      entry({ localId: 'c1b', parentLocalId: 'p1' }),
      entry({ localId: 'c2', parentLocalId: 'p2' }), // already linked by a prior attempt
      entry({ localId: 'c3', parentLocalId: 'p3' }), // deselected
      entry({ localId: 'c4', parentLocalId: 'p4' }),
    ];
    const resume = {
      resumedAdoIdByLocalId: new Map([['c2', 22]]),
      alreadyLinkedLocalIds: new Set(['c2']),
    };
    const preview = buildWritePreview(diff, resume, ['c1', 'c1b', 'c2', 'c4']);
    expect(preview.existingGettingChildren).toBe(2); // p1 and p4
    expect(preview.existingWithoutNewParentLink).toBe(0);
  });

  it('links a new child of a dedup_skip parent and counts the parent as getting children', () => {
    const diff = [
      entry({ localId: 'p', action: 'dedup_skip', existingAdoId: 7 }),
      entry({ localId: 'c', parentLocalId: 'p' }),
    ];
    const preview = buildWritePreview(diff);
    expect(preview.parentLinks).toBe(1);
    expect(preview.existingGettingChildren).toBe(1);
  });

  it('counts an included child of an excluded parent as excluded via ancestor, not created', () => {
    const diff = [entry({ localId: 'p', excluded: true }), entry({ localId: 'c', parentLocalId: 'p' })];
    const preview = buildWritePreview(diff);
    expect(preview.excluded).toEqual({ direct: 1, viaAncestor: 1 });
    expect(preview.createdTotal).toBe(0);
  });

  it('skips trace links whose intra-job target is excluded and cross-job links that are unresolved or pending', () => {
    const link = (extra: Partial<NonNullable<WritePlanEntry['traceLinks']>[number]>) => ({
      sourceLocalId: 'a', referenceName: 'R', targetKind: 'intraJob' as const, resolutionStatus: 'resolved' as const, ...extra,
    });
    const diff = [
      entry({
        localId: 'a',
        traceLinks: [
          link({ targetLocalId: 'x' }),
          link({ targetKind: 'crossJob', resolutionStatus: 'unresolved' }),
          link({ targetKind: 'crossJob', resolutionStatus: 'pending', resolvedAdoId: 5 }),
          link({ targetKind: 'crossJob', resolutionStatus: 'resolved', resolvedAdoId: 6 }),
        ],
      }),
      entry({ localId: 'x', excluded: true }),
    ];
    expect(buildWritePreview(diff).traceLinks).toEqual({ planned: 1, skipped: 3 });
  });

  it('plans no parent link for an already-linked entry but still plans its trace links', () => {
    const diff = [
      entry({ localId: 'p' }),
      entry({
        localId: 'c',
        parentLocalId: 'p',
        traceLinks: [{ sourceLocalId: 'c', referenceName: 'R', targetKind: 'intraJob', targetLocalId: 'p', resolutionStatus: 'resolved' }],
      }),
    ];
    const preview = buildWritePreview(diff, {
      resumedAdoIdByLocalId: new Map([['p', 1], ['c', 2]]),
      alreadyLinkedLocalIds: new Set(['c']),
    });
    expect(preview.parentLinks).toBe(0);
    expect(preview.traceLinks).toEqual({ planned: 1, skipped: 0 });
  });

  it('counts resumed, non-excluded entries as alreadyWritten', () => {
    const diff = [entry({ localId: 'a' }), entry({ localId: 'b' }), entry({ localId: 'c', excluded: true }), entry({ localId: 'd' })];
    const preview = buildWritePreview(diff, {
      resumedAdoIdByLocalId: new Map([['a', 1], ['c', 3]]),
      alreadyLinkedLocalIds: new Set(),
    });
    expect(preview.alreadyWritten).toBe(1);
    expect(preview.createdTotal).toBe(2);
  });

  it('does not count a root reuse entry in existingWithoutNewParentLink (only existing entries with a parent)', () => {
    const diff = [entry({ localId: 'a', action: 'reuse', existingAdoId: 5 })];
    const preview = buildWritePreview(diff);
    expect(preview.existingWithoutNewParentLink).toBe(0);
    expect(preview.existingGettingChildren).toBe(0);
    expect(preview.createdTotal).toBe(0);
  });

  it('does not crash on duplicate localIds and counts both entries in createdTotal', () => {
    const diff = [entry({ localId: 'a' }), entry({ localId: 'a' })];
    expect(() => buildWritePreview(diff)).not.toThrow();
    expect(buildWritePreview(diff).createdTotal).toBe(2);
  });

  it('does not count an entry excluded through a reuse ancestor as existing', () => {
    const diff = [
      entry({ localId: 'a', action: 'reuse', existingAdoId: 5, excluded: true }),
      entry({ localId: 'b', action: 'reuse', existingAdoId: 6, parentLocalId: 'a' }),
    ];
    const preview = buildWritePreview(diff);
    expect(preview.excluded).toEqual({ direct: 1, viaAncestor: 1 });
    expect(preview.existingWithoutNewParentLink).toBe(0);
    expect(preview.existingGettingChildren).toBe(0);
  });

  describe('parity with the select* functions confirm() uses', () => {
    const fixtures: { name: string; diff: WritePlanEntry[]; resume: ReturnType<typeof noResume>; selection?: string[] }[] = [
      {
        name: 'mixed tree with selection and resume',
        diff: [
          entry({ localId: 'e', type: 'Epic' }),
          entry({ localId: 'f', parentLocalId: 'e', type: 'Feature' }),
          entry({ localId: 'r1', parentLocalId: 'f' }),
          entry({ localId: 'r2', parentLocalId: 'f', excluded: true }),
          entry({ localId: 'r3', parentLocalId: 'r2' }),
          entry({ localId: 'x', action: 'reuse', existingAdoId: 9 }),
          entry({ localId: 'r4', parentLocalId: 'x' }),
          entry({ localId: 'y', action: 'dedup_skip', existingAdoId: 10, parentLocalId: 'x' }),
          entry({ localId: 'z', action: 'reuse', existingAdoId: null }),
          entry({
            localId: 'r5',
            parentLocalId: 'z',
            traceLinks: [
              { sourceLocalId: 'r5', referenceName: 'T', targetKind: 'intraJob', targetLocalId: 'r1', resolutionStatus: 'resolved' },
              { sourceLocalId: 'r5', referenceName: 'T', targetKind: 'crossJob', resolutionStatus: 'resolved', resolvedAdoId: 44 },
              { sourceLocalId: 'r5', referenceName: 'T', targetKind: 'intraJob', targetLocalId: 'r3', resolutionStatus: 'resolved' },
            ],
          }),
        ],
        resume: { resumedAdoIdByLocalId: new Map([['f', 20]]), alreadyLinkedLocalIds: new Set(['f']) },
        selection: ['e', 'f', 'r1', 'r5', 'z'],
      },
      { name: 'no selection, no resume', diff: [entry({ localId: 'a' }), entry({ localId: 'b', parentLocalId: 'a' })], resume: noResume() },
      { name: 'empty', diff: [], resume: noResume() },
    ];

    it.each(fixtures)('preview hasWork matches planHasWork for every parity fixture: $name', ({ diff, resume, selection }) => {
      const preview = buildWritePreview(diff, resume, selection);
      expect(preview.hasWork).toBe(planHasWork(preview));
    });

    it.each(fixtures)('$name', ({ diff, resume, selection }) => {
      const preview = buildWritePreview(diff, resume, selection);
      const isExcluded = buildExclusionChecker(diff);
      const { toCreate, resolvedAdoIdByLocalId } = selectEntriesToCreate(diff, isExcluded, {
        resumedAdoIdByLocalId: resume.resumedAdoIdByLocalId,
        selectedLocalIds: selection,
      });
      const ids = new Map<string, number>(resume.resumedAdoIdByLocalId);
      for (const [k, v] of resolvedAdoIdByLocalId) ids.set(k, v);
      for (const e of toCreate) ids.set(e.localId, 0);
      expect(preview.createdTotal).toBe(toCreate.length);
      expect(preview.parentLinks).toBe(selectEntriesToLink(diff, isExcluded, ids, resume.alreadyLinkedLocalIds).length);
      let planned = 0;
      for (const list of selectTraceLinks(diff, isExcluded, ids).values()) planned += list.length;
      expect(preview.traceLinks.planned).toBe(planned);
    });
  });
});

const tlink = (sourceLocalId: string, extra: Partial<NonNullable<WritePlanEntry['traceLinks']>[number]> = {}) => ({
  sourceLocalId, referenceName: 'T', targetKind: 'intraJob' as const, resolutionStatus: 'resolved' as const, ...extra,
});

describe('write-plan helpers', () => {
  it('countExclusions separates direct exclusions from entries dropped by an excluded ancestor', () => {
    const diff = [
      entry({ localId: 'a', excluded: true }),
      entry({ localId: 'b', parentLocalId: 'a' }),
      entry({ localId: 'c', parentLocalId: 'b' }),
      entry({ localId: 'd', excluded: true }),
      entry({ localId: 'e' }),
    ];
    expect(countExclusions(diff, buildExclusionChecker(diff))).toEqual({ direct: 2, viaAncestor: 2 });
    expect(countExclusions([], () => false)).toEqual({ direct: 0, viaAncestor: 0 });
  });

  it('existingParentsGettingChildren counts distinct resolved parents of linked entries only', () => {
    const diff = [entry({ localId: 'p' }), entry({ localId: 'c1', parentLocalId: 'p' }), entry({ localId: 'c2', parentLocalId: 'p' }), entry({ localId: 'q' }), entry({ localId: 'd', parentLocalId: 'q' })];
    const links = [diff[1], diff[2], diff[4]];
    expect(existingParentsGettingChildren(links, new Map([['p', 1]]))).toBe(1);
    expect(existingParentsGettingChildren(links, new Map([['p', 1], ['q', 2]]))).toBe(2);
    expect(existingParentsGettingChildren(links, new Map())).toBe(0);
  });

  it('existingWithoutNewParentLink counts non-excluded resolved entries that have a parent', () => {
    const diff = [
      entry({ localId: 'root', action: 'reuse', existingAdoId: 1 }),
      entry({ localId: 'a', action: 'reuse', existingAdoId: 2, parentLocalId: 'root' }),
      entry({ localId: 'b', action: 'reuse', existingAdoId: 3, parentLocalId: 'root', excluded: true }),
      entry({ localId: 'c', parentLocalId: 'root' }),
    ];
    const resolved = new Map([['root', 1], ['a', 2], ['b', 3]]);
    expect(existingWithoutNewParentLink(diff, buildExclusionChecker(diff), resolved)).toBe(1);
  });

  it('traceLinkTally returns the planned grouping, the planned count and the declared count (excluded sources not declared)', () => {
    const diff = [
      entry({ localId: 's', traceLinks: [tlink('s', { targetLocalId: 't' }), tlink('s', { targetLocalId: 'nope' }), tlink('s', { targetKind: 'crossJob', resolutionStatus: 'unresolved' })] }),
      entry({ localId: 't' }),
      entry({ localId: 'x', excluded: true, traceLinks: [tlink('x', { targetLocalId: 't' })] }),
    ];
    const ids = new Map([['s', 1], ['t', 2], ['x', 3]]);
    const tally = traceLinkTally(diff, buildExclusionChecker(diff), ids);
    expect(tally.declared).toBe(3);
    expect(tally.planned).toBe(1);
    expect(tally.bySource).toEqual(selectTraceLinks(diff, buildExclusionChecker(diff), ids));
    expect(tally.bySource.get(1)).toEqual([{ targetAdoId: 2, referenceName: 'T', sourceLocalId: 's' }]);
  });

  it('selectFiguresToAttach groups the still-stored figures of non-excluded eligible entries, deduplicated per work item', () => {
    const diff = [
      entry({ localId: 'a', figureIds: ['f1', 'f2', 'gone'] }),
      entry({ localId: 'b', figureIds: ['f3'] }),
      entry({ localId: 'b2', figureIds: ['f3', 'f4'] }),
      entry({ localId: 'ex', excluded: true, figureIds: ['f5'] }),
      entry({ localId: 'noid', figureIds: ['f6'] }),
    ];
    const ids = new Map([['a', 1], ['b', 9], ['b2', 9], ['ex', 2]]);
    const stored = new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    const result = selectFiguresToAttach(diff, buildExclusionChecker(diff), ids, stored);
    expect(Object.fromEntries([...result].map(([k, v]) => [k, [...v]]))).toEqual({ 1: ['f1', 'f2'], 9: ['f3', 'f4'] });
  });

  const attached = (diff: WritePlanEntry[], ids: Map<string, number>, stored: string[]) =>
    Object.fromEntries(
      [...selectFiguresToAttach(diff, buildExclusionChecker(diff), ids, new Set(stored))].map(([k, v]) => [k, [...v]]),
    );

  it('selectFiguresToAttach includes uncaptioned figures that are not insignificant', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1'], uncaptionedFigureIds: ['u1', 'u2'], insignificantFigureIds: ['u2'] })];
    expect(attached(diff, new Map([['a', 1]]), ['f1', 'u1', 'u2'])).toEqual({ 1: ['f1', 'u1'] });
  });

  it('selectFiguresToAttach skips detached ids', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1', 'f2'], uncaptionedFigureIds: ['u1'], detachedFigureIds: ['f2', 'u1'] })];
    expect(attached(diff, new Map([['a', 1]]), ['f1', 'f2', 'u1'])).toEqual({ 1: ['f1'] });
  });

  it('preview and selectFiguresToAttach agree on a diff with detached figures', () => {
    const diff = [
      entry({ localId: 'a', figureIds: ['f1', 'f2'], detachedFigureIds: ['f2'] }),
      entry({ localId: 'b', figureIds: ['f3'], uncaptionedFigureIds: ['u1'], detachedFigureIds: ['f3'] }),
    ];
    const stored = ['f1', 'f2', 'f3', 'u1'];
    const ids = new Map([['a', -1], ['b', -2]]);
    const total = Object.values(attached(diff, ids, stored)).reduce((sum, list) => sum + list.length, 0);
    const preview = buildWritePreview(diff, { resumedAdoIdByLocalId: new Map(), alreadyLinkedLocalIds: new Set(), pendingFigureIds: new Set(stored) });
    expect(total).toBe(2);
    expect(preview.figuresToAttach).toBe(total);
    expect(preview.figuresUnavailable).toBe(0);
  });

  it('a detached figure is not counted in figuresToAttach or figuresUnavailable', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1', 'f2'], detachedFigureIds: ['f2'] })];
    const preview = buildWritePreview(diff, { resumedAdoIdByLocalId: new Map(), alreadyLinkedLocalIds: new Set(), pendingFigureIds: new Set(['f1']) });
    expect(preview.figuresToAttach).toBe(1);
    expect(preview.figuresUnavailable).toBe(0);
  });

  it('skips an uncaptioned figure with no stored file', () => {
    const diff = [entry({ localId: 'a', uncaptionedFigureIds: ['u1', 'u2'] })];
    expect(attached(diff, new Map([['a', 1]]), ['u1'])).toEqual({ 1: ['u1'] });
  });

  it('skips insignificant figures', () => {
    const diff = [entry({ localId: 'a', uncaptionedFigureIds: ['u1'], insignificantFigureIds: ['u1'] })];
    expect(attached(diff, new Map([['a', 1]]), ['u1'])).toEqual({});
  });

  it('an excluded entry attaches no uncaptioned figure', () => {
    const diff = [entry({ localId: 'a', excluded: true, uncaptionedFigureIds: ['u1'] })];
    expect(attached(diff, new Map([['a', 1]]), ['u1'])).toEqual({});
  });

  it('a figure listed in both lists is attached once', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1'], uncaptionedFigureIds: ['f1'] })];
    expect(attached(diff, new Map([['a', 1]]), ['f1'])).toEqual({ 1: ['f1'] });
  });
});

describe('buildWritePreview figuresToAttach and planHasWork', () => {
  const resume = (resumed: [string, number][] = [], linked: string[] = [], figures?: string[]) => ({
    resumedAdoIdByLocalId: new Map(resumed),
    alreadyLinkedLocalIds: new Set(linked),
    ...(figures ? { pendingFigureIds: new Set(figures) } : {}),
  });

  it('is 0 when no stored figures are supplied', () => {
    expect(buildWritePreview([entry({ localId: 'a', figureIds: ['f1'] })]).figuresToAttach).toBe(0);
  });

  it('counts figures of created and resumed entries, but not reuse, excluded, unselected or already-attached ones', () => {
    const diff = [
      entry({ localId: 'new', figureIds: ['f1', 'f2'] }),
      entry({ localId: 'ru', action: 'reuse', existingAdoId: 5, figureIds: ['f3'] }),
      entry({ localId: 'res', figureIds: ['f4'] }),
      entry({ localId: 'ex', excluded: true, figureIds: ['f5'] }),
      entry({ localId: 'unsel', figureIds: ['f6'] }),
      entry({ localId: 'done', figureIds: ['f7'] }), // its figure row was deleted after upload
    ];
    const preview = buildWritePreview(diff, resume([['res', 50]], [], ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']), ['new']);
    expect(preview.figuresToAttach).toBe(3); // f1, f2, f4 (not the reuse entry's f3)
  });

  it('reuse and dedup_skip entries get no automatic figure attachments', () => {
    const diff = [
      entry({ localId: 'ru', action: 'reuse', existingAdoId: 5, figureIds: ['f1'] }),
      entry({ localId: 'ds', action: 'dedup_skip', existingAdoId: 6, figureIds: ['f2'], uncaptionedFigureIds: ['u1'] }),
    ];
    const preview = buildWritePreview(diff, resume([], [], ['f1', 'f2', 'u1']));
    expect(preview.figuresToAttach).toBe(0);
    expect(planHasWork(preview)).toBe(false);
  });

  it('created entries still get figure attachments', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1', 'f2'] })];
    expect(buildWritePreview(diff, resume([], [], ['f1', 'f2'])).figuresToAttach).toBe(2);
  });

  it('resumed entries still get figure attachments', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1'] })];
    expect(buildWritePreview(diff, resume([['a', 5]], [], ['f1'])).figuresToAttach).toBe(1);
  });

  it('buildWritePreview counts uncaptioned figures in figuresToAttach', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1'], uncaptionedFigureIds: ['u1', 'u2'], insignificantFigureIds: ['u2'] })];
    expect(buildWritePreview(diff, resume([], [], ['f1', 'u1', 'u2'])).figuresToAttach).toBe(2);
  });

  it('planHasWork is true when only uncaptioned figures remain', () => {
    const diff = [entry({ localId: 'a', uncaptionedFigureIds: ['u1'] })];
    const preview = buildWritePreview(diff, resume([['a', 5]], [], ['u1']));
    expect(preview.createdTotal).toBe(0);
    expect(planHasWork(preview)).toBe(true);
  });

  it('does not merge figures of two different new items', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1'] }), entry({ localId: 'b', figureIds: ['f2'] })];
    expect(buildWritePreview(diff, resume([], [], ['f1', 'f2'])).figuresToAttach).toBe(2);
  });

  it('counts figuresUnavailable for create entries whose figure is not stored', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1', 'f2'], uncaptionedFigureIds: ['u1'] })];
    expect(buildWritePreview(diff, resume([], [], ['f1'])).figuresUnavailable).toBe(2); // f2, u1
  });

  it('does not count resumed entries already-uploaded figures', () => {
    const diff = [entry({ localId: 'res', figureIds: ['f1'] })];
    expect(buildWritePreview(diff, resume([['res', 5]], [], [])).figuresUnavailable).toBe(0);
  });

  it('excluded, reuse, dedup_skip and unselected entries never count', () => {
    const diff = [
      entry({ localId: 'ex', excluded: true, figureIds: ['f1'] }),
      entry({ localId: 'ru', action: 'reuse', existingAdoId: 5, figureIds: ['f2'] }),
      entry({ localId: 'ds', action: 'dedup_skip', existingAdoId: 6, figureIds: ['f3'] }),
      entry({ localId: 'unsel', figureIds: ['f4'] }),
      entry({ localId: 'new', figureIds: ['f5'] }),
    ];
    expect(buildWritePreview(diff, resume([], [], []), ['new']).figuresUnavailable).toBe(1);
  });

  it('insignificant figures never count', () => {
    const diff = [entry({ localId: 'a', uncaptionedFigureIds: ['u1', 'u2'], insignificantFigureIds: ['u2'] })];
    expect(buildWritePreview(diff, resume([], [], [])).figuresUnavailable).toBe(1);
  });

  it('figuresUnavailable is 0 when pendingFigureIds is omitted', () => {
    expect(buildWritePreview([entry({ localId: 'a', figureIds: ['f1'] })]).figuresUnavailable).toBe(0);
  });

  it('planHasWork is true when any of created, parent links, planned trace links or figures is positive', () => {
    const base: Omit<WritePreview, 'hasWork' | 'figuresOnly'> = {
      createdTotal: 0, createdLocalIds: [], createdByType: {}, excluded: { direct: 0, viaAncestor: 0 }, parentLinks: 0,
      existingGettingChildren: 0, existingWithoutNewParentLink: 0, traceLinks: { planned: 0, skipped: 0 }, alreadyWritten: 0, figuresToAttach: 0, figuresUnavailable: 0,
    };
    expect(planHasWork(base)).toBe(false);
    expect(planHasWork({ ...base, createdTotal: 1 })).toBe(true);
    expect(planHasWork({ ...base, parentLinks: 1 })).toBe(true);
    expect(planHasWork({ ...base, traceLinks: { planned: 1, skipped: 0 } })).toBe(true);
    expect(planHasWork({ ...base, figuresToAttach: 1 })).toBe(true);
    expect(planHasWork({ ...base, traceLinks: { planned: 0, skipped: 5 }, alreadyWritten: 3 })).toBe(false);
  });

  it('a resumed job with only figures left still has work', () => {
    const diff = [entry({ localId: 'a', figureIds: ['f1'] })];
    const preview = buildWritePreview(diff, resume([['a', 5]], [], ['f1']));
    expect(preview.createdTotal).toBe(0);
    expect(planHasWork(preview)).toBe(true);
  });
});

describe('buildWritePreview full parity with confirm()', () => {
  type Fx = { name: string; diff: WritePlanEntry[]; resumed?: [string, number][]; linked?: string[]; selection?: string[]; figures?: string[] };
  const fixtures: Fx[] = [
    {
      name: 'plain tree',
      diff: [
        entry({ localId: 'e', type: 'Epic' }),
        entry({ localId: 'f', type: 'Feature', parentLocalId: 'e' }),
        entry({ localId: 'r', parentLocalId: 'f', figureIds: ['f1'] }),
      ],
      figures: ['f1'],
    },
    {
      name: 'uncaptioned and insignificant figures',
      diff: [
        entry({ localId: 'e', type: 'Epic', uncaptionedFigureIds: ['u1', 'u2'], insignificantFigureIds: ['u2'] }),
      ],
      figures: ['u1', 'u2'],
    },
    {
      name: 'excluded subtree',
      diff: [
        entry({ localId: 'a', excluded: true }),
        entry({ localId: 'b', parentLocalId: 'a', traceLinks: [tlink('b', { targetLocalId: 'c' })] }),
        entry({ localId: 'c', parentLocalId: 'b' }),
        entry({ localId: 'd', traceLinks: [tlink('d', { targetLocalId: 'c' })] }),
      ],
    },
    {
      name: 'reuse and dedup_skip parents getting new children',
      diff: [
        entry({ localId: 'p', action: 'reuse', existingAdoId: 1, figureIds: ['f1'] }),
        entry({ localId: 'q', action: 'dedup_skip', existingAdoId: 2, parentLocalId: 'p' }),
        entry({ localId: 'c1', parentLocalId: 'p' }),
        entry({ localId: 'c2', parentLocalId: 'q' }),
        entry({ localId: 'c3', parentLocalId: 'q' }),
        entry({ localId: 'noid', action: 'reuse', existingAdoId: null, parentLocalId: 'p' }),
      ],
      figures: ['f1'],
    },
    {
      name: 'resumed mappings with partial links',
      diff: [
        entry({ localId: 'a' }),
        entry({ localId: 'b', parentLocalId: 'a' }),
        entry({ localId: 'c', parentLocalId: 'a', figureIds: ['f1', 'f2'] }),
        entry({ localId: 'd', parentLocalId: 'b' }),
      ],
      resumed: [['a', 10], ['b', 11], ['c', 12]],
      linked: ['b'],
      figures: ['f2'],
    },
    {
      name: 'unresolved and cross-job trace links',
      diff: [
        entry({
          localId: 's',
          traceLinks: [
            tlink('s', { targetLocalId: 't' }),
            tlink('s', { targetKind: 'crossJob', resolvedAdoId: 77 }),
            tlink('s', { targetKind: 'crossJob', resolutionStatus: 'unresolved' }),
            tlink('s', { targetKind: 'crossJob', resolutionStatus: 'pending', resolvedAdoId: 5 }),
            tlink('s', { targetLocalId: 'missing' }),
          ],
        }),
        entry({ localId: 't' }),
      ],
    },
    {
      name: 'created, resumed and reuse entries mixed with figures',
      diff: [
        entry({ localId: 'n', figureIds: ['f1'] }),
        entry({ localId: 'res', figureIds: ['f2'] }),
        entry({ localId: 'ru', action: 'reuse', existingAdoId: 5, figureIds: ['f3'] }),
        entry({ localId: 'ds', action: 'dedup_skip', existingAdoId: 6, figureIds: ['f4'] }),
      ],
      resumed: [['res', 50]],
      figures: ['f1', 'f2', 'f3', 'f4'],
    },
    {
      name: 'selectedLocalIds subset',
      diff: [
        entry({ localId: 'a' }),
        entry({ localId: 'b', parentLocalId: 'a', figureIds: ['f1'] }),
        entry({ localId: 'c', parentLocalId: 'b', traceLinks: [tlink('c', { targetLocalId: 'a' })] }),
        entry({ localId: 'r', action: 'reuse', existingAdoId: 3, parentLocalId: 'a' }),
      ],
      selection: ['a', 'c'],
      figures: ['f1'],
    },
  ];

  it.each(fixtures)('$name: every field equals what the select* functions return (preview figuresToAttach matches confirm)', ({ diff, resumed = [], linked = [], selection, figures }) => {
    const resumedAdoIdByLocalId = new Map(resumed);
    const alreadyLinkedLocalIds = new Set(linked);
    const pendingFigureIds = new Set(figures ?? []);
    const preview = buildWritePreview(diff, { resumedAdoIdByLocalId, alreadyLinkedLocalIds, pendingFigureIds }, selection);

    // Replay confirm()'s own order.
    const isExcluded = buildExclusionChecker(diff);
    const { toCreate, resolvedAdoIdByLocalId } = selectEntriesToCreate(diff, isExcluded, { resumedAdoIdByLocalId, selectedLocalIds: selection });
    const ids = new Map<string, number>(resumedAdoIdByLocalId);
    for (const [k, v] of resolvedAdoIdByLocalId) ids.set(k, v);
    toCreate.forEach((e, i) => ids.set(e.localId, -(i + 1)));
    const toLink = selectEntriesToLink(diff, isExcluded, ids, alreadyLinkedLocalIds);
    const bySource = selectTraceLinks(diff, isExcluded, ids);
    let planned = 0;
    for (const list of bySource.values()) planned += list.length;
    let declared = 0;
    for (const e of diff) if (!isExcluded(e)) declared += (e.traceLinks ?? []).length;
    let figureCount = 0;
    const eligible = new Map<string, number>(resumedAdoIdByLocalId);
    toCreate.forEach((e, i) => eligible.set(e.localId, -(i + 1)));
    for (const set of selectFiguresToAttach(diff, isExcluded, eligible, pendingFigureIds).values()) figureCount += set.size;
    let unavailableCount = 0;
    if (figures) {
      for (const e of toCreate) {
        const insignificant = new Set(e.insignificantFigureIds ?? []);
        const ids = new Set([...(e.figureIds ?? []), ...(e.uncaptionedFigureIds ?? []).filter((f) => !insignificant.has(f))]);
        for (const f of ids) if (!pendingFigureIds.has(f)) unavailableCount += 1;
      }
    }
    const createdByType: Record<string, number> = {};
    for (const e of toCreate) createdByType[e.type] = (createdByType[e.type] ?? 0) + 1;

    expect(preview).toEqual({
      createdTotal: toCreate.length,
      createdLocalIds: toCreate.map((e) => e.localId),
      createdByType,
      excluded: countExclusions(diff, isExcluded),
      parentLinks: toLink.length,
      existingGettingChildren: existingParentsGettingChildren(toLink, resolvedAdoIdByLocalId),
      existingWithoutNewParentLink: existingWithoutNewParentLink(diff, isExcluded, resolvedAdoIdByLocalId),
      traceLinks: { planned, skipped: declared - planned },
      alreadyWritten: diff.filter((e) => !isExcluded(e) && resumedAdoIdByLocalId.has(e.localId)).length,
      figuresToAttach: figureCount,
      figuresUnavailable: unavailableCount,
      hasWork: toCreate.length > 0 || toLink.length > 0 || planned > 0 || figureCount > 0,
      figuresOnly: toCreate.length === 0 && toLink.length === 0 && planned === 0 && figureCount > 0,
    });
  });
});

describe('findOrphanedSelections / findUnknownSelections', () => {
  const orphans = (diff: WritePlanEntry[], selected: string[], resumed: [string, number][] = []) =>
    findOrphanedSelections(diff, buildExclusionChecker(diff), { resumedAdoIdByLocalId: new Map(resumed), selectedLocalIds: selected });

  it('names a selected create entry whose parent is a deselected, unmapped create entry', () => {
    const diff = [entry({ localId: 'p' }), entry({ localId: 'c', parentLocalId: 'p' })];
    expect(orphans(diff, ['c'])).toEqual(['c']);
    expect(orphans(diff, ['p', 'c'])).toEqual([]);
    expect(orphans(diff, ['p'])).toEqual([]);
  });

  it('is not an orphan when the parent is reuse, dedup_skip, already mapped or excluded', () => {
    const diff = [
      entry({ localId: 'r', action: 'reuse', existingAdoId: 5 }),
      entry({ localId: 'd', action: 'dedup_skip', existingAdoId: 6 }),
      entry({ localId: 'm' }),
      entry({ localId: 'x', excluded: true }),
      entry({ localId: 'c1', parentLocalId: 'r' }),
      entry({ localId: 'c2', parentLocalId: 'd' }),
      entry({ localId: 'c3', parentLocalId: 'm' }),
      entry({ localId: 'c4', parentLocalId: 'x' }),
    ];
    expect(orphans(diff, ['c1', 'c2', 'c3', 'c4'], [['m', 9]])).toEqual([]);
  });

  it('finds ids missing from the diff', () => {
    const diff = [entry({ localId: 'a' })];
    expect(findUnknownSelections(diff, ['a', 'zz', 'yy'])).toEqual(['zz', 'yy']);
  });
});

describe('buildWritePreview figuresOnly', () => {
  const figureResume = (figures: string[]) => ({
    resumedAdoIdByLocalId: new Map<string, number>([['res', 50]]),
    alreadyLinkedLocalIds: new Set<string>(['res']),
    pendingFigureIds: new Set(figures),
  });

  it('figuresOnly is true only when nothing else is left', () => {
    // Only a resumed, already-linked item with a stored figure remains: figures are all that is left.
    const onlyFigures = buildWritePreview([entry({ localId: 'res', figureIds: ['f1'] })], figureResume(['f1']), []);
    expect(onlyFigures.figuresOnly).toBe(true);
    expect(onlyFigures.hasWork).toBe(true);

    // Something to create as well: not figures-only.
    const withCreate = buildWritePreview(
      [entry({ localId: 'res', figureIds: ['f1'] }), entry({ localId: 'new' })],
      figureResume(['f1']),
    );
    expect(withCreate.figuresOnly).toBe(false);

    // Nothing left at all: not figures-only (and no work).
    const nothing = buildWritePreview([entry({ localId: 'res' })], figureResume([]), []);
    expect(nothing.figuresOnly).toBe(false);
    expect(nothing.hasWork).toBe(false);

    // A link still to add alongside the figures: not figures-only.
    const withLink = buildWritePreview(
      [entry({ localId: 'res', figureIds: ['f1'] }), entry({ localId: 'kid', parentLocalId: 'res', action: 'reuse', existingAdoId: 9 })],
      { ...figureResume(['f1']), alreadyLinkedLocalIds: new Set<string>() },
      [],
    );
    expect(withLink.figuresOnly).toBe(withLink.createdTotal === 0 && withLink.parentLinks === 0 && withLink.traceLinks.planned === 0 && withLink.figuresToAttach > 0);
  });
});
