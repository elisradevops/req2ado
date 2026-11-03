/** The facts of a document study (ingestion's /study/overview), already limited to what the document itself states. */
export interface OverviewFacts {
  purpose_statements: string[];
  glossary_terms: number;
  standards: string[];
  standards_total: number;
  verification_statements: number;
  placeholder_tokens: string[];
  placeholder_tokens_total: number;
  table_roles: string[];
  windows_studied: number;
  windows_total: number;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function listWithMore(listed: string[], total: number): string {
  const more = total - listed.length;
  return more > 0 ? `${listed.join(', ')} and ${more} more` : listed.join(', ');
}

/**
 * The overview text, written here from the study's facts and nothing else: the purpose sentences are quoted exactly as the document states
 * them, and every other sentence states one counted finding. No model writes any of it, so it cannot say what the document does not.
 * Null when the study found nothing to say: the caller then shows no overview rather than an empty or invented one.
 */
export function composeOverviewText(facts: OverviewFacts): string | null {
  const parts: string[] = [];
  if (facts.purpose_statements.length > 0) {
    parts.push(`Stated in the document: ${facts.purpose_statements.map((quote) => `“${quote}”`).join(' ')}`);
  }
  if (facts.glossary_terms > 0) parts.push(`Defines ${plural(facts.glossary_terms, 'term', 'terms')}.`);
  if (facts.standards_total > 0) {
    parts.push(`Cites ${plural(facts.standards_total, 'standard or document', 'standards or documents')}: ${listWithMore(facts.standards, facts.standards_total)}.`);
  }
  if (facts.verification_statements > 0) {
    parts.push(`Describes how it is verified in ${plural(facts.verification_statements, 'place', 'places')}.`);
  }
  if (facts.placeholder_tokens_total > 0) {
    parts.push(
      `Leaves ${plural(facts.placeholder_tokens_total, 'value', 'values')} unresolved: ${listWithMore(facts.placeholder_tokens, facts.placeholder_tokens_total)}.`,
    );
  }
  if (facts.table_roles.length > 0) parts.push(`Tables hold: ${facts.table_roles.join('; ')}.`);
  if (parts.length === 0) return null;
  if (facts.windows_studied < facts.windows_total) {
    parts.push(`Studied ${facts.windows_studied} of ${facts.windows_total} parts of the document.`);
  }
  return parts.join(' ');
}
