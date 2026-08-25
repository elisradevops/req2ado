// Candidate list for the picklist-constrained field an ADO process template
// might expose for requirement classification (WorkItemNode.tags) --
// resolved the same runtime-verified way as DEFAULT_CUSTOMER_ID_FIELD_
// CANDIDATES (see customer-id-fields.ts): each candidate is checked against
// ado_discover_fields_detailed and the first one actually present wins,
// never hardcoded to one org's process template.
//
// 'Microsoft.VSTS.CMMI.RequirementType' is listed first: it is CMMI's real
// built-in field for exactly this concept (single-valued, required, default
// "Feature", 9 real allowed values -- confirmed against Microsoft's own
// docs). 'Custom.Requirement_Type' is the fallback for a process template
// that doesn't include the CMMI process (Agile/Scrum/Basic don't ship this
// field at all).
export const DEFAULT_REQUIREMENT_TYPE_FIELD_CANDIDATES = ['Microsoft.VSTS.CMMI.RequirementType', 'Custom.Requirement_Type'];

// The closed 11-value taxonomy a diff entry's own `tags` may ever contain
// (mirrors ingestion's RequirementTag enum / shared/schemas/work-item-tree.
// schema.json's closed enum exactly) -- this is the vocabulary a reviewer
// edits and the diff STORES, deliberately wider than
// REQUIREMENT_TAG_TO_ADO_VALUE below (which only covers the subset one
// specific ADO field, CMMI's RequirementType, can represent). Validating a
// PATCH against this list, not against one org's live allowedValues, keeps
// the diff's own vocabulary stable across orgs -- the ADO-value mapping
// happens only at write time (JobsService.resolveClassificationValue).
export const VALID_REQUIREMENT_TAGS: readonly string[] = [
  'functional',
  'non_functional',
  'interface',
  'performance',
  'regulatory',
  'safety',
  'security',
  'operation',
  'maintenance',
  'feature',
  'behavior',
];

// Maps req2ado's own RequirementTag taxonomy to the real CMMI
// RequirementType picklist values -- confirmed against Microsoft's own
// docs, matched case/whitespace-insensitively against whatever the org's
// real `allowedValues` actually contains (never assumed present verbatim).
// 'non_functional' and 'performance' both map to 'Quality of Service' --
// a harmless collision (two of our tags describing the one ADO category),
// not a conflict. 'regulatory'/'maintenance'/'behavior' have no CMMI
// counterpart at all and are deliberately absent here -- see
// resolveRequirementTypeClassification's own doc comment for what happens
// when a Requirement's only tag(s) fall in this unmapped set.
export const REQUIREMENT_TAG_TO_ADO_VALUE: Record<string, string> = {
  functional: 'Functional',
  non_functional: 'Quality of Service',
  performance: 'Quality of Service',
  interface: 'Interface',
  safety: 'Safety',
  security: 'Security',
  operation: 'Operational',
  feature: 'Feature',
};

// When a Requirement carries more than one mappable tag, ADO's field can
// only hold one value -- this is the product-owner-confirmed priority
// order that decides which one wins, safety-first (a mis-classified
// safety/security item is the costliest mistake). Tags with no CMMI
// mapping (regulatory/maintenance/behavior) never appear here -- they only
// ever matter when they are the ONLY tag on a Requirement, in which case
// resolveRequirementTypeClassification leaves the field unmapped
// (warn-and-leave-ADO's-own-default) regardless of this order.
export const REQUIREMENT_TAG_PRIORITY: readonly string[] = ['safety', 'security', 'interface', 'operation', 'feature', 'functional'];
