// Mirrors ingestion's IntegrityWarning (app.workitem.model.WarningKind/
// WarningSeverity, shared/schemas/work-item-tree.schema.json) -- structured
// integrity signal replacing the old flat warning string. `kind` is
// intentionally `string`, not a closed union: ingestion owns the closed
// vocabulary and can add a kind without a matching frontend release (see
// KIND_META's fallback below for how an unrecognized kind still renders
// sanely).
export type WarningSeverity = 'auto_fixed' | 'needs_review' | 'pipeline_issue';

export interface WarningRecord {
  kind: string;
  severity: WarningSeverity;
  nodeIds: string[];
  detail: Record<string, unknown>;
  raw: string;
  // Set only by normalizeWarning's legacy-string fallback below -- never
  // present on a record built fresh by ingestion/orchestrator. Lets the UI
  // (optionally) mark a warning as "from an older run" instead of
  // presenting a best-effort guess as a real classification.
  legacy?: boolean;
  // Reviewer state, set server-side by JobsService.setWarningsAcknowledged.
  // Advisory: Confirm never reads it. Not part of ingestion's contract.
  acknowledged?: boolean;
}

const CONFLICT_LOCAL_ID_RE = /\[localId: ([^\]]+)\]/g;

function extractConflictLocalIds(raw: string): string[] {
  return [...raw.matchAll(CONFLICT_LOCAL_ID_RE)].map((match) => match[1]);
}

// Classifies a plain warning STRING by its known prefix -- both patterns
// come from a small, fixed set of message templates ingestion used before
// the structured-warnings migration, not free-form LLM text, so matching on
// their stable prefixes is reliable. This is a FALLBACK ONLY, exercised by
// two cases: (1) a job persisted before this migration, whose Job.warnings
// column still literally contains string[] JSON; (2) a live in-flight
// `chunk_warning` narration string (see JobDetail.tsx's liveWarnings) --
// upgrading that SSE payload to carry a structured record too is a separate,
// later change (touches narration_publisher.py's wire schema on both ends).
// `needs_review` is always the fallback severity, never `auto_fixed` --
// defaulting to "no action needed" would suppress attention on content
// nobody has actually classified with real confidence.
function classifyLegacyWarningString(raw: string): { kind: string; severity: WarningSeverity; nodeIds: string[] } {
  if (raw.startsWith('SURVEY analysis did not reference')) {
    return { kind: 'dropped_blocks', severity: 'needs_review', nodeIds: [] };
  }
  if (raw.includes('references an external artifact')) {
    return { kind: 'external_reference', severity: 'needs_review', nodeIds: [] };
  }
  if (raw.startsWith('Near-duplicate items')) {
    return { kind: 'near_duplicate_conflict', severity: 'needs_review', nodeIds: extractConflictLocalIds(raw) };
  }
  return { kind: 'other', severity: 'needs_review', nodeIds: [] };
}

// The union seam: persisted `Job.warnings` may be a legacy string[] (a job
// predating this migration) or a real WarningRecord[] (everything going
// forward); live `chunk_warning` narration is always a plain string (see
// classifyLegacyWarningString's own doc comment). Both normalize through
// here so the rest of the frontend only ever deals with one shape.
export function normalizeWarning(warning: string | WarningRecord): WarningRecord {
  if (typeof warning !== 'string') return warning;
  const { kind, severity, nodeIds } = classifyLegacyWarningString(warning);
  return { kind, severity, nodeIds, detail: {}, raw: warning, legacy: true };
}
