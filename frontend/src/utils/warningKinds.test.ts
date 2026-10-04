import { describe, it, expect } from 'vitest';
import type { WarningRecord } from './warnings';
import { KIND_META, buildKindGroups, isActionableWarning, kindGroupCount, kindMeta, kindProgress, retryableEnhancementBatches, warningGroup } from './warningKinds';

function warning(kind: string, severity: WarningRecord['severity'], nodeIds: string[] = []): WarningRecord {
  return { kind, severity, nodeIds, detail: {}, raw: `${kind} raw` };
}

describe('warningKinds', () => {
  it('groups by action, not by ingestion severity', () => {
    expect(warningGroup(warning('enhancement_call_failed', 'pipeline_issue'))).toBe('info');
    expect(warningGroup(warning('missing_source_reference', 'needs_review'))).toBe('fix');
    expect(warningGroup(warning('low_grounding', 'needs_review'))).toBe('review');
    expect(warningGroup(warning('reparented_to_feature', 'auto_fixed'))).toBe('info');
  });

  it('only counts fix and review kinds as actionable', () => {
    expect(isActionableWarning(warning('enhancement_call_failed', 'pipeline_issue'))).toBe(false);
    expect(isActionableWarning(warning('zero_nodes', 'pipeline_issue'))).toBe(true);
    expect(isActionableWarning(warning('low_grounding', 'needs_review'))).toBe(true);
  });

  it('falls back an unknown kind by severity: resolved stays informational, anything else needs a human', () => {
    expect(kindMeta('brand_new', 'auto_fixed').group).toBe('info');
    expect(kindMeta('brand_new', 'needs_review').group).toBe('review');
    expect(kindMeta('brand_new', 'pipeline_issue').group).toBe('review');
    expect(kindMeta('brand_new').title).toBe('Brand New');
  });

  it('gives every known kind complete copy', () => {
    for (const [kind, meta] of Object.entries(KIND_META)) {
      expect(meta.title, kind).not.toBe('');
      expect(meta.short, kind).not.toBe('');
      expect(meta.means, kind).not.toBe('');
      expect(meta.todo, kind).not.toBe('');
      expect(meta.chip, kind).not.toBe('');
    }
  });

  it('builds one entry per kind, ordered fix then review then info, with de-duplicated item ids', () => {
    const entries = buildKindGroups([
      warning('reparented_to_feature', 'auto_fixed', ['a']),
      warning('low_grounding', 'needs_review', ['b', 'c']),
      warning('low_grounding', 'needs_review', ['c', 'd']),
      warning('zero_nodes', 'pipeline_issue'),
    ]);

    expect(entries.map((e) => e.kind)).toEqual(['zero_nodes', 'low_grounding', 'reparented_to_feature']);
    const grounding = entries.find((e) => e.kind === 'low_grounding')!;
    expect(grounding.records).toHaveLength(2);
    expect(grounding.nodeIds).toEqual(['b', 'c', 'd']);
  });

  it('counts items when a kind has item ids, otherwise records by the kind\'s own unit', () => {
    const [withItems] = buildKindGroups([warning('low_grounding', 'needs_review', ['a', 'b'])]);
    expect(kindGroupCount(withItems)).toEqual({ count: 2, label: 'items' });

    const [oneRecord] = buildKindGroups([warning('dropped_blocks', 'needs_review')]);
    expect(kindGroupCount(oneRecord)).toEqual({ count: 1, label: 'section' });

    const [twoRecords] = buildKindGroups([warning('dropped_blocks', 'needs_review'), warning('dropped_blocks', 'needs_review')]);
    expect(kindGroupCount(twoRecords)).toEqual({ count: 2, label: 'sections' });
  });

  describe('kindProgress', () => {
    const one = (kind: string, severity: WarningRecord['severity'], nodeIds: string[], extra: Partial<WarningRecord> = {}) =>
      buildKindGroups([{ ...warning(kind, severity, nodeIds), ...extra }])[0];

    it('is not trackable for an informational kind -- there is nothing to finish', () => {
      const entry = one('enhancement_call_failed', 'pipeline_issue', ['a']);
      expect(kindProgress(entry, new Set(['a']))).toMatchObject({ trackable: false, complete: false });
    });

    it('counts reviewed items of a kind that has them, and completes when all are reviewed', () => {
      const entry = one('low_grounding', 'needs_review', ['a', 'b', 'c']);

      expect(kindProgress(entry, new Set(['a']))).toMatchObject({ trackable: true, reviewed: 1, total: 3, complete: false });
      expect(kindProgress(entry, new Set(['a', 'b', 'c', 'unrelated']))).toMatchObject({ reviewed: 3, total: 3, complete: true });
      expect(kindProgress(entry)).toMatchObject({ reviewed: 0, complete: false });
    });

    it('completes an items kind when every record was acknowledged, without any item reviewed', () => {
      const entry = one('low_grounding', 'needs_review', ['a', 'b'], { acknowledged: true });

      expect(kindProgress(entry, new Set())).toMatchObject({ complete: true, allAcknowledged: true });
    });

    it('tracks a kind without items through its own records\' acknowledged flag', () => {
      const entry = buildKindGroups([
        { ...warning('dropped_blocks', 'needs_review'), raw: 'a', acknowledged: true },
        { ...warning('dropped_blocks', 'needs_review'), raw: 'b' },
      ])[0];

      expect(kindProgress(entry)).toMatchObject({ trackable: true, reviewed: 1, total: 2, complete: false, allAcknowledged: false });
    });
  });

  describe('retryableEnhancementBatches', () => {
    const rec = (kind: string, pass: string | undefined, nodeIds: string[]): WarningRecord => ({
      kind, severity: 'pipeline_issue', nodeIds, detail: pass ? { pass } : {}, raw: 'x',
    });

    it('groups a kind\'s item ids by the pass that failed', () => {
      const [entry] = buildKindGroups([
        rec('enhancement_call_failed', 'title_tag', ['a', 'b']),
        rec('enhancement_call_failed', 'synthesis', ['c']),
        rec('enhancement_call_failed', 'title_tag', ['b', 'd']),
      ]);

      expect(retryableEnhancementBatches(entry)).toEqual([
        { pass: 'title_tag', localIds: ['a', 'b', 'd'] },
        { pass: 'synthesis', localIds: ['c'] },
      ]);
    });

    it('leaves out parent_summary, which can only be fixed by a resubmit, and records without a pass', () => {
      const [entry] = buildKindGroups([
        rec('enhancement_call_failed', 'parent_summary', ['a']),
        rec('enhancement_call_failed', undefined, ['b']),
      ]);

      expect(retryableEnhancementBatches(entry)).toEqual([]);
    });

    it('offers nothing for any other kind', () => {
      const [entry] = buildKindGroups([rec('scoring_failed', 'title_tag', ['a'])]);

      expect(retryableEnhancementBatches(entry)).toEqual([]);
    });
  });
});
