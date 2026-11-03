import { composeOverviewText, type OverviewFacts } from '../src/modules/pipeline/overview-text';

const none: OverviewFacts = {
  purpose_statements: [], glossary_terms: 0, standards: [], standards_total: 0, verification_statements: 0,
  placeholder_tokens: [], placeholder_tokens_total: 0, table_roles: [], windows_studied: 1, windows_total: 1,
};

// The overview is written in code from the document study's facts, never by a model: each sentence below states one finding, and a document that
// yielded none gets no overview rather than a made-up one.
describe('composeOverviewText', () => {
  it('quotes the purpose sentences exactly as the document states them', () => {
    const text = composeOverviewText({ ...none, purpose_statements: ['This document specifies the tracker interface.', 'It excludes the display.'] });
    expect(text).toBe('Stated in the document: “This document specifies the tracker interface.” “It excludes the display.”');
  });

  it('states each finding in one sentence, with counts that are true', () => {
    const text = composeOverviewText({
      ...none,
      purpose_statements: ['This document specifies X.'],
      glossary_terms: 2,
      standards: ['MIL-STD-704', 'VITA 65'], standards_total: 2,
      verification_statements: 3,
      placeholder_tokens: ['TBD', 'N'], placeholder_tokens_total: 2,
      table_roles: ['fan configuration values'],
    });
    expect(text).toBe(
      'Stated in the document: “This document specifies X.” Defines 2 terms. Cites 2 standards or documents: MIL-STD-704, VITA 65. ' +
        'Describes how it is verified in 3 places. Leaves 2 values unresolved: TBD, N. Tables hold: fan configuration values.',
    );
  });

  it('uses the singular for one, and says how many more when a list was cut', () => {
    const text = composeOverviewText({
      ...none, glossary_terms: 1, verification_statements: 1,
      standards: ['A', 'B'], standards_total: 5, placeholder_tokens: ['TBD'], placeholder_tokens_total: 1,
    });
    expect(text).toBe(
      'Defines 1 term. Cites 5 standards or documents: A, B and 3 more. Describes how it is verified in 1 place. Leaves 1 value unresolved: TBD.',
    );
  });

  it('says so when only part of the document was studied', () => {
    const text = composeOverviewText({ ...none, glossary_terms: 4, windows_studied: 3, windows_total: 8 });
    expect(text).toBe('Defines 4 terms. Studied 3 of 8 parts of the document.');
  });

  it('gives no overview when the study found nothing to say', () => {
    expect(composeOverviewText(none)).toBeNull();
    expect(composeOverviewText({ ...none, windows_studied: 1, windows_total: 4 })).toBeNull();
  });
});
