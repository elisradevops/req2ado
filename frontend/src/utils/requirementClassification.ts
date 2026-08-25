// Mirrors orchestrator/src/config/requirement-type-fields.ts exactly --
// display-only here (which chip gets the "written to ADO" hint before
// commit), never the source of truth for what actually gets written. The
// real write always happens server-side (JobsService.resolveClassification
// Value); a mismatch between this and that function would only ever be a
// cosmetic hint bug, never a wrong ADO write.
const REQUIREMENT_TAG_TO_ADO_VALUE: Record<string, string> = {
  functional: 'Functional',
  non_functional: 'Quality of Service',
  performance: 'Quality of Service',
  interface: 'Interface',
  safety: 'Safety',
  security: 'Security',
  operation: 'Operational',
  feature: 'Feature',
};

const REQUIREMENT_TAG_PRIORITY: readonly string[] = ['safety', 'security', 'interface', 'operation', 'feature', 'functional'];

// Which of this Requirement's tags would actually be written to ADO's
// classification field, given that field's real allowedValues -- null when
// none of the tags map to a representable value (regulatory/maintenance/
// behavior only, or an org whose picklist doesn't include the mapped
// value). `allowedValues` may be undefined (no credential, no diff yet, or
// resolution failed server-side) -- treated the same as an empty list.
export function resolveWinningTag(tags: string[] | undefined, allowedValues: string[] | undefined): string | null {
  const normalizedAllowed = new Set((allowedValues ?? []).map((value) => value.toLowerCase().trim()));
  for (const tag of REQUIREMENT_TAG_PRIORITY) {
    if (!(tags ?? []).includes(tag)) continue;
    const mapped = REQUIREMENT_TAG_TO_ADO_VALUE[tag];
    if (mapped && normalizedAllowed.has(mapped.toLowerCase())) {
      return tag;
    }
  }
  return null;
}
