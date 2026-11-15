import { describe, it, expect } from 'vitest';
import type { WarningRecord } from './warnings';
import { KIND_META, RETRY_ENHANCEMENT_BATCH_SIZE, acknowledgementClears, buildKindGroups, isActionableWarning, kindGroupCount, kindMeta, kindProgress, retryableEnhancementBatches, warningGroup } from './warningKinds';

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

  it('an auto_fixed parent_title_collision is informational', () => {
    const resolved = warning('parent_title_collision', 'auto_fixed', ['a']);
    expect(warningGroup(resolved)).toBe('info');
    expect(isActionableWarning(resolved)).toBe(false);
    const groups = buildKindGroups([resolved]);
    expect(groups[0].group).toBe('info');
  });

  it('a needs_review parent_title_collision stays in the fix group', () => {
    const open = warning('parent_title_collision', 'needs_review', ['a']);
    expect(warningGroup(open)).toBe('fix');
    expect(isActionableWarning(open)).toBe(true);
    expect(buildKindGroups([open])[0].group).toBe('fix');
  });

  it('a kind with one open record and one auto_fixed record stays actionable', () => {
    const groups = buildKindGroups([
      warning('parent_title_collision', 'auto_fixed', ['a']),
      warning('parent_title_collision', 'needs_review', ['b']),
    ]);
    expect(groups[0].group).toBe('fix');
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

  it('explains criteria left out for ungrounded values, as a review item, never as a failed call', () => {
    const meta = KIND_META.criteria_value_ungrounded;
    expect(meta.group).toBe('review');
    expect(meta.short).toMatch(/not found in the document/i);
    expect(meta.means).toMatch(/nothing wrong was written/i);
    expect(meta.todo).toMatch(/by hand/i);
    expect(warningGroup(warning('criteria_value_ungrounded', 'needs_review'))).toBe('review');
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

  it('explains a run whose figures were not described, instead of the generic fallback copy', () => {
    const meta = KIND_META.vision_captioning_disabled;
    expect(meta.group).toBe('review');
    expect(meta.title).toBe('Figures were not described');
    expect(meta.todo).toMatch(/model can read images/i);
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

    it('never completes a per-item Fix kind with affected items through acknowledgement: only item decisions clear it (§11.3.6)', () => {
      // Records acknowledged before the write gate existed (or by any old client) carry acknowledged: true on a per-item Fix kind.
      const legacy = one('duplicate_customer_id', 'needs_review', ['a', 'b'], { acknowledged: true });

      expect(kindProgress(legacy, new Set())).toMatchObject({ trackable: true, reviewed: 0, total: 2, complete: false, allAcknowledged: true });
      expect(kindProgress(legacy, new Set(['a']))).toMatchObject({ reviewed: 1, complete: false });
      expect(kindProgress(legacy, new Set(['a', 'b']))).toMatchObject({ reviewed: 2, complete: true });
    });

    it('lets a kind_counted Fix kind be cleared by its one counted acknowledgement', () => {
      const counted = one('missing_source_reference', 'needs_review', ['a', 'b'], { acknowledged: true });
      expect(kindProgress(counted, new Set())).toMatchObject({ complete: true, allAcknowledged: true });
    });

    it('lets an item-less Fix kind be cleared notice by notice', () => {
      const entry = buildKindGroups([
        { ...warning('zero_nodes', 'pipeline_issue'), raw: 'a', acknowledged: true },
        { ...warning('zero_nodes', 'pipeline_issue'), raw: 'b', acknowledged: true },
      ])[0];
      expect(entry.group).toBe('fix');
      expect(kindProgress(entry)).toMatchObject({ reviewed: 2, total: 2, complete: true });
    });

    it('says which kinds acknowledgement may clear', () => {
      expect(acknowledgementClears(one('duplicate_customer_id', 'needs_review', ['a']))).toBe(false);
      expect(acknowledgementClears(one('missing_source_reference', 'needs_review', ['a']))).toBe(true);
      expect(acknowledgementClears(one('low_grounding', 'needs_review', ['a']))).toBe(true);
      expect(acknowledgementClears(buildKindGroups([warning('zero_nodes', 'pipeline_issue')])[0])).toBe(true);
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

    it('offers parent_summary as its own batch group, and skips records without a pass or with an unknown one', () => {
      const [entry] = buildKindGroups([
        rec('enhancement_call_failed', 'parent_summary', ['a']),
        rec('enhancement_call_failed', undefined, ['b']),
        rec('enhancement_call_failed', 'scoring', ['c']),
      ]);

      expect(retryableEnhancementBatches(entry)).toEqual([{ pass: 'parent_summary', localIds: ['a'] }]);
    });

    it('sends parent_summary in smaller batches than the leaf passes', () => {
      expect(RETRY_ENHANCEMENT_BATCH_SIZE.parent_summary).toBeLessThan(RETRY_ENHANCEMENT_BATCH_SIZE.title_tag);
      expect(RETRY_ENHANCEMENT_BATCH_SIZE.parent_summary).toBeLessThanOrEqual(25); // the server's cap
    });

    it('offers nothing for any other kind', () => {
      const [entry] = buildKindGroups([rec('scoring_failed', 'title_tag', ['a'])]);

      expect(retryableEnhancementBatches(entry)).toEqual([]);
    });
  });
});


describe('document_study_incomplete', () => {
  it('has its own plain-language entry that says what was not read, not "enhanced wording unavailable"', async () => {
    const { KIND_META } = await import('./warningKinds');
    const entry = (KIND_META as Record<string, { title: string; short: string; means: string; group: string }>).document_study_incomplete;
    expect(entry).toBeDefined();
    expect(entry.title).toMatch(/study/i);
    expect(entry.short).toMatch(/not read|did not read|unread/i);
    expect(entry.means).toMatch(/nothing is missing from the tree|tree itself/i);
    expect(entry.group).toBe('info');
  });
});

describe('dedup_check_failed', () => {
  it('tells the reviewer the duplicate check did not run, what that means, and what to do', () => {
    const meta = kindMeta('dedup_check_failed');

    expect(meta.title).toMatch(/duplicate check/i);
    expect(meta.means).toMatch(/created as new|without/i);
    expect(meta.todo).toMatch(/azure devops|search/i);
    expect(meta.group).toBe('review');
  });
});


describe('KIND_META wording (DESIGN.md §12)', () => {
  it('never tells the reviewer to "confirm": the write is "Write to Azure DevOps"', () => {
    for (const [kind, meta] of Object.entries(KIND_META)) {
      for (const text of [meta.title, meta.short, meta.means, meta.todo, meta.chip]) {
        expect(text, `${kind}: ${text}`).not.toMatch(/\bconfirm\b/i);
      }
    }
  });
});

describe('retryableEnhancementBatches stays linear', () => {
  it('dedupes 30,000 ids across records in well under a second, keeping first-seen order', () => {
    const rec = (ids: string[]): WarningRecord => ({ kind: 'enhancement_call_failed', severity: 'pipeline_issue', nodeIds: ids, detail: { pass: 'title_tag' }, raw: 'x' });
    const a = Array.from({ length: 20000 }, (_, i) => `n${i}`);
    const b = Array.from({ length: 20000 }, (_, i) => `n${i + 10000}`); // overlaps the last 10,000 of `a`
    const group = buildKindGroups([rec(a), rec(b)])[0];
    const started = performance.now();
    const batches = retryableEnhancementBatches(group);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(batches).toHaveLength(1);
    expect(batches[0].localIds).toHaveLength(30000);
    expect(batches[0].localIds.slice(0, 3)).toEqual(['n0', 'n1', 'n2']);
    expect(batches[0].localIds.at(-1)).toBe('n29999');
  });
});

describe('overview_reused', () => {
  it('is information only: it never blocks a write', () => {
    expect(KIND_META.overview_reused.group).toBe('info');
  });
});

describe('requirement_heading_is_section', () => {
  it('is a Check notice: it explains a count, it never blocks the write', () => {
    expect(KIND_META.requirement_heading_is_section.group).toBe('review');
    expect(KIND_META.requirement_heading_is_section.ackPolicy ?? 'per_item').toBe('per_item');
  });

  it('says in plain words why the tree has fewer Requirements than the document has statements', () => {
    const meta = KIND_META.requirement_heading_is_section;
    expect(meta.title).toBe('Statement kept as a section');
    expect(meta.short).toMatch(/sub-sections/i);
    expect(meta.means).toMatch(/top of/i);
  });
});

describe('changed_since_written', () => {
  it('is a Check notice that never blocks the write', () => {
    const meta = KIND_META.changed_since_written;
    expect(meta.group).toBe('review');
    expect(warningGroup(warning('changed_since_written', 'needs_review', ['a']))).toBe('review');
  });

  it('says the item matches one already in Azure DevOps whose text differs, that nothing is updated, and what to do', () => {
    const meta = KIND_META.changed_since_written;
    expect(meta.title).toBe('Changed since it was written');
    expect(meta.means).toMatch(/already in Azure DevOps/i);
    expect(meta.means).toMatch(/nothing is updated automatically/i);
    expect(meta.todo).toMatch(/by hand|leave it/i);
  });

  it('boilerplate_excluded is an Info notice that names what was left out and says it can be included again', () => {
    const meta = kindMeta('boilerplate_excluded');
    expect(meta.group).toBe('info');
    expect(meta.title).toBe('Notices left out');
    expect(meta.todo).toMatch(/include/i);
  });
});
