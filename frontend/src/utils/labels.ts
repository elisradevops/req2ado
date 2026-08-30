// One vocabulary for every snake_case value the backend emits -- shared by
// chips, tooltips, and toasts so the same code always reads the same way
// everywhere it appears.

export interface QualityIssueLabel {
  label: string;
  description: string;
}

// The closed set of issue codes an LLM judgment can flag on a requirement
// (ingestion/app/workitem/model.py's RequirementQualityIssue). Descriptions
// explain what to fix, not just name the code. The 6 entries after
// missing_rationale were added alongside a new completeness_as_requirement
// scoring dimension -- the original 7 all presupposed the input was already
// a well-formed requirement statement, with no way to flag a bare fragment
// or table-cell value as not being one at all.
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
  not_a_requirement: {
    label: 'Not a requirement',
    description: 'Missing a subject, a modal (shall/should/must), and a verifiable predicate -- this reads as a label or fragment, not an obligation.',
  },
  fragment: {
    label: 'Fragment',
    description: 'A short extracted phrase or table value, not a complete requirement statement -- rewrite it as one, or remove it.',
  },
  placeholder: {
    label: 'Placeholder',
    description: 'References an unresolved placeholder from the source document (e.g. a literal "ReqID XXXX" or "??") -- resolve it to a real value or cross-reference.',
  },
  open_item_tbd: {
    label: 'Open item / TBD',
    description: 'Marked as an open question or unresolved issue in the source document -- not yet a committed requirement.',
  },
  rationale_as_requirement: {
    label: 'Rationale, not a requirement',
    description: 'Explains WHY a design choice was made rather than stating an obligation -- move it to support a nearby requirement instead.',
  },
  conflicting_value: {
    label: 'Conflicting value',
    description: 'The source document states two different values for what looks like the same parameter -- resolve the conflict before this can be finalized.',
  },
};

export function qualityIssueLabel(code: string): QualityIssueLabel {
  return QUALITY_ISSUE_LABELS[code] ?? { label: code, description: '' };
}

// The closed set of category tags SURVEY assigns to a requirement
// (ingestion/app/workitem/model.py's RequirementTag). Most read fine
// title-cased on their own, but a few (regulatory vs operation vs
// maintenance) are easy to conflate without a real definition -- same
// {label, description} shape as QUALITY_ISSUE_LABELS so TagChips can reuse
// IssueChips' own Tooltip-wrapping pattern verbatim.
export const REQUIREMENT_TAG_LABELS: Record<string, QualityIssueLabel> = {
  functional: { label: 'Functional', description: 'Describes something the system must DO.' },
  non_functional: {
    label: 'Non-functional',
    description: 'Describes a quality/constraint on the system (performance, reliability, etc.), not a specific behavior.',
  },
  interface: { label: 'Interface', description: 'Defines a boundary/connection point between the system and something else.' },
  performance: { label: 'Performance', description: 'A measurable speed, throughput, capacity, or timing requirement.' },
  regulatory: { label: 'Regulatory', description: 'Required by an external standard, law, or certification body.' },
  safety: { label: 'Safety', description: 'Prevents harm to people, equipment, or mission -- typically has independent verification.' },
  security: { label: 'Security', description: 'Protects against unauthorized access, tampering, or data loss.' },
  operation: { label: 'Operation', description: 'Describes how the system behaves during normal, in-service use.' },
  maintenance: { label: 'Maintenance', description: 'Describes servicing, repair, or upkeep activity, not normal operation.' },
  feature: { label: 'Feature', description: 'A user-facing capability, rather than an internal/technical constraint.' },
  behavior: { label: 'Behavior', description: 'Describes a specific response the system produces to a given condition or input.' },
};

export function requirementTagLabel(tag: string): QualityIssueLabel {
  return REQUIREMENT_TAG_LABELS[tag] ?? { label: tag, description: '' };
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
    description: 'Parsing and (in SURVEY mode) analyzing the document. BASELINE finishes in seconds; SURVEY scales with document size.',
  },
  diff_ready: {
    // DESIGN.md §12: sentence case everywhere -- same fix as
    // StatusChip.tsx's own STATUS_CONFIG map for this identical status.
    label: 'Diff ready',
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
  // NEW-05 batch/folder ingestion -- a batch file's own pre-submit statuses
  // (JobBatchFile.status), shown on the batch status page for a file that
  // doesn't have a real Job yet (or never will).
  queued: {
    label: 'Queued',
    description: 'Waiting for a slot to be submitted as a real job -- BASELINE files are submitted immediately; SURVEY files may wait if this deployment is at its concurrency limit.',
  },
  invalid: {
    label: 'Invalid',
    description: 'Rejected before submission -- see this file’s own error for why (usually an unsupported file type or a size over the upload limit).',
  },
  submit_failed: {
    label: 'Submit failed',
    description: 'Accepted, but the attempt to submit it as a real job failed -- see this file’s own error for details.',
  },
  deleted: {
    label: 'Deleted',
    description: 'The job this file was submitted as has since been deleted.',
  },
};

export function jobStatusLabel(status: string): { label: string; description: string } {
  return JOB_STATUS_LABELS[status] ?? { label: status, description: '' };
}

// A diff entry's action, as plain display text -- shared by ActionBadge
// (renders it inside a Chip) and DiffTree's Status column-width measurer
// (needs the exact same string to measure the widest real label), so the
// two can never silently drift on what "the label" actually is.
export function actionLabel(entry: { action: 'create' | 'reuse' | 'dedup_skip'; existingAdoId?: number | null }): string {
  if (entry.action === 'create') return 'New';
  if (entry.action === 'reuse') return `Links to WI-${entry.existingAdoId ?? '?'}`;
  return entry.existingAdoId != null ? `Near-duplicate of WI-${entry.existingAdoId}` : 'Near-duplicate';
}
