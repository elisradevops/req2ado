import { categoryLabel, weakestCategory } from '../utils/qualityCategories';
import type { DryRunDiffEntry } from './DiffTree';
import { SourceProvenance } from './SourceProvenance';
import type { KbCitation } from './KbCitationChips';

// What a reviewer needs to judge an item without leaving the dialog: where it came from, which
// KB documents informed its score, and where it scored worst. Shown for every item, clean ones
// included. Whether an item is scored, or its scores are stale, is the details pane's to say, so
// the strip stays silent about both in its own text. The wording-only scoring note describes a score,
// so it needs a fresh one: a SURVEY "create" Requirement with a score that is not stale, with or without
// a source location (the weakest-area row likewise needs fresh category scores). The source TEXT is not part of it: only offsets are stored
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
  const noteApplies = jobMode === 'survey' && entry.type === 'Requirement' && entry.action === 'create' &&
    entry.qualityScore != null &&
    !entry.qualityStale;
  return (
    <section aria-label="Evidence" className="flex flex-col gap-2 border-b border-hairline bg-surface-alt px-5 py-3 text-sm">
      {(entry.sourceRef || hasCitations || noteApplies) && (
        <SourceProvenance sourceRef={entry.sourceRef} showScoringNote={noteApplies} kbCitations={kbCitations} />
      )}
      {!entry.sourceRef && <p className="text-xs text-ink-3">No source location recorded.</p>}
      {weakest && (
        <div className="flex flex-col gap-0.5">
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-2">
            <span className="font-semibold">Weakest area</span>
            {/* The punctuation is for screen readers only: without it the row is read as loose words and a number. */}
            <span className="sr-only">: </span>
            <span dir="auto" className="font-medium text-ink-1">{categoryLabel(weakest.key)}</span>
            <span className="sr-only">, </span>
            <span className="tabular-nums text-ink-1">
              {weakest.score} <span className="text-ink-3">of 100</span>
            </span>
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
