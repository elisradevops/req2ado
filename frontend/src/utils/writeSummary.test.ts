import { describe, expect, it } from 'vitest';
import type { WritePreview } from '../api/jobs';
import { countWarningsForWrite, isFiguresOnlyWrite, writeHasWork, writeSummaryLines } from './writeSummary';

const preview = (overrides: Partial<WritePreview> = {}): WritePreview => ({
  createdTotal: 4,
  createdLocalIds: ['a', 'b', 'c', 'd'],
  createdByType: { Epic: 1, Feature: 1, Requirement: 2 },
  excluded: { direct: 0, viaAncestor: 0 },
  parentLinks: 3,
  existingGettingChildren: 0,
  existingWithoutNewParentLink: 0,
  traceLinks: { planned: 0, skipped: 0 },
  alreadyWritten: 0,
  figuresToAttach: 0,
  figuresUnavailable: 0,
  hasWork: true,
  figuresOnly: false,
  ...overrides,
});
const noBreakdown = { edited: 0, single: 0, bulk: 0, bulkSpotChecked: 0, group: 0, earlier: 0, notReviewed: 0 };

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
    const lines = writeSummaryLines(preview(), { edited: 1, single: 2, bulk: 1, bulkSpotChecked: 3, group: 0, earlier: 0, notReviewed: 4 });
    expect(lines.find((l) => l.id === 'review')?.text).toBe(
      'Review: 1 edited, 2 approved one by one, 3 approved in bulk after you looked at them, 1 approved in bulk without being looked at, 4 not reviewed.',
    );
    expect(lines.find((l) => l.id === 'review')?.tone).toBe('notice');
  });

  it('shows no review line when every item is reviewed earlier or there is nothing to say', () => {
    expect(writeSummaryLines(preview({ createdTotal: 0, createdLocalIds: [], createdByType: {} }), noBreakdown).some((l) => l.id === 'review')).toBe(false);
  });

  it('words the group method as marked reviewed from a warning list, between single and bulk', () => {
    const lines = writeSummaryLines(preview(), { ...noBreakdown, single: 1, group: 2, bulk: 1 });
    expect(lines.find((l) => l.id === 'review')?.text).toBe(
      'Review: 1 approved one by one, 2 marked reviewed from a warning list, 1 approved in bulk without being looked at.',
    );
    const groupOnly = writeSummaryLines(preview(), { ...noBreakdown, group: 2 }).find((l) => l.id === 'review');
    expect(groupOnly?.tone).toBe('plain');
  });

  describe('a retry with nothing new to create', () => {
    const retry = (overrides: Partial<WritePreview> = {}) =>
      preview({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 2, alreadyWritten: 5, ...overrides });

    it('says what remains and how many items are already written', () => {
      const line = writeSummaryLines(retry(), noBreakdown)[0];
      expect(line).toMatchObject({ id: 'create', text: 'Nothing new to create; 2 parent links remain. 5 items are already written.', tone: 'plain' });
    });

    it('mentions planned trace links in the same sentence', () => {
      const line = writeSummaryLines(retry({ traceLinks: { planned: 1, skipped: 0 } }), noBreakdown)[0];
      expect(line.text).toBe('Nothing new to create; 2 parent links and 1 trace link remain. 5 items are already written.');
    });

    it('uses singular forms and omits the already-written sentence when none', () => {
      expect(writeSummaryLines(retry({ parentLinks: 1, alreadyWritten: 1 }), noBreakdown)[0].text).toBe(
        'Nothing new to create; 1 parent link remains. 1 item is already written.',
      );
      expect(writeSummaryLines(retry({ parentLinks: 0, alreadyWritten: 0, traceLinks: { planned: 1, skipped: 0 } }), noBreakdown)[0].text).toBe(
        'Nothing new to create; 1 trace link remains.',
      );
    });
  });

  it('says a write of zero items creates nothing', () => {
    const lines = writeSummaryLines(preview({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 0 }), noBreakdown);
    expect(lines[0]).toMatchObject({ id: 'create', text: 'Nothing will be created.', tone: 'notice' });
  });
});

describe('writeSummaryLines with figures', () => {
  const figuresOnly = (n: number) =>
    preview({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 0, figuresToAttach: n, figuresOnly: true });

  it('figures-only summary uses plain create line, figures line and advisory', () => {
    const lines = writeSummaryLines(figuresOnly(36), noBreakdown);
    expect(lines.find((l) => l.id === 'create')).toMatchObject({ text: 'No new items will be created.', tone: 'plain' });
    expect(lines.find((l) => l.id === 'figures')).toMatchObject({
      text: '36 figures will be attached to their items in Azure DevOps.',
      tone: 'plain',
    });
    expect(lines.map((l) => l.id)).toEqual(['create', 'figures', 'figures-advisory']);
    expect(lines.find((l) => l.id === 'figures-advisory')).toMatchObject({
      text: 'Figures are attached by position. Check each one next to its item before you write.',
      tone: 'plain',
    });
    expect(lines.some((l) => /Nothing will be created/.test(l.text))).toBe(false);
    expect(writeSummaryLines(figuresOnly(1), noBreakdown).find((l) => l.id === 'figures')?.text).toBe(
      '1 figure will be attached to its item in Azure DevOps.',
    );
  });

  it('links and figures summary', () => {
    const lines = writeSummaryLines(figuresOnly(3), noBreakdown);
    const both = writeSummaryLines(preview({ ...figuresOnly(3), parentLinks: 2, figuresOnly: false }), noBreakdown);
    expect(lines.length).toBe(3);
    expect(both.find((l) => l.id === 'create')?.text).toBe('Nothing new to create; 2 parent links remain.');
    expect(both.find((l) => l.id === 'figures')?.text).toBe('3 figures will be attached.');
    expect(both.some((l) => l.id === 'figures-advisory')).toBe(true);
  });

  it('links-only summary unchanged', () => {
    const lines = writeSummaryLines(preview({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 2 }), noBreakdown);
    expect(lines.map((l) => l.id)).toEqual(['create', 'parent-links']);
    expect(lines[0].text).toBe('Nothing new to create; 2 parent links remain.');
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

describe('writeHasWork', () => {
  it('writeHasWork reads the server flag', () => {
    // Counts say there is work, the flag says there is not: the flag wins.
    expect(writeHasWork(preview({ figuresToAttach: 2, hasWork: false }))).toBe(false);
    expect(writeHasWork(preview({ createdTotal: 0, parentLinks: 0, hasWork: true }))).toBe(true);
  });

  it('isFiguresOnlyWrite reads the server flag', () => {
    expect(isFiguresOnlyWrite(preview({ figuresOnly: true }))).toBe(true);
    expect(isFiguresOnlyWrite(preview({ createdTotal: 0, parentLinks: 0, figuresToAttach: 2, figuresOnly: false }))).toBe(false);
  });

  it('the summary lines follow the figures-only flag', () => {
    const only = preview({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 0, figuresToAttach: 2, figuresOnly: true });
    expect(writeSummaryLines(only, noBreakdown).find((l) => l.id === 'create')?.text).toBe('No new items will be created.');
  });
});

describe('writeSummaryLines with unavailable figures', () => {
  it('shows the unavailable line with notice tone (plural and singular)', () => {
    const plural = writeSummaryLines(preview({ figuresToAttach: 2, figuresUnavailable: 3 }), noBreakdown);
    expect(plural.find((l) => l.id === 'figures-unavailable')).toEqual({
      id: 'figures-unavailable',
      text: '3 figures could not be loaded and will not be attached.',
      tone: 'notice',
    });
    const ids = plural.map((l) => l.id);
    expect(ids.indexOf('figures-unavailable')).toBe(ids.indexOf('figures-advisory') + 1);
    expect(writeSummaryLines(preview({ figuresUnavailable: 1 }), noBreakdown).find((l) => l.id === 'figures-unavailable')?.text).toBe(
      '1 figure could not be loaded and will not be attached.',
    );
  });

  it('omits it at 0', () => {
    expect(writeSummaryLines(preview(), noBreakdown).some((l) => l.id === 'figures-unavailable')).toBe(false);
  });

  it('does not change hasWork', () => {
    const none = preview({ createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 0, figuresUnavailable: 5, hasWork: false });
    expect(writeHasWork(none)).toBe(false);
  });
});
