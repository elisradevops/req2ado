import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, TriangleAlert, CircleCheck, CircleX } from 'lucide-react';
import { cn } from '../lib/cn';
import { buildWorkItemUrl } from '../utils/adoLinks';
import type { WarningRecord, WarningSeverity } from '../utils/warnings';

const SEVERITY_ORDER: WarningSeverity[] = ['auto_fixed', 'needs_review', 'pipeline_issue'];

const SEVERITY_META: Record<
  WarningSeverity,
  {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    shortLabel: string;
    className: string;
    dividerClassName: string;
  }
> = {
  auto_fixed: {
    icon: CircleCheck,
    title: 'Automatically fixed',
    shortLabel: 'fixed automatically',
    className: 'border-ok-border bg-ok-soft text-ok-ink',
    dividerClassName: 'border-ok-border/60',
  },
  needs_review: {
    icon: TriangleAlert,
    title: 'Needs your review',
    shortLabel: 'need your review',
    className: 'border-warning-border bg-warning-soft text-warning-ink',
    dividerClassName: 'border-warning-border/60',
  },
  pipeline_issue: {
    icon: CircleX,
    title: 'Pipeline issue',
    shortLabel: 'pipeline issue',
    className: 'border-danger-border bg-danger-soft text-danger-ink',
    dividerClassName: 'border-danger-border/60',
  },
};

interface KindMeta {
  title: string;
  tip: string;
}

// Closed vocabulary (see ingestion's app.workitem.model.WarningKind and its
// own mirrored comment in orchestrator's dry-run.service.ts WarningRecord)
// -- `kind` on WarningRecord is `string`, not a TS union, since ingestion
// can add a kind without a matching frontend release. kindMeta's fallback
// below is what renders for a kind not yet listed here.
const KIND_META: Record<string, KindMeta> = {
  reparented_to_feature: {
    title: 'Re-parented under a Feature',
    tip: 'A Requirement sat directly under an Epic (or had no parent) -- moved under a Feature to keep the Epic → Feature → Requirement chain valid. Structure only, no content changed.',
  },
  group_reparented: {
    title: 'Table group re-parented',
    tip: "A source table group was attached under the wrong ancestor -- moved to match the table's own ID hierarchy.",
  },
  bridge_feature_synthesized: {
    title: 'Grouping Feature inserted',
    tip: 'A section had Requirement(s) with no Feature ancestor -- a grouping Feature was inserted to keep the hierarchy valid. It carries no requirement text of its own.',
  },
  roots_regrouped: {
    title: 'Disconnected sections grouped by topic',
    tip: 'The document had no single top heading, so related root sections were grouped under a new Feature/Epic by topic. Structure only, no content invented.',
  },
  catchall_epic_wrap: {
    title: 'Wrapped under a catch-all Epic',
    tip: 'Root Feature(s) with no Epic ancestor of their own were wrapped under a new catch-all Epic so every Feature traces to one.',
  },
  near_duplicate_conflict: {
    title: 'Near-duplicate items with conflicting values',
    tip:
      'These items describe the same thing but state different values (e.g. two different power figures for the ' +
      'same spec) -- likely the source document restates the same parameter inconsistently, or the model split one ' +
      'requirement into near-duplicates. Use the buttons below to actually locate each item: "Review" jumps to it ' +
      'in the diff tree; "View WI #N in Azure DevOps" (shown only when this item already exists there) opens the ' +
      'real work item.',
  },
  output_truncated: {
    title: 'Model output truncated',
    tip: "The model's response hit the token limit -- results for this section may be incomplete. Re-running with a higher output cap can help.",
  },
  no_model_title: {
    title: 'Title derived from description',
    tip: "The model didn't return a title for this item -- one was derived automatically from its description text.",
  },
  invalid_figure_ids: {
    title: 'Invalid figure reference dropped',
    tip: "The model referenced a figure that wasn't offered in this section -- the invalid reference was dropped. Worth checking whether real content was expected here.",
  },
  invalid_table_ids: {
    title: 'Invalid table reference dropped',
    tip: "The model referenced a table that wasn't offered in this section -- the invalid reference was dropped. Worth checking whether real content was expected here.",
  },
  invalid_node_type: {
    title: 'Invalid item type defaulted',
    tip: 'The model returned a type outside Epic/Feature/Requirement -- defaulted to Requirement. Worth checking whether an Epic or Feature was really intended.',
  },
  dangling_parent: {
    title: 'Unresolved parent reference',
    tip: "The model referenced a parent that doesn't exist in this section's own output -- attached as a section root instead.",
  },
  low_grounding: {
    title: 'Low grounding -- possible fabrication',
    tip: "This item's generated description shares little vocabulary with its source text -- worth reviewing for possible fabrication.",
  },
  zero_nodes: {
    title: 'Section produced no items',
    tip: 'A section with real content produced zero work items -- likely a model or tool-calling failure for that section. Re-running (optionally with a different model) is the general fix.',
  },
  dropped_blocks: {
    title: 'Content the model may have dropped',
    tip:
      'These source blocks weren\'t referenced (even paraphrased) in any generated work item. Often this is fine -- ' +
      'short structural labels, standalone figure captions, or cross-references genuinely don\'t need their own ' +
      'requirement. Read each preview below; if real technical content is missing, it usually means the model under-' +
      'synthesized that section -- re-running SURVEY on just that section, or trying a different model, can help.',
  },
  missing_table_group_coverage: {
    title: 'Table group missing from output',
    tip: "A source table group with 2+ items of its own didn't produce a distinctly-titled node -- its children may have been folded into a broader ancestor instead.",
  },
  external_reference: {
    title: 'References to documents not in your knowledge base',
    tip:
      'The source document points to an external artifact (a spreadsheet, another spec, a numbered requirement ID) ' +
      'that was never ingested -- SURVEY can\'t verify or incorporate content it doesn\'t have. Add the referenced ' +
      'document to your knowledge base so future runs can ground against it.',
  },
  scoring_failed: {
    title: 'Quality scoring failed',
    tip: 'The quality-scoring call failed for a batch of items -- they were left unscored. Re-running, or rescoring individually, can help.',
  },
  scoring_missing: {
    title: 'No valid score returned',
    tip: "The model's scoring response didn't include a usable score for some items -- they were left unscored.",
  },
  scoring_inconsistent_categories: {
    title: 'Inconsistent scoring categories',
    tip: 'The model used different quality-category names across items in the same batch -- category gauges may look inconsistent for this batch.',
  },
  enhancement_call_failed: {
    title: 'Enhancement call failed',
    tip: 'An optional title/description/synthesis enhancement call failed for some items -- they kept their original deterministic text.',
  },
  enhancement_response_incomplete: {
    title: 'Enhancement response incomplete',
    tip: "An optional enhancement response didn't cover every requested item -- those kept their original deterministic text automatically.",
  },
  dropped_row: {
    title: 'Row not represented in the tree',
    tip: 'A source row had no node-producing ancestor to fold into -- its content is not represented anywhere in the proposed tree.',
  },
  front_matter_folded: {
    title: 'Front matter folded automatically',
    tip: 'Content preceding the first heading/numbering was folded into a synthetic front-matter node instead of being dropped.',
  },
  survey_title_distilled: {
    title: 'Title replaced automatically',
    tip: "This item's title was too generic or short to be useful, so it was replaced with a title distilled from the item's own generated description.",
  },
  missing_requirement_row_coverage: {
    title: 'A numbered source requirement is missing',
    tip: 'A source table row carries its own literal requirement identifier, but no generated work item claims it -- it may have been merged into another requirement or dropped entirely. Review the source table for this section.',
  },
  trace_link_inference_failed: {
    title: 'Trace-link inference failed',
    tip: 'Whole-document trace/coverage link inference failed -- no trace links were added, but every proposed item above is otherwise unaffected.',
  },
  trace_link_write_failed: {
    title: 'Trace links failed to write to Azure DevOps',
    tip: 'These trace/coverage links could not be written during confirm -- every work item itself was created successfully. Open the affected item below and use the retry control next to the link chip.',
  },
  heading_id_offset_mismatch: {
    title: 'Heading ID offset mismatch',
    tip: "Some headings' IDs didn't match the document's dominant heading-level offset -- excluded from deterministic structure detection and handled by the model path instead.",
  },
  ado_verification_failed: {
    title: 'Could not verify ADO items still exist',
    tip: 'A batch check confirming matched Azure DevOps items still exist failed -- they\'re shown unverified rather than blocked.',
  },
  missing_source_reference: {
    title: 'Requirement has no Customer ID / source reference',
    tip: 'The document had no literal number or ID this requirement could use as its own source reference -- none was invented. If the source document has one that could not be auto-detected, add it manually before confirming.',
  },
  duplicate_customer_id: {
    title: 'Customer ID removed -- reported on multiple requirements',
    tip: 'The same Customer ID was reported on more than one requirement, so it was removed from all of them rather than guessing which is correct. Review the source document and add the real ID manually if it has one.',
  },
  classification_not_representable: {
    title: "Classification not representable in this project's field",
    tip: "This requirement's classification has no matching value in this Azure DevOps project's Requirement Type field, so it was left at ADO's own default. Review and set it manually if needed.",
  },
  customer_id_field_not_configured: {
    title: 'Customer ID field not configured in this project',
    tip: "This requirement's Customer ID could not be written to Azure DevOps -- no matching field exists on the Requirement type in this project. The value is still saved in req2ado's own review UI.",
  },
  other: {
    title: 'Other analysis notices',
    tip: 'Lower-level signals from an earlier run, before this app tracked warning kinds individually. Usually safe to ignore unless the affected item looks wrong in the diff below.',
  },
};

function humanizeKind(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function kindMeta(kind: string): KindMeta {
  return KIND_META[kind] ?? { title: humanizeKind(kind), tip: 'See the sentence below for details.' };
}

const REVIEW_LABEL_MAX_CHARS = 40;

function truncateForLabel(text: string): string {
  return text.length > REVIEW_LABEL_MAX_CHARS ? `${text.slice(0, REVIEW_LABEL_MAX_CHARS - 1)}…` : text;
}

// SURVEY's integrity warnings can run into the dozens on a large document.
// Grouped by SEVERITY first (auto-fixed / needs-review / pipeline-issue --
// "what should I actually do about this") then by KIND within each severity
// (the specific reason, with its own tip) -- not rendered as one flat list
// of near-identical amber rows, and not grouped by kind alone (the earlier
// design), since the single most useful question a reviewer has is "do I
// need to act on this at all," which severity answers directly.
export function CollapsibleWarnings({
  warnings,
  onJumpToNode,
  adoIdByLocalId,
  titleByLocalId,
  orgUrl,
  project,
}: {
  warnings: WarningRecord[];
  onJumpToNode?: (localId: string) => void;
  // Real gap this closes (user-reported): a conflict warning's `nodeIds`
  // are internal, THIS-RUN-ONLY references that never mean anything outside
  // the app -- for an item that's a near-duplicate of something ALREADY in
  // Azure DevOps (dedup_skip/reuse, see DryRunDiffEntry.existingAdoId), a
  // localId alone gave no way to find the REAL work item to actually verify
  // the conflict against. Caller (JobDetail.tsx) builds this from the diff
  // it already has -- localId -> existingAdoId, only for entries that have
  // one.
  adoIdByLocalId?: Record<string, number>;
  // Disambiguates two-plus "Review item ->" buttons sitting side by side
  // (user-reported: identical labels read as duplicated UI even though
  // each targets a different item) -- localId -> the item's own title.
  titleByLocalId?: Record<string, string>;
  // Needed to construct a real, clickable ADO deep link
  // (`${orgUrl}/_workitems/edit/{id}`) -- null/undefined (no ADO
  // credential connected yet) just omits the link, same as every other
  // ADO-dependent affordance in this app.
  orgUrl?: string | null;
  // The job's team project (areaPath's first `\`-delimited segment) --
  // see buildWorkItemUrl's own docstring for why this matters.
  project?: string | null;
}): React.ReactElement | null {
  const [expandedSeverities, setExpandedSeverities] = useState<Set<WarningSeverity>>(new Set());
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  if (warnings.length === 0) return null;

  const bySeverity: Record<WarningSeverity, WarningRecord[]> = { auto_fixed: [], needs_review: [], pipeline_issue: [] };
  for (const warning of warnings) bySeverity[warning.severity].push(warning);

  const severityCountSummary = SEVERITY_ORDER.filter((s) => bySeverity[s].length > 0)
    .map((s) => `${bySeverity[s].length} ${SEVERITY_META[s].shortLabel}`)
    .join(', ');

  function toggleSeverity(severity: WarningSeverity): void {
    setExpandedSeverities((current) => {
      const next = new Set(current);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      return next;
    });
  }

  return (
    <div className="overflow-hidden rounded-sm border border-hairline bg-surface-alt">
      <button
        type="button"
        onClick={() => setSummaryExpanded((prev) => !prev)}
        aria-expanded={summaryExpanded}
        className="hoverable-row border-t-0 flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-ink-1"
      >
        {summaryExpanded ? <ChevronDown className="h-4 w-4 flex-none" /> : <ChevronRight className="h-4 w-4 flex-none" />}
        <span className="font-medium">
          {warnings.length} integrity warning{warnings.length === 1 ? '' : 's'}
        </span>
        <span className="text-ink-3">-- {severityCountSummary}</span>
      </button>
      {/* Always-mounted grid-row trick (not a conditional unmount) so the
          expand/collapse actually animates -- grid-template-rows is
          transitionable, height:auto is not. */}
      <div className={cn('grid min-h-0 transition-[grid-template-rows] duration-200 ease-out', summaryExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-2 border-t border-hairline px-3.5 py-2.5">
            {SEVERITY_ORDER.filter((severity) => bySeverity[severity].length > 0).map((severity) => {
              const { icon: Icon, title, className, dividerClassName } = SEVERITY_META[severity];
              const items = bySeverity[severity];
              const isOpen = expandedSeverities.has(severity);

              // Grouped by kind WITHIN this severity, preserving first-seen
              // order -- the kind is the specific reason, shown as a
              // sub-header once per kind, not once per warning.
              const kindOrder: string[] = [];
              const byKind: Record<string, WarningRecord[]> = {};
              for (const warning of items) {
                if (!byKind[warning.kind]) {
                  byKind[warning.kind] = [];
                  kindOrder.push(warning.kind);
                }
                byKind[warning.kind].push(warning);
              }

              return (
                <div key={severity} className={cn('overflow-hidden rounded-sm border', className)}>
                  <button
                    type="button"
                    onClick={() => toggleSeverity(severity)}
                    aria-expanded={isOpen}
                    className="hoverable-row border-t-0 flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm"
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5 flex-none" /> : <ChevronRight className="h-3.5 w-3.5 flex-none" />}
                    <Icon className="h-3.5 w-3.5 flex-none" />
                    <span className="font-medium">{title}</span>
                    <span className="opacity-70">({items.length})</span>
                  </button>
                  {isOpen && (
                    <div className={cn('flex flex-col gap-3 border-t px-2.5 py-2.5', dividerClassName)}>
                      {kindOrder.map((kind) => {
                        const { title: kindTitle, tip } = kindMeta(kind);
                        const kindItems = byKind[kind];
                        return (
                          <div key={kind} className="flex flex-col gap-2">
                            <p className="text-xs font-semibold">
                              {kindTitle} <span className="font-normal opacity-70">({kindItems.length})</span>
                            </p>
                            <p className="text-xs opacity-80">{tip}</p>
                            {kind === 'external_reference' && (
                              <Link
                                to="/knowledge-base"
                                className="w-fit rounded-sm border border-current/30 bg-white px-2.5 py-1 text-xs font-medium hover:border-current"
                              >
                                Add to knowledge base →
                              </Link>
                            )}
                            <ul className={cn('flex flex-col gap-2 border-t pt-2', dividerClassName)}>
                              {kindItems.map((warning, index) => (
                                <li key={index} className={cn('text-sm', index > 0 && cn('border-t pt-2', dividerClassName))}>
                                  <p>
                                    {warning.raw}
                                    {warning.legacy && <span className="ml-1.5 text-xs opacity-60">(from an older run)</span>}
                                  </p>
                                  {warning.nodeIds.length > 0 && (onJumpToNode || adoIdByLocalId) && (
                                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                                      {warning.nodeIds.map((localId, nodeIndex) => {
                                        const adoId = adoIdByLocalId?.[localId];
                                        const itemTitle = titleByLocalId?.[localId];
                                        return (
                                          <span key={localId} className="flex flex-wrap gap-1.5">
                                            {onJumpToNode && (
                                              <button
                                                type="button"
                                                onClick={() => onJumpToNode(localId)}
                                                className="rounded-sm border border-current/30 bg-white px-2 py-0.5 text-xs font-medium hover:border-current"
                                              >
                                                Review {itemTitle ? `"${truncateForLabel(itemTitle)}"` : `item ${nodeIndex + 1}`} →
                                              </button>
                                            )}
                                            {/* Only rendered when this item already exists in ADO
                                                (dedup_skip/reuse) -- a plain "create" item has no real
                                                work item yet, so there's nothing to link to. */}
                                            {adoId != null && orgUrl && (
                                              <a
                                                href={buildWorkItemUrl(orgUrl, project, adoId)}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="rounded-sm border border-current/30 bg-white px-2 py-0.5 text-xs font-medium hover:border-current"
                                              >
                                                View WI #{adoId} in Azure DevOps ↗
                                              </a>
                                            )}
                                          </span>
                                        );
                                      })}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
