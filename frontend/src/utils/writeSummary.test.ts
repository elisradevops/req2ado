import { describe, expect, it } from 'vitest';
import type { WritePreview } from '../api/jobs';
import { countWarningsForWrite, writeSummaryLines } from './writeSummary';

const preview = (overrides: Partial<WritePreview> = {}): WritePreview => ({
  createdTotal: 4,
  createdLocalIds: ['a', 'b', 'c', 'd'],
  createdByType: { Epic: 1, Feature: 1, Requirement: 2 },
  excluded: { direct: 0, viaAncestor: 0 },
  parentLinks: 3,
  existingGettingChildren: 0,
  existingWithoutNewParentLink: 0,
  traceLinks: { planned: 0, skipped: 0 },
  ...overrides,
});
const noBreakdown = { edited: 0, single: 0, bulk: 0, bulkSpotChecked: 0, earlier: 0, notReviewed: 0 };

describe('writeSummaryLines', () => {
  it('lists new items by type in tree order with the parent links', () => {
    const lines = writeSummaryLines(preview(), noBreakdown);
    expect(lines.find((l) => l.id === 'create')?.text).toBe('4 new work items: 1 Epic, 1 Feature, 2 Requirements.');
    expect(lines.find((l) => l.id === 'parent-links')?.text).toBe('3 parent links will be added.');
  });

  it('says excluded items, including those dropped through an excluded parent', () => {
    const lines = writeSummaryLines(preview({ excluded: { direct: 2, viaAncestor: 5 } }), noBreakdown);
    expect(lines.find((l) => l.id === 'excluded')?.text).toBe('7 items left out: 2 excluded by you, 5 under an excluded parent.');
  });

  it('flags existing items that get children without a new parent link, as a notice', () => {
    const lines = writeSummaryLines(preview({ existingGettingChildren: 2, existingWithoutNewParentLink: 3 }), noBreakdown);
    const line = lines.find((l) => l.id === 'existing');
    expect(line?.text).toBe(
      '2 existing items will get new children. 3 existing items keep their current parent: no parent link is added to them.',
    );
    expect(line?.tone).toBe('notice');
  });

  it('reports trace links that are written and ones that are not', () => {
    const lines = writeSummaryLines(preview({ traceLinks: { planned: 4, skipped: 2 } }), noBreakdown);
    expect(lines.find((l) => l.id === 'trace-links')?.text).toBe(
      '4 trace links will be added. 2 trace links will not be added because the linked item is excluded, not written or not resolved.',
    );
  });

  it('omits lines that have nothing to say', () => {
    const ids = writeSummaryLines(preview({ createdTotal: 1, createdByType: { Requirement: 1 }, parentLinks: 0 }), noBreakdown).map((l) => l.id);
    expect(ids).toEqual(['create']);
  });

  it('describes how the items were reviewed in this session', () => {
    const lines = writeSummaryLines(preview(), { edited: 1, single: 2, bulk: 1, bulkSpotChecked: 3, earlier: 0, notReviewed: 4 });
    expect(lines.find((l) => l.id === 'review')?.text).toBe(
      'Review: 1 edited, 2 approved one by one, 3 approved in bulk after you looked at them, 1 approved in bulk without being looked at, 4 not reviewed.',
    );
    expect(lines.find((l) => l.id === 'review')?.tone).toBe('notice');
  });

  it('shows no review line when every item is reviewed earlier or there is nothing to say', () => {
    expect(writeSummaryLines(preview({ createdTotal: 0, createdLocalIds: [], createdByType: {} }), noBreakdown).some((l) => l.id === 'review')).toBe(false);
  });

  it('says a write of zero items creates nothing', () => {
    const lines = writeSummaryLines(preview({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 0 }), noBreakdown);
    expect(lines[0]).toMatchObject({ id: 'create', text: 'Nothing will be created.', tone: 'notice' });
  });
});

describe('countWarningsForWrite', () => {
  it('counts open fix and review warnings and the ones marked handled', () => {
    const result = countWarningsForWrite([
      { kind: 'missing_source_reference', severity: 'error', raw: 'a', nodeIds: [], detail: {}, acknowledged: false },
      { kind: 'missing_source_reference', severity: 'error', raw: 'b', nodeIds: [], detail: {}, acknowledged: true },
    ]);
    expect(result.handled).toBe(1);
    expect(result.open.fix + result.open.review + result.open.info).toBe(1);
  });
});
