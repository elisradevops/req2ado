import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, TriangleAlert, FileSearch, Info } from 'lucide-react';
import { cn } from '../lib/cn';
import { buildWorkItemUrl } from '../utils/adoLinks';

type WarningGroupKind = 'dropped-block' | 'external-reference' | 'conflict' | 'other';

const CONFLICT_LOCAL_ID_RE = /\[localId: ([^\]]+)\]/g;

function extractConflictLocalIds(warning: string): string[] {
  return [...warning.matchAll(CONFLICT_LOCAL_ID_RE)].map((match) => match[1]);
}

// Classifies a raw warning string by its known prefix -- both patterns
// come from a small, fixed set of message templates in
// ingestion/app/leveling/llm_leveling.py (build_survey_tree/
// _build_survey_tree_for_branch), not free-form LLM text, so matching on
// their stable prefixes is reliable. Everything else (truncation, invalid
// node type, dangling parent, low grounding, scoring failures) falls into
// 'other' -- distinct failure modes, but each rare enough on their own that
// a dedicated group per kind isn't worth it yet; grouped under one general
// notice instead of silently lost among the two common kinds.
function classifyWarning(warning: string): WarningGroupKind {
  if (warning.startsWith('SURVEY analysis did not reference')) return 'dropped-block';
  if (warning.includes('references an external artifact')) return 'external-reference';
  if (warning.startsWith('Near-duplicate items')) return 'conflict';
  return 'other';
}

const GROUP_META: Record<
  WarningGroupKind,
  { icon: React.ComponentType<{ className?: string }>; title: string; tip: string }
> = {
  'dropped-block': {
    icon: FileSearch,
    title: 'Content the model may have dropped',
    tip:
      'These source blocks weren\'t referenced (even paraphrased) in any generated work item. Often this is fine -- ' +
      'short structural labels, standalone figure captions, or cross-references genuinely don\'t need their own ' +
      'requirement. Read each preview below; if real technical content is missing, it usually means the model under-' +
      'synthesized that section -- re-running SURVEY on just that section, or trying a different model, can help.',
  },
  'external-reference': {
    icon: FileSearch,
    title: 'References to documents not in your knowledge base',
    tip:
      'The source document points to an external artifact (a spreadsheet, another spec, a numbered requirement ID) ' +
      'that was never ingested -- SURVEY can\'t verify or incorporate content it doesn\'t have. Add the referenced ' +
      'document to your knowledge base so future runs can ground against it.',
  },
  conflict: {
    icon: TriangleAlert,
    title: 'Near-duplicate items with conflicting values',
    tip:
      'These items describe the same thing but state different values (e.g. two different power figures for the ' +
      'same spec) -- likely the source document restates the same parameter inconsistently, or the model split one ' +
      'requirement into near-duplicates. The "[localId: ...]" tag is an internal reference for THIS run only -- ' +
      'never a real Azure DevOps work item number -- use the buttons below to actually locate each item: "Review ' +
      'item" jumps to it in the diff tree; "View WI #N in Azure DevOps" (shown only when this item already exists ' +
      'there) opens the real work item.',
  },
  other: {
    icon: Info,
    title: 'Other analysis notices',
    tip:
      'Lower-level signals from this run (output truncated by the token limit, an unexpected node type, a dangling ' +
      'parent reference, low grounding, or a scoring failure for a specific node). Usually safe to ignore unless the ' +
      'affected item looks wrong in the diff below -- if so, re-running SURVEY (optionally with a different model) ' +
      'is the general fix.',
  },
};

const GROUP_ORDER: WarningGroupKind[] = ['dropped-block', 'external-reference', 'conflict', 'other'];

// SURVEY's integrity warnings (dropped-block references, external-artifact
// mentions, and assorted lower-level analysis notices) can run into the
// dozens on a large document. Grouped by kind (not rendered as one flat
// list of near-identical amber rows) so a reviewer can tell WHY each kind
// happens and WHAT to do about it once, rather than re-reading the same
// prose fragment N times -- and external-reference warnings get a real
// action (jump to the knowledge base) instead of just describing one.
export function CollapsibleWarnings({
  warnings,
  onJumpToNode,
  adoIdByLocalId,
  orgUrl,
  project,
}: {
  warnings: string[];
  onJumpToNode?: (localId: string) => void;
  // Real gap this closes (user-reported): a conflict warning's
  // "[localId: ...]" is an internal, THIS-RUN-ONLY reference that never
  // means anything outside the app -- for an item that's a near-duplicate
  // of something ALREADY in Azure DevOps (dedup_skip/reuse, see
  // DryRunDiffEntry.existingAdoId), the localId alone gave no way to find
  // the REAL work item to actually verify the conflict against. Caller
  // (JobDetail.tsx) builds this from the diff it already has -- localId ->
  // existingAdoId, only for entries that have one.
  adoIdByLocalId?: Record<string, number>;
  // Needed to construct a real, clickable ADO deep link
  // (`${orgUrl}/_workitems/edit/{id}`) -- null/undefined (no ADO
  // credential connected yet) just omits the link, same as every other
  // ADO-dependent affordance in this app.
  orgUrl?: string | null;
  // The job's team project (areaPath's first `\`-delimited segment) --
  // see buildWorkItemUrl's own docstring for why this matters.
  project?: string | null;
}): React.ReactElement | null {
  const [expandedGroups, setExpandedGroups] = useState<Set<WarningGroupKind>>(new Set());
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  if (warnings.length === 0) return null;

  const grouped: Record<WarningGroupKind, string[]> = {
    'dropped-block': [],
    'external-reference': [],
    conflict: [],
    other: [],
  };
  for (const warning of warnings) {
    grouped[classifyWarning(warning)].push(warning);
  }

  function toggleGroup(kind: WarningGroupKind): void {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <div className="overflow-hidden rounded-sm border border-[#EED8B4] bg-[#FDF6EC]">
      <button
        type="button"
        onClick={() => setSummaryExpanded((prev) => !prev)}
        aria-expanded={summaryExpanded}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-[#7A4F0B]"
      >
        {summaryExpanded ? <ChevronDown className="h-4 w-4 flex-none" /> : <ChevronRight className="h-4 w-4 flex-none" />}
        <TriangleAlert className="h-4 w-4 flex-none" />
        <span className="font-medium">
          {warnings.length} integrity warning{warnings.length === 1 ? '' : 's'}
        </span>
        <span className="text-[#9A6B1F]">-- document content SURVEY may have dropped or couldn't place</span>
      </button>
      {/* Always-mounted grid-row trick (not a conditional unmount) so the
          expand/collapse actually animates -- grid-template-rows is
          transitionable, height:auto is not. */}
      <div className={cn('grid min-h-0 transition-[grid-template-rows] duration-200 ease-out', summaryExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-2 border-t border-[#EED8B4] px-3.5 py-2.5">
            {GROUP_ORDER.filter((kind) => grouped[kind].length > 0).map((kind) => {
              const { icon: Icon, title, tip } = GROUP_META[kind];
              const items = grouped[kind];
              const isOpen = expandedGroups.has(kind);
              return (
                <div key={kind} className="overflow-hidden rounded-sm border border-[#EED8B4]/70 bg-white/40">
                  <button
                    type="button"
                    onClick={() => toggleGroup(kind)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm text-[#7A4F0B]"
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5 flex-none" /> : <ChevronRight className="h-3.5 w-3.5 flex-none" />}
                    <Icon className="h-3.5 w-3.5 flex-none" />
                    <span className="font-medium">{title}</span>
                    <span className="text-[#9A6B1F]">({items.length})</span>
                  </button>
                  {isOpen && (
                    <div className="flex flex-col gap-2 border-t border-[#EED8B4]/70 px-2.5 py-2.5">
                      <p className="text-xs text-[#7A4F0B]">{tip}</p>
                      {kind === 'external-reference' && (
                        <Link
                          to="/knowledge-base"
                          className="w-fit rounded-sm border border-[#EED8B4] bg-white px-2.5 py-1 text-xs font-medium text-[#7A4F0B] hover:border-[#9A6B1F]"
                        >
                          Add to knowledge base →
                        </Link>
                      )}
                      <ul className="flex flex-col gap-2 border-t border-[#EED8B4]/60 pt-2">
                        {items.map((warning, index) => (
                          <li key={index} className={cn('text-sm text-[#7A4F0B]', index > 0 && 'border-t border-[#EED8B4]/40 pt-2')}>
                            <p>{warning}</p>
                            {kind === 'conflict' && (onJumpToNode || adoIdByLocalId) && (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {extractConflictLocalIds(warning).map((localId) => {
                                  const adoId = adoIdByLocalId?.[localId];
                                  return (
                                    <span key={localId} className="flex flex-wrap gap-1.5">
                                      {onJumpToNode && (
                                        <button
                                          type="button"
                                          onClick={() => onJumpToNode(localId)}
                                          className="rounded-sm border border-[#EED8B4] bg-white px-2 py-0.5 text-xs font-medium text-[#7A4F0B] hover:border-[#9A6B1F]"
                                        >
                                          Review item →
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
                                          className="rounded-sm border border-[#EED8B4] bg-white px-2 py-0.5 text-xs font-medium text-[#7A4F0B] hover:border-[#9A6B1F]"
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
