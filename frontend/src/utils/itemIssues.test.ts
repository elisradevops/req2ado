import { describe, it, expect } from 'vitest';
import { itemIssues } from './itemIssues';
import { missingValuesOf } from './proposal';

describe('itemIssues', () => {
  it('is empty for a clean requirement', () => {
    expect(itemIssues({ type: 'Requirement', qualityScore: 90, groundingScore: 0.9 })).toEqual([]);
  });

  it('says a low score in one sentence with the weakest category in words', () => {
    const [issue] = itemIssues({ type: 'Requirement', qualityScore: 42, qualityCategoryScores: { testability: 35, clarity: 80 } });
    expect(issue.text).toBe('Quality 42 of 100. Weakest: testability (35).');
  });

  it('drops trailing punctuation from an organisation\'s category name', () => {
    const [issue] = itemIssues({ type: 'Requirement', qualityScore: 45, qualityCategoryScores: { 'Verifiable?': 20 } });
    expect(issue.text).toBe('Quality 45 of 100. Weakest: verifiable (20).');
  });

  it('gives an Epic or Feature no score, confidence or source-overlap issue, whatever the data holds', () => {
    for (const type of ['Epic', 'Feature']) {
      expect(itemIssues({ type, qualityScore: 5, qualityConfidence: 'low', groundingScore: 0.01, qualityCategoryScores: { capabilityClarity: 1 } })).toEqual([]);
    }
  });

  it('names the missing values of a needs-input note, and says it plainly when none are known', () => {
    const named = '<div><p><b>Needs author input</b></p><p>Unresolved value(s) in this requirement: <span data-missing-value="TBD">TBD</span>, <span data-missing-value="XXX">XXX</span>. Acceptance criteria were not proposed.</p></div>';
    expect(itemIssues({ type: 'Requirement', proposal: { kind: 'needs-input', html: named } })[0].text).toBe('Missing value in the source: TBD, XXX. Ask the author.');
    const bare = '<div><p><b>Needs author input</b></p><p>This requirement needs a value that the text does not provide. Acceptance criteria were not proposed.</p></div>';
    expect(itemIssues({ type: 'Requirement', proposal: { kind: 'needs-input', html: bare } })[0].text).toBe('The source leaves a value open. Ask the author.');
  });

  it('shows a stale score as stale, not as a low score', () => {
    const issues = itemIssues({ type: 'Requirement', qualityScore: 10, qualityStale: true });
    expect(issues.map((issue) => issue.id)).toEqual(['stale']);
  });

  it('never uses the words verdict or grounding', () => {
    const text = itemIssues({ type: 'Requirement', qualityScore: 20, qualityConfidence: 'low', groundingScore: 0.05 }).map((i) => i.text).join(' ');
    expect(text).not.toMatch(/verdict|grounding/i);
  });
});

describe('missingValuesOf', () => {
  it('reads the marked values, and falls back to the sentence of an older job', () => {
    expect(missingValuesOf('<p><span data-missing-value="TBD">TBD</span></p>')).toEqual(['TBD']);
    expect(missingValuesOf('<div><p>Unresolved value(s) in this requirement: TBD, ??. Acceptance criteria were not proposed.</p></div>')).toEqual(['TBD', '??']);
    expect(missingValuesOf(undefined)).toEqual([]);
  });
});

describe('itemIssues with a long organisation-defined category name', () => {
  it('keeps the line short and puts the full name under Why', () => {
    const long = 'Numerical limits include units, tolerances, and measurement point.';
    const [issue] = itemIssues({ type: 'Requirement', qualityScore: 45, qualityCategoryScores: { [long]: 30 } });
    expect(issue.text.length).toBeLessThan(90);
    expect(issue.text).toMatch(/^Quality 45 of 100\. Weakest: numerical limits include units, tolerances, and… \(30\)\.$/);
    expect(issue.why).toBe('The weakest check is "numerical limits include units, tolerances, and measurement point", at 30 of 100.');
  });

  it('adds no Why for a short name', () => {
    const [issue] = itemIssues({ type: 'Requirement', qualityScore: 45, qualityCategoryScores: { testability: 30 } });
    expect(issue.why).toBeUndefined();
  });
});

describe('itemIssues: a suggestion kept with the item', () => {
  it('is an issue while nobody decided on it, and not after it was accepted, rejected or parked', () => {
    const waiting = itemIssues({ type: 'Requirement', suggestion: { decision: 'pending' } });
    expect(waiting).toEqual([expect.objectContaining({ id: 'suggestion-waiting', severity: 'review', reviewable: true })]);
    for (const decision of ['accepted', 'rejected', 'discussed']) {
      expect(itemIssues({ type: 'Requirement', suggestion: { decision } })).toEqual([]);
    }
  });

  it('also applies to an Epic, which has no score to report', () => {
    expect(itemIssues({ type: 'Epic', suggestion: { decision: 'pending' } }).map((issue) => issue.id)).toEqual(['suggestion-waiting']);
  });
});

