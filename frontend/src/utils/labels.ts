// One vocabulary for every snake_case value the backend emits -- shared by
// chips, tooltips, and toasts so the same code always reads the same way
// everywhere it appears.

export interface QualityIssueLabel {
  label: string;
  description: string;
}

// The closed set of 7 issue codes an LLM judgment can flag on a requirement
// (ingestion/app/workitem/model.py:41-56). Descriptions explain what to fix,
// not just name the code.
export const QUALITY_ISSUE_LABELS: Record<string, QualityIssueLabel> = {
  ambiguous: {
    label: 'Ambiguous',
    description: 'Can be read more than one way -- tighten the wording so only one interpretation is possible.',
  },
  not_testable: {
    label: 'Not testable',
    description: 'No objective pass/fail check exists for this wording -- add a measurable condition or threshold.',
  },
  compound: {
    label: 'Compound',
    description: 'Bundles more than one requirement into one statement -- split into separate, independently verifiable items.',
  },
  missing_acceptance_criteria: {
    label: 'Missing acceptance criteria',
    description: 'No stated condition for when this requirement counts as met -- add one.',
  },
  vague_term: {
    label: 'Vague term',
    description: 'Uses a subjective word (e.g. "user-friendly", "fast", "robust") with no defined threshold -- replace with a measurable value.',
  },
  passive_voice: {
    label: 'Passive voice',
    description: 'Does not name who or what performs the action -- rewrite so the responsible actor is explicit.',
  },
  missing_rationale: {
    label: 'Missing rationale',
    description: 'No stated reason this requirement exists -- add a rationale so reviewers can judge whether it still applies.',
  },
};

export function qualityIssueLabel(code: string): QualityIssueLabel {
  return QUALITY_ISSUE_LABELS[code] ?? { label: code, description: '' };
}

export const RELEVANCE_LABELS: Record<string, string> = {
  relevant: 'Judged relevant to this requirement',
  not_relevant: 'Judged not relevant to this requirement',
  unknown: 'Relevance not verified',
};

export function relevanceLabel(relevance: string): string {
  return RELEVANCE_LABELS[relevance] ?? relevance;
}

// The Job.status lifecycle (jobs.service.ts, schema.prisma) -- what each
// stage actually means and, where relevant, what happens next.
export const JOB_STATUS_LABELS: Record<string, { label: string; description: string }> = {
  pending: {
    label: 'Pending',
    description: 'Queued -- the pipeline worker hasn’t picked this job up yet.',
  },
  running: {
    label: 'Running',
    description: 'Parsing and (in SURVEY mode) analyzing the document. BASELINE finishes in seconds; SURVEY can take 15-40+ minutes.',
  },
  diff_ready: {
    label: 'Diff Ready',
    description: 'Analysis is done -- review the proposed work items below, then Confirm to write them to Azure DevOps or Reject to discard.',
  },
  writing: {
    label: 'Writing',
    description: 'Confirmed -- creating and linking work items in Azure DevOps now. This step cannot be interrupted.',
  },
  succeeded: {
    label: 'Succeeded',
    description: 'All confirmed work items were created in Azure DevOps.',
  },
  failed: {
    label: 'Failed',
    description: 'The job did not complete -- check the audit trail for what went wrong.',
  },
  rejected: {
    label: 'Rejected',
    description: 'You rejected this job’s diff -- nothing was written to Azure DevOps.',
  },
  cancelled: {
    label: 'Cancelled',
    description: 'You cancelled this job before it finished -- nothing was written to Azure DevOps.',
  },
};

export function jobStatusLabel(status: string): { label: string; description: string } {
  return JOB_STATUS_LABELS[status] ?? { label: status, description: '' };
}
