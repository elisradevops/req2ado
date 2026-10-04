import type { WarningRecord, WarningSeverity } from './warnings';

// Grouped by what the reviewer has to DO, not by how bad the failure was
// (that is `severity`, which ingestion owns and which stays visible as
// "Reported as" in a row's details). A pipeline failure that leaves the
// output complete -- e.g. an optional enhancement call that fell back to the
// original text -- is `info`; a Requirement that would reach Azure DevOps
// without its Customer ID is `fix`.
export type WarningGroup = 'fix' | 'review' | 'info';

export const GROUP_ORDER: WarningGroup[] = ['fix', 'review', 'info'];

export const GROUP_META: Record<WarningGroup, { title: string; line: string; actionLabel: string }> = {
  fix: {
    title: 'Fix before confirming',
    line: 'These would reach Azure DevOps wrong or incomplete.',
    actionLabel: 'Fix in tree',
  },
  review: {
    title: 'Review',
    line: 'Judgment calls. Check each one.',
    actionLabel: 'Review in tree',
  },
  info: {
    title: 'For your information',
    line: 'Nothing to do. Shown so you know what happened.',
    actionLabel: 'Show in tree',
  },
};

export const SEVERITY_LABEL: Record<WarningSeverity, string> = {
  auto_fixed: 'Automatically fixed',
  needs_review: 'Needs review',
  pipeline_issue: 'Pipeline issue',
};

export interface KindMeta {
  title: string;
  group: WarningGroup;
  // One-line subtitle on the collapsed row.
  short: string;
  // Details: what the warning means for the output, and what (if anything)
  // the reviewer should do about it.
  means: string;
  todo: string;
  // Reason chip shown on an affected tree row while this kind is focused.
  chip: string;
  // Count noun when a kind has no nodeIds and records are counted instead.
  unit: [singular: string, plural: string];
  // Overrides GROUP_META's action label for the row's tree button.
  actionLabel?: string;
}

// Closed vocabulary (ingestion's app.workitem.model.WarningKind). `kind` on
// WarningRecord is `string` on purpose -- ingestion can add one without a
// matching frontend release; kindMeta()'s fallback renders those sanely.
export const KIND_META: Record<string, KindMeta> = {
  // -- Fix before confirming -------------------------------------------------
  missing_source_reference: {
    title: 'Requirement has no Customer ID',
    group: 'fix',
    short: 'The document had no ID to use as the source reference. None was invented.',
    means: 'These requirements will be created in Azure DevOps without a Customer ID.',
    todo: 'If the source document has an ID for them, open each item and add it before you confirm.',
    chip: 'No Customer ID',
    unit: ['requirement', 'requirements'],
  },
  duplicate_customer_id: {
    title: 'Customer ID removed: reported on several requirements',
    group: 'fix',
    short: 'The same Customer ID appeared on more than one requirement, so it was removed from all of them.',
    means: 'These requirements will be created without a Customer ID rather than with a wrong one.',
    todo: 'Check the source document and add the real ID to the right requirement before you confirm.',
    chip: 'ID removed',
    unit: ['requirement', 'requirements'],
  },
  zero_nodes: {
    title: 'A section produced no items',
    group: 'fix',
    short: 'A section with real content produced no work items.',
    means: 'Requirements from this section are missing from the tree.',
    todo: 'Resubmit the job (the button at the top of this page), or add the items manually after you confirm.',
    chip: 'No items',
    unit: ['section', 'sections'],
  },
  output_truncated: {
    title: 'Model output truncated',
    group: 'fix',
    short: 'The model hit its output limit, so a section may be incomplete.',
    means: 'Results for this section may be missing items.',
    todo: 'Raise the output limit and resubmit the job, or add any missing items by hand.',
    chip: 'Possibly incomplete',
    unit: ['section', 'sections'],
  },
  dropped_row: {
    title: 'Row not represented in the tree',
    group: 'fix',
    short: 'A source row had no item to fold into, so its content is not in the proposed tree.',
    means: 'The content of these rows is not represented anywhere in the tree.',
    todo: 'Check the source table. Add an item for any row that matters.',
    chip: 'Not in tree',
    unit: ['row', 'rows'],
  },
  trace_link_write_failed: {
    title: 'Trace links failed to write to Azure DevOps',
    group: 'fix',
    short: 'The work items were created, but some trace links could not be written.',
    means: 'Every work item exists in Azure DevOps. Only these links are missing.',
    todo: 'Open the affected item and use the retry control next to its link.',
    chip: 'Link failed',
    unit: ['link', 'links'],
  },

  // -- Review ----------------------------------------------------------------
  near_duplicate_conflict: {
    title: 'Near-duplicates with conflicting values',
    group: 'review',
    short: 'Items that describe the same thing but state different values.',
    means: 'The source restates one parameter inconsistently, or the model split one requirement in two.',
    todo: 'Open both items. Keep the correct value, then edit or exclude the other.',
    chip: 'Conflicting value',
    unit: ['conflict', 'conflicts'],
    actionLabel: 'Compare',
  },
  low_grounding: {
    title: 'Low grounding: possible fabrication',
    group: 'review',
    short: "These items' descriptions share little wording with their source text.",
    means: 'The model may have added detail that is not in your document.',
    todo: "Read each item against its source. Edit or exclude anything the document doesn't say.",
    chip: 'Low grounding',
    unit: ['item', 'items'],
  },
  dropped_blocks: {
    title: 'Content the model may have dropped',
    group: 'review',
    short: "Source text that no generated item refers to, even paraphrased.",
    means: 'Some source text did not end up in any work item. Often these are labels, captions or cross-references that need nothing.',
    todo: 'Read each passage. If it is real technical content, add it as an item by hand.',
    chip: 'Source dropped',
    unit: ['section', 'sections'],
  },
  missing_requirement_row_coverage: {
    title: 'A numbered source requirement is missing',
    group: 'review',
    short: 'A source row has its own requirement ID, but no generated item claims it.',
    means: 'It may have been merged into another requirement or dropped.',
    todo: 'Check the source table for this section and add the requirement if it is missing.',
    chip: 'Row missing',
    unit: ['row', 'rows'],
  },
  missing_table_group_coverage: {
    title: 'Table group missing from output',
    group: 'review',
    short: "A table group with 2+ items didn't produce its own distinct item.",
    means: 'Its children may have been folded into a broader item.',
    todo: 'Check that the group appears the way you expect in the tree.',
    chip: 'Group missing',
    unit: ['group', 'groups'],
  },
  invalid_figure_ids: {
    title: 'Invalid figure reference dropped',
    group: 'review',
    short: "The model referenced a figure that wasn't offered in its section.",
    means: 'The invalid reference was dropped. Real content may have been expected there.',
    todo: "Check the item's attached figures against the source.",
    chip: 'Figure dropped',
    unit: ['item', 'items'],
  },
  invalid_table_ids: {
    title: 'Invalid table reference dropped',
    group: 'review',
    short: "The model referenced a table that wasn't offered in its section.",
    means: 'The invalid reference was dropped. Real content may have been expected there.',
    todo: "Check the item's attached tables against the source.",
    chip: 'Table dropped',
    unit: ['item', 'items'],
  },
  invalid_node_type: {
    title: 'Invalid item type defaulted',
    group: 'review',
    short: 'The model returned a type outside Epic, Feature and Requirement.',
    means: 'These items were set to Requirement.',
    todo: 'Change the type in the item if it should be an Epic or Feature.',
    chip: 'Type defaulted',
    unit: ['item', 'items'],
  },
  dangling_parent: {
    title: 'Unresolved parent reference',
    group: 'review',
    short: "The model named a parent that doesn't exist in its section.",
    means: "These items were attached as their section's root instead.",
    todo: 'Move each item under the right parent if the placement is wrong.',
    chip: 'Parent unknown',
    unit: ['item', 'items'],
  },
  external_reference: {
    title: 'References to documents not in your knowledge base',
    group: 'review',
    short: "The source points to documents that were never ingested.",
    means: "SURVEY can't verify or use content it doesn't have.",
    todo: 'Add the referenced documents to your knowledge base so future runs can ground against them.',
    chip: 'External ref',
    unit: ['reference', 'references'],
  },
  classification_not_representable: {
    title: "Classification not available in this project's field",
    group: 'review',
    short: "No matching value in this project's Requirement Type field.",
    means: "The requirement was left at Azure DevOps' default value.",
    todo: 'Set the classification manually if it matters.',
    chip: 'Default type',
    unit: ['requirement', 'requirements'],
  },
  customer_id_field_not_configured: {
    title: 'Customer ID field not configured in this project',
    group: 'review',
    short: 'No matching field exists on the Requirement type in this project.',
    means: "The Customer ID can't be written to Azure DevOps. It is still saved in this app's review UI.",
    todo: 'Add the field in Azure DevOps if you need the ID there.',
    chip: 'ID not written',
    unit: ['requirement', 'requirements'],
  },
  other: {
    title: 'Other analysis notices',
    group: 'review',
    short: 'Notices from an earlier run, before warning types were tracked.',
    means: 'Lower-level signals. Usually safe to ignore unless the affected item looks wrong.',
    todo: 'Read the details. Check the item in the tree only if something looks off.',
    chip: 'Notice',
    unit: ['notice', 'notices'],
  },

  // -- For your information --------------------------------------------------
  enhancement_call_failed: {
    title: 'Enhanced wording unavailable',
    group: 'info',
    short: 'An optional text-enhancement step failed, so these items keep their extracted text.',
    means: 'These items use their original extracted text. Nothing is missing from the tree.',
    todo: 'Nothing required. To get enhanced wording, resubmit the job.',
    chip: 'Original wording',
    unit: ['item', 'items'],
  },
  enhancement_response_incomplete: {
    title: 'Enhanced wording incomplete',
    group: 'info',
    short: "An enhancement response didn't cover every item, so those keep their extracted text.",
    means: 'These items use their original extracted text. Nothing is missing from the tree.',
    todo: 'Nothing required.',
    chip: 'Original wording',
    unit: ['item', 'items'],
  },
  scoring_failed: {
    title: 'Quality scoring failed',
    group: 'info',
    short: 'Scoring failed for a batch of items. Their content is unaffected.',
    means: 'These items show no quality score.',
    todo: 'Optional: open an item and use Rescore, or resubmit the job.',
    chip: 'No score',
    unit: ['batch', 'batches'],
  },
  scoring_missing: {
    title: 'No valid score returned',
    group: 'info',
    short: "The scoring response didn't include a usable score for some items.",
    means: 'These items show no quality score.',
    todo: 'Optional: open an item and use Rescore.',
    chip: 'No score',
    unit: ['batch', 'batches'],
  },
  scoring_inconsistent_categories: {
    title: 'Inconsistent scoring categories',
    group: 'info',
    short: 'Different category names were used across items in one scoring batch.',
    means: 'Category gauges may look inconsistent for this batch.',
    todo: 'Nothing required.',
    chip: 'Mixed categories',
    unit: ['batch', 'batches'],
  },
  trace_link_inference_failed: {
    title: 'No trace links suggested',
    group: 'info',
    short: 'Whole-document trace-link inference failed for this run.',
    means: 'Every proposed item is complete. None of them has suggested trace links.',
    todo: 'Add links in Azure DevOps after you confirm, or resubmit the job to retry.',
    chip: 'No links',
    unit: ['run', 'runs'],
  },
  ado_verification_failed: {
    title: 'Could not verify Azure DevOps items',
    group: 'info',
    short: 'A check that matched items still exist in Azure DevOps failed.',
    means: 'The matched items are shown unverified instead of blocked.',
    todo: 'Nothing required. Check the item in Azure DevOps if it matters.',
    chip: 'Unverified',
    unit: ['batch', 'batches'],
  },
  reparented_to_feature: {
    title: 'Re-parented under a Feature',
    group: 'info',
    short: 'Moved to keep Epic → Feature → Requirement valid. Text unchanged.',
    means: 'Only the structure changed. No text was edited.',
    todo: 'Nothing required. Open them in the tree if you want to check the new parent.',
    chip: 'Moved',
    unit: ['item', 'items'],
  },
  group_reparented: {
    title: 'Table group re-parented',
    group: 'info',
    short: "Moved to match the table's own ID hierarchy.",
    means: 'Only the structure changed.',
    todo: 'Nothing required.',
    chip: 'Moved',
    unit: ['item', 'items'],
  },
  bridge_feature_synthesized: {
    title: 'Grouping Feature inserted',
    group: 'info',
    short: 'Sections with requirements and no Feature above them got a grouping Feature.',
    means: 'The new Feature carries no requirement text of its own.',
    todo: 'Nothing required. Rename it if you want a clearer title.',
    chip: 'Inserted',
    unit: ['item', 'items'],
  },
  roots_regrouped: {
    title: 'Sections grouped by topic',
    group: 'info',
    short: 'The document had no single top heading, so root sections were grouped by topic.',
    means: 'Structure only. No content was invented.',
    todo: 'Nothing required.',
    chip: 'Regrouped',
    unit: ['item', 'items'],
  },
  catchall_epic_wrap: {
    title: 'Wrapped under a catch-all Epic',
    group: 'info',
    short: 'Root Features with no Epic were wrapped under a new Epic.',
    means: 'Every Feature now traces to an Epic.',
    todo: 'Nothing required. Rename the Epic if you want a clearer title.',
    chip: 'Wrapped',
    unit: ['item', 'items'],
  },
  no_model_title: {
    title: 'Title derived from description',
    group: 'info',
    short: "The model didn't return a title, so one was taken from the description.",
    means: 'The title changed. The description is the model output.',
    todo: 'Nothing required.',
    chip: 'Derived title',
    unit: ['item', 'items'],
  },
  survey_title_distilled: {
    title: 'Title replaced automatically',
    group: 'info',
    short: 'Generic titles were replaced with one distilled from the description.',
    means: 'The title changed. The description is unchanged.',
    todo: 'Nothing required.',
    chip: 'New title',
    unit: ['item', 'items'],
  },
  front_matter_folded: {
    title: 'Front matter folded automatically',
    group: 'info',
    short: 'Content before the first heading was folded into a front-matter item.',
    means: 'Nothing was dropped.',
    todo: 'Nothing required.',
    chip: 'Folded',
    unit: ['block', 'blocks'],
  },
  heading_id_offset_mismatch: {
    title: 'Heading ID offset mismatch',
    group: 'info',
    short: "Some headings' IDs didn't match the document's dominant level offset.",
    means: 'Those headings were handled by the model path instead of deterministic detection.',
    todo: 'Nothing required.',
    chip: 'Offset mismatch',
    unit: ['heading', 'headings'],
  },
};

function humanizeKind(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupFromSeverity(severity: WarningSeverity | undefined): WarningGroup {
  // An unlisted kind we can't read gets the conservative default: auto-fixed
  // is by definition resolved; anything else might need a human.
  return severity === 'auto_fixed' ? 'info' : 'review';
}

export function kindMeta(kind: string, severity?: WarningSeverity): KindMeta {
  const known = KIND_META[kind];
  if (known) return known;
  return {
    title: humanizeKind(kind),
    group: groupFromSeverity(severity),
    short: 'See the details for this notice.',
    means: 'See the details below.',
    todo: 'Check the affected items in the tree, if any are listed.',
    chip: 'Notice',
    unit: ['notice', 'notices'],
  };
}

export function warningGroup(warning: Pick<WarningRecord, 'kind' | 'severity'>): WarningGroup {
  return kindMeta(warning.kind, warning.severity).group;
}

// A warning is actionable when it needs the reviewer to do something. Info
// warnings never count toward the "needs your attention" banner.
export function isActionableWarning(warning: Pick<WarningRecord, 'kind' | 'severity'>): boolean {
  return warningGroup(warning) !== 'info';
}

export interface WarningKindGroup {
  kind: string;
  group: WarningGroup;
  meta: KindMeta;
  records: WarningRecord[];
  // Unique affected item ids across every record of this kind, in first-seen order.
  nodeIds: string[];
  severities: WarningSeverity[];
}

// One entry per kind, ordered by group (fix, review, info) then first-seen.
// A kind is one row in the panel however many records ingestion emitted.
export function buildKindGroups(warnings: WarningRecord[]): WarningKindGroup[] {
  const byKind = new Map<string, WarningKindGroup>();
  const seenNodeIds = new Map<string, Set<string>>();
  for (const warning of warnings) {
    let entry = byKind.get(warning.kind);
    if (!entry) {
      const meta = kindMeta(warning.kind, warning.severity);
      entry = { kind: warning.kind, group: meta.group, meta, records: [], nodeIds: [], severities: [] };
      byKind.set(warning.kind, entry);
      seenNodeIds.set(warning.kind, new Set());
    }
    entry.records.push(warning);
    if (!entry.severities.includes(warning.severity)) entry.severities.push(warning.severity);
    const seen = seenNodeIds.get(warning.kind)!;
    for (const nodeId of warning.nodeIds) {
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        entry.nodeIds.push(nodeId);
      }
    }
  }
  const all = [...byKind.values()];
  return GROUP_ORDER.flatMap((group) => all.filter((entry) => entry.group === group));
}

export function kindGroupCount(entry: WarningKindGroup): { count: number; label: string } {
  const [singular, plural] = entry.nodeIds.length > 0 ? ['item', 'items'] : entry.meta.unit;
  const count = entry.nodeIds.length > 0 ? entry.nodeIds.length : entry.records.length;
  return { count, label: count === 1 ? singular : plural };
}

// Progress through a kind's review. Only fix/review kinds are trackable --
// an info kind asks nothing of the reviewer, so there is nothing to finish.
// A kind with affected items is complete when every one is marked reviewed;
// a kind without items (e.g. zero_nodes, dropped_blocks) tracks its own
// records via `acknowledged`. Either way, acknowledging every record also
// completes it, which is how a "Mark handled" on an items kind works.
export interface KindProgress {
  trackable: boolean;
  reviewed: number;
  total: number;
  complete: boolean;
  // Every record carries `acknowledged` (so an Undo can be offered).
  allAcknowledged: boolean;
}

export function kindProgress(entry: WarningKindGroup, reviewedIds?: ReadonlySet<string>): KindProgress {
  const allAcknowledged = entry.records.length > 0 && entry.records.every((record) => record.acknowledged === true);
  if (entry.group === 'info') {
    return { trackable: false, reviewed: 0, total: 0, complete: false, allAcknowledged };
  }
  if (entry.nodeIds.length > 0) {
    const reviewed = reviewedIds ? entry.nodeIds.filter((nodeId) => reviewedIds.has(nodeId)).length : 0;
    return { trackable: true, reviewed, total: entry.nodeIds.length, complete: reviewed === entry.nodeIds.length || allAcknowledged, allAcknowledged };
  }
  const reviewed = entry.records.filter((record) => record.acknowledged === true).length;
  return { trackable: true, reviewed, total: entry.records.length, complete: reviewed === entry.records.length, allAcknowledged };
}

// What a tree row's reason chip can say: the warning's own group, or that
// the reviewer already marked this item.
export type ReasonTone = WarningGroup | 'done';

// Enhancement failures that can be retried for just their affected items.
// `parent_summary` is not offered: it needs every descendant's text, so the
// fix for that pass is a resubmit. One batch group per pass, since the
// server retries one pass at a time.
export type RetryablePass = 'title_tag' | 'synthesis';

export function retryableEnhancementBatches(entry: WarningKindGroup): { pass: RetryablePass; localIds: string[] }[] {
  if (entry.kind !== 'enhancement_call_failed' && entry.kind !== 'enhancement_response_incomplete') return [];
  const byPass = new Map<RetryablePass, string[]>();
  for (const record of entry.records) {
    const pass = record.detail?.pass;
    if (pass !== 'title_tag' && pass !== 'synthesis') continue;
    const ids = byPass.get(pass) ?? [];
    for (const nodeId of record.nodeIds) if (!ids.includes(nodeId)) ids.push(nodeId);
    byPass.set(pass, ids);
  }
  return [...byPass].filter(([, localIds]) => localIds.length > 0).map(([pass, localIds]) => ({ pass, localIds }));
}
