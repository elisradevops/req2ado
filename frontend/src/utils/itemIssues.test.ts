import { describe, it, expect } from 'vitest';
import { itemIssues, weakCategoryKeys } from './itemIssues';
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

describe('weakCategoryKeys', () => {
  it('lists at most three real weak categories, weakest first, and none for a parent or a stale score', () => {
    const qualityCategoryScores = { clarity: 60, testability: 20, atomicity: 40, style: 95, rationale: 50 };
    expect(weakCategoryKeys({ type: 'Requirement', qualityCategoryScores })).toEqual(['testability', 'atomicity', 'rationale']);
    expect(weakCategoryKeys({ type: 'Feature', qualityCategoryScores })).toEqual([]);
    expect(weakCategoryKeys({ type: 'Requirement', qualityCategoryScores, qualityStale: true })).toEqual([]);
  });
});

describe('missingValuesOf', () => {
  it('reads the marked values, and falls back to the sentence of an older job', () => {
    expect(missingValuesOf('<p><span data-missing-value="TBD">TBD</span></p>')).toEqual(['TBD']);
    expect(missingValuesOf('<div><p>Unresolved value(s) in this requirement: TBD, ??. Acceptance criteria were not proposed.</p></div>')).toEqual(['TBD', '??']);
    expect(missingValuesOf(undefined)).toEqual([]);
  });
});
