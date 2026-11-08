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
