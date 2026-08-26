import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { cn } from '../lib/cn';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { QualityGauge } from './QualityGauge';
import { Chip } from '../ui/Chip';

export interface SectionResultNode {
  type: string;
  title: string;
  text: string;
  qualityScore: number | null;
  customerId: string | null;
}

export interface SectionResultEntry {
  branchIndex: number;
  sectionLabel: string | null;
  nodes: SectionResultNode[];
  // Real per-section KB grounding, as of section_complete -- NOT the
  // analyze_section start event's kbCitations (always empty on the agentic
  // path, since real retrieval happens mid-call via query_kb). Surfaced
  // here because ProgressBanner's "Grounded against" chips only ever show
  // whichever narration event is currently `latest` -- for nearly the
  // entire multi-minute duration a section's LLM call is in flight, that's
  // still the start event's empty/false state, so a live viewer would have
  // to catch the split-second window right as section_complete fires to
  // ever see real citations. Accumulating them here (same pattern as
  // figureCaptionsByIndex/sectionResultsByIndex in JobDetail.tsx) keeps
  // real KB usage visible per section instead of flickering away.
  kbGrounded: boolean;
  kbCitations: { sourceFile: string; similarity: number }[];
}

// The real "parsed and formatted response" for a section -- lets a reviewer
// inspect what the model actually produced live, per section, instead of
// only ever seeing this content once the whole job reaches diff_ready. Not
// persisted (same convention as FigureDescriptions): populated directly
// from the SSE narration stream for as long as this job page stays open.
export function SectionResults({ items }: { items: SectionResultEntry[] }): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const totalNodes = items.reduce((sum, item) => sum + item.nodes.length, 0);

  return (
    <div className="overflow-hidden rounded-sm border border-hairline bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-ink-2"
      >
        {expanded ? <ChevronDown className="h-4 w-4 flex-none" /> : <ChevronRight className="h-4 w-4 flex-none" />}
        <FileText className="h-4 w-4 flex-none" aria-hidden="true" />
        <span className="font-medium">
          {items.length} section{items.length === 1 ? '' : 's'} analyzed -- {totalNodes} item{totalNodes === 1 ? '' : 's'} drafted
        </span>
      </button>
      <div className={cn('grid min-h-0 transition-[grid-template-rows] duration-200 ease-out', expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-2 border-t border-hairline px-3.5 py-2.5">
            {items.map((item) => (
              <SectionResultRow key={item.branchIndex} item={item} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionResultRow({ item }: { item: SectionResultEntry }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-sm border border-hairline/60">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm text-ink-2"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 flex-none" /> : <ChevronRight className="h-3.5 w-3.5 flex-none" />}
        <span className="font-medium text-ink-1">
          Section {item.branchIndex + 1}
          {item.sectionLabel && `: ${item.sectionLabel}`}
        </span>
        <span className="text-ink-3">-- {item.nodes.length} item{item.nodes.length === 1 ? '' : 's'}</span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 border-t border-hairline/60 px-2.5 py-2.5">
          {item.kbGrounded && item.kbCitations.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-ink-3">Grounded against:</span>
              {item.kbCitations.map((citation) => (
                <Chip
                  key={citation.sourceFile}
                  bg="var(--color-surface-alt)"
                  color="var(--color-ink-2)"
                  className="border border-hairline-strong font-mono text-meta font-normal"
                  title={`similarity ${Math.round(citation.similarity * 100)}%`}
                >
                  {citation.sourceFile}
                </Chip>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-3">Not grounded against your knowledge base for this section.</p>
          )}
          {item.nodes.map((node, index) => (
            <div key={index} className="flex flex-col gap-1.5 border-t border-hairline/40 pt-2.5 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-2">
                <WorkItemTypeBadge type={node.type} />
                <span className="text-sm font-medium text-ink-1">{node.title}</span>
                {/* Per-row requirement splitting live visibility (2026-08-26):
                    lets a reviewer confirm, section by section as the job
                    runs, that a source table's own row identifier actually
                    landed on the right node -- same mono/Requirement-only
                    convention as DiffTree's own Customer ID badge. */}
                {node.customerId && (
                  <span
                    className="flex-none truncate font-mono text-xs tracking-tight text-ink-3"
                    title={`Customer ID: ${node.customerId}`}
                  >
                    {node.customerId}
                  </span>
                )}
              </div>
              <p className="text-sm text-ink-2">{node.text}</p>
              {node.qualityScore != null && <QualityGauge score={node.qualityScore} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
