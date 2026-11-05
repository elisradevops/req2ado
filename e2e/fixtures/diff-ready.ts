// A finished (diff_ready) job as the review screen sees it: a tree with the
// shapes the P14 hierarchy work has to survive (long titles, Hebrew and mixed
// Hebrew/Latin titles, review flags, issue counts, a read-only duplicate) and
// the three warning situations that change the approval-gate line.
// Everything here is synthetic: no document content, no model.

export interface DiffEntryFixture {
  localId: string;
  parentLocalId: string | null;
  type: 'Epic' | 'Feature' | 'Requirement';
  title: string;
  description: string;
  action: 'create' | 'reuse';
  existingAdoId?: number | null;
  customerId: string | null;
  qualityScore?: number | null;
  qualityConfidence?: 'high' | 'medium' | 'low' | null;
  groundingScore?: number | null;
  qualityIssues?: string[];
}

export type WarningVariant = 'none' | 'one' | 'many';

export const LONG_TITLE =
  'The Standard PC/104 Core Module shall provide the processing, memory, storage and interface resources required by every ADCS stack configuration across the full operating temperature range';
export const HEBREW_TITLE = 'המערכת תספק עיבוד, זיכרון ואחסון לכל תצורת מחסנית בטווח הטמפרטורות המלא';
export const MIXED_TITLE = 'המערכת תתמוך ב-WI-3024 עד לסיום TBD בשלב התכנון';

const base = { description: '<p>Synthetic description.</p>', action: 'create' as const, customerId: null };

/** Ids the specs look rows up by. Titles are what the user sees; ids stay stable. */
export const IDS = {
  featureOpen: 'f-open',
  featureClosed: 'f-closed',
  featureEmpty: 'f-empty',
  long: 'r-long',
  hebrew: 'r-he',
  mixed: 'r-mixed',
  flagged: 'r-flagged',
  issues: 'r-issues',
  both: 'r-both',
  duplicate: 'r-dup',
} as const;

export const ENTRIES: DiffEntryFixture[] = [
  { ...base, localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Subsystem overview' },
  { ...base, localId: IDS.featureOpen, parentLocalId: 'e1', type: 'Feature', title: 'Core module' },
  { ...base, localId: IDS.long, parentLocalId: IDS.featureOpen, type: 'Requirement', title: LONG_TITLE, customerId: 'CM-001' },
  { ...base, localId: IDS.hebrew, parentLocalId: IDS.featureOpen, type: 'Requirement', title: HEBREW_TITLE, customerId: 'CM-002' },
  { ...base, localId: IDS.mixed, parentLocalId: IDS.featureOpen, type: 'Requirement', title: MIXED_TITLE, customerId: 'CM-003' },
  // Needs-review flag only (low confidence), issue count only, and both: the two signals P14 separates.
  { ...base, localId: IDS.flagged, parentLocalId: IDS.featureOpen, type: 'Requirement', title: 'Flagged only', qualityScore: 80, qualityConfidence: 'low' },
  { ...base, localId: IDS.issues, parentLocalId: IDS.featureOpen, type: 'Requirement', title: 'Issues only', qualityScore: 80, qualityConfidence: 'high', qualityIssues: ['vague_term', 'no_measure'] },
  { ...base, localId: IDS.both, parentLocalId: IDS.featureOpen, type: 'Requirement', title: 'Flagged and issues', qualityScore: 40, qualityConfidence: 'low', qualityIssues: ['vague_term'] },
  // Matches an existing ADO item, so the details dialog is read-only (no Edit button).
  { ...base, localId: IDS.duplicate, parentLocalId: IDS.featureOpen, type: 'Requirement', title: 'Already in Azure DevOps', action: 'reuse', existingAdoId: 3024 },
  { ...base, localId: IDS.featureClosed, parentLocalId: 'e1', type: 'Feature', title: 'Power and thermal' },
  { ...base, localId: 'r-closed', parentLocalId: IDS.featureClosed, type: 'Requirement', title: 'Hidden until the Feature is opened' },
  { ...base, localId: IDS.featureEmpty, parentLocalId: 'e1', type: 'Feature', title: 'Childless feature' },
];

interface WarningRecordFixture {
  kind: string;
  severity: 'auto_fixed' | 'needs_review' | 'pipeline_issue';
  nodeIds: string[];
  detail: Record<string, unknown>;
  raw: string;
}

// The gate counts KINDS still to be worked through (fix + review groups), not records.
const WARNINGS: Record<'one' | 'many', WarningRecordFixture[]> = {
  one: [
    { kind: 'missing_source_reference', severity: 'needs_review', nodeIds: [IDS.long], detail: {}, raw: 'Requirement without a source reference' },
  ],
  many: [
    { kind: 'missing_source_reference', severity: 'needs_review', nodeIds: [IDS.long], detail: {}, raw: 'Requirement without a source reference' },
    { kind: 'duplicate_customer_id', severity: 'needs_review', nodeIds: [IDS.hebrew, IDS.mixed], detail: {}, raw: 'Duplicate customer id CM-002' },
    { kind: 'near_duplicate_conflict', severity: 'needs_review', nodeIds: [IDS.duplicate], detail: {}, raw: 'Near duplicate of WI-3024' },
  ],
};

export function warningsFor(variant: WarningVariant): WarningRecordFixture[] {
  return variant === 'none' ? [] : WARNINGS[variant];
}
