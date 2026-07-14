const ISSUE_COLORS: Record<string, string> = {
  ambiguous: '#dc2626',
  not_testable: '#b45309',
  compound: '#7c3aed',
  missing_acceptance_criteria: '#0891b2',
  vague_term: '#ea580c',
  passive_voice: '#4d7c0f',
  missing_rationale: '#be123c',
};

export function issueColor(issue: string): string {
  return ISSUE_COLORS[issue] ?? '#64748b';
}
