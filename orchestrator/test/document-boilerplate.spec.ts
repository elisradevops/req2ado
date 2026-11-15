import { dropNoticeIdsFromMissingIdWarning, excludeBoilerplate, findBoilerplateIds } from '../src/modules/pipeline/document-boilerplate';

const req = (localId: string, title: string, description = '', extra: Record<string, unknown> = {}) => ({
  localId, type: 'Requirement', title, description, action: 'create', ...extra,
});

describe('findBoilerplateIds', () => {
  it.each([
    ['a mock-data banner', 'Mock / Anonymized Test Data', ''],
    ['a disclaimer', 'Disclaimer', 'This document is provided for information only and carries no warranty.'],
    ['a confidentiality notice', 'Confidentiality Notice', 'Proprietary and confidential. Do not distribute.'],
    ['a copyright line', 'Copyright 2026 Example Ltd', 'All rights reserved.'],
    ['a revision table heading', 'Revision History', ''],
    ['a distribution list', 'Distribution List', ''],
  ])('flags %s', (_name, title, description) => {
    expect(findBoilerplateIds([req('b', title, description)])).toEqual(['b']);
  });

  it('never flags text that states an obligation, whatever else it says', () => {
    const entries = [
      req('n1', 'Confidentiality', 'The system shall mark every exported file as confidential.'),
      req('n2', 'Disclaimer handling', 'The unit must display a disclaimer at start-up.'),
      req('n3', 'Copyright', 'Software is required to show its copyright line.'),
    ];
    expect(findBoilerplateIds(entries)).toEqual([]);
  });

  it('does not flag an ordinary requirement that merely mentions a notice word later in its text', () => {
    expect(findBoilerplateIds([req('o', 'Logging', 'Faults are logged. Confidential data is excluded from the log.')])).toEqual([]);
  });

  it('only looks at Requirements to be created: Epics, Features and reused items are left alone', () => {
    const entries = [
      { ...req('e', 'Disclaimer'), type: 'Epic' },
      { ...req('f', 'Revision History'), type: 'Feature' },
      { ...req('r', 'Disclaimer'), action: 'reuse' },
      req('c', 'Disclaimer'),
    ];
    expect(findBoilerplateIds(entries)).toEqual(['c']);
  });

  it('ignores a long text: boilerplate notices are short, and a long one is more likely a real section', () => {
    expect(findBoilerplateIds([req('l', 'Disclaimer', 'x '.repeat(400))])).toEqual([]);
  });
});

describe('excludeBoilerplate', () => {
  const diff = [req('b', 'Disclaimer'), req('r', 'Logging', 'The unit shall log every fault.')];

  it('in SURVEY excludes the boilerplate item by default, leaves the rest, and says so in an Info warning naming the item', () => {
    const result = excludeBoilerplate(diff, 'survey');
    expect(result.diff.map((entry) => [entry.localId, (entry as { excluded?: boolean }).excluded ?? false])).toEqual([['b', true], ['r', false]]);
    expect(result.warning).toMatchObject({ kind: 'boilerplate_excluded', severity: 'pipeline_issue', nodeIds: ['b'] });
    expect(result.warning?.raw).toMatch(/1 item .*left out/i);
  });

  it('leaves BASELINE (verbatim) untouched, and a diff with nothing to leave out unchanged with no warning', () => {
    expect(excludeBoilerplate(diff, 'baseline')).toEqual({ diff, warning: null });
    const clean = [req('r', 'Logging', 'The unit shall log every fault.')];
    expect(excludeBoilerplate(clean, 'survey')).toEqual({ diff: clean, warning: null });
  });

  it('does not touch an item the reviewer already excluded or included on purpose', () => {
    const decided = [req('b', 'Disclaimer', '', { excluded: false, reviewed: true })];
    expect(excludeBoilerplate(decided, 'survey').diff).toEqual(decided);
  });
});

describe('dropNoticeIdsFromMissingIdWarning', () => {
  const warn = (kind: string, nodeIds: string[]) => ({ kind, severity: 'needs_review' as const, nodeIds, detail: {}, raw: kind });

  it('removes a left-out notice from the missing Customer ID warning, and drops the warning when nothing else is named', () => {
    const result = dropNoticeIdsFromMissingIdWarning([warn('missing_source_reference', ['b', 'r']), warn('missing_source_reference', ['b'])], ['b']);
    expect(result.map((w) => [w.kind, w.nodeIds])).toEqual([['missing_source_reference', ['r']]]);
  });

  it('leaves other warning kinds, and a warning that names no item, alone', () => {
    const others = [warn('duplicate_customer_id', ['b']), warn('missing_source_reference', [])];
    expect(dropNoticeIdsFromMissingIdWarning(others, ['b'])).toEqual(others);
  });
});
