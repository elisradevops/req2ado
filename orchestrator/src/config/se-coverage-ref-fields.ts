// Candidate list for the field a future Systems Engineering coverage
// reference (WorkItemNode.se_coverage_ref) would be written to -- same
// runtime-verified resolution pattern as DEFAULT_CUSTOMER_ID_FIELD_
// CANDIDATES/DEFAULT_REQUIREMENT_TYPE_FIELD_CANDIDATES (see those files).
//
// Deliberately EMPTY by default: unlike Customer ID, there is no known real
// ADO field name for this concept yet (no SE-layer artifact exists in any
// deployed org's ADO setup as of this feature's own design). Shipping a
// guessed name here would risk silently writing to the WRONG field on an
// org that happens to have something similarly named. Until an operator
// configures SE_COVERAGE_REF_FIELD_CANDIDATES for their own org, the field
// stays reviewer-editable in req2ado's own diff (visible, savable) but is
// simply never written to ADO -- consistent with this feature's "hook, not
// data" scope: the mechanism exists, nothing is invented on top of it.
export const DEFAULT_SE_COVERAGE_REF_FIELD_CANDIDATES: string[] = [];
