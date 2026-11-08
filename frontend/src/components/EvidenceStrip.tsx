import { categoryLabel, weakestCategory } from '../utils/qualityCategories';
import type { DryRunDiffEntry } from './DiffTree';
import { SourceProvenance } from './SourceProvenance';
import type { KbCitation } from './KbCitationChips';

// What a reviewer needs to judge an item without leaving the dialog: where it came from, which
// KB documents informed its score, and where it scored worst. Shown for every item, clean ones
// included. Whether an item is scored, or its scores are stale, is the details pane's to say, so
// the strip stays silent about both. The source TEXT is not part of it: only offsets are stored
// with an item, so the strip says so instead of implying an excerpt. Every free-text block carries dir="auto" and inline
// names sit in <bdi>, so Hebrew content does not reorder the surrounding English.
export function EvidenceStrip({
  entry,
  jobMode,
  kbCitations,
}: {
  entry: DryRunDiffEntry;
  jobMode?: 'baseline' | 'survey' | null;
  kbCitations?: KbCitation[];
}): React.ReactElement {
  const weakest = entry.qualityStale ? null : weakestCategory(entry.qualityCategoryScores, entry.qualityCategoryChecklist);
  const hasCitations = !!kbCitations && kbCitations.length > 0;
  return (
    <section aria-label="Evidence" className="flex flex-col gap-2 border-b border-hairline bg-surface-alt px-5 py-3 text-sm">
      {entry.sourceRef || hasCitations ? (
        <SourceProvenance
          sourceRef={entry.sourceRef}
          showScoringNote={entry.type === 'Requirement' && jobMode === 'survey' && weakest !== null}
          kbCitations={kbCitations}
        />
      ) : (
        <p className="text-xs text-ink-3">No source location recorded.</p>
      )}
      {weakest && (
        <div className="flex flex-col gap-0.5">
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-2">
            <span className="font-semibold">Weakest area</span>
            <span dir="auto" className="font-medium text-ink-1">{categoryLabel(weakest.key)}</span>
            <span className="tabular-nums text-ink-1">{weakest.score}</span>
            <span className="text-ink-3">of 100</span>
          </p>
          {weakest.checklistText && (
            <p dir="auto" className="max-w-[68ch] text-xs text-ink-2">
              {'\u201C'}
              {weakest.checklistText}
              {'\u201D'}
            </p>
          )}
        </div>
      )}
      {entry.sourceRef && <p className="text-xs text-ink-3">The source text is not stored with this item, only where it came from.</p>}
    </section>
  );
}
