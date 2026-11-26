import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { SectionCard } from '../ui/SectionCard';
import type { FileReading, ProposalDecision } from '../api/jobs';
import { applyDecisions } from '../utils/buildPreview';

// The new-job page's "What it will build" (the approved mockup, 2026-11-25): the Epics and Features the job will build, with their
// requirement counts, with the study's proposals applied unless the user undid them (owner rule R4, 2026-11-26). The one place the tree is previewed ("About this file" has no copy).

export function BuildPreview({ reading, decisions }: { reading: FileReading; decisions: Record<string, ProposalDecision | undefined> }): React.ReactElement {
  const { rows, removed } = applyDecisions(reading.outline, reading.decisions, decisions);
  const epics = rows.filter((r) => r.type === 'Epic').length;
  const features = rows.filter((r) => r.type === 'Feature').length;
  return (
    <SectionCard title="What it will build" action={<span className="font-mono text-meta text-ink-3">{rows.length + reading.requirements} items</span>}>
      <div className="flex flex-col gap-2" data-testid="build-preview">
        <ul className="relative flex max-h-[340px] flex-col gap-0.5 overflow-y-auto" aria-label="Epics and Features">
          {rows.map((row) => (
            <li key={row.id} className="flex min-h-6 items-center gap-1.5 text-sm" style={{ paddingLeft: `${row.depth * 14}px` }}>
              <WorkItemTypeBadge type={row.type} iconOnly />
              <span dir="auto" className={`min-w-0 truncate ${row.was ? 'font-semibold text-accent-ink' : ''}`} title={row.was ? `Renamed from ${row.was}` : undefined}>
                {row.title}
              </span>
              {row.undone && (
                <span className="flex-none text-xs text-ink-3" title="You undid the proposed change: it keeps the file's original.">
                  as in the file
                </span>
              )}
              <span className="ml-auto pl-2 font-mono text-xs text-ink-3">{row.requirements}</span>
            </li>
          ))}
        </ul>
        {reading.outlineMore > 0 && <p className="text-xs text-ink-3">and {reading.outlineMore} more</p>}
        <p className="border-t border-hairline pt-2 text-xs text-ink-3">
          <span className="font-mono">
            {epics} Epics · {features} Features · {reading.requirements} Requirements
          </span>
          <br />
          {removed.length > 0 && `Removed level: ${removed.join(', ')}. `}Numbers are requirements. Updates as you undo or apply a change.
        </p>
      </div>
    </SectionCard>
  );
}
