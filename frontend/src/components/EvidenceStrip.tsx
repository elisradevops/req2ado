import { categoryLabel, weakestCategory } from '../utils/qualityCategories';
import { isScoredType } from '../utils/diffFlagging';
import type { DryRunDiffEntry } from './DiffTree';
import { SourceProvenance } from './SourceProvenance';
import { Disclosure } from '../ui/Disclosure';
import { clampScore } from './QualityGauge';
import type { KbCitation } from './KbCitationChips';
import { useEffect, useState } from 'react';
import { getEntrySource, type EntrySource } from '../api/jobs';
import { Skeleton, useSkeletonCrossfade } from '../ui/Skeleton';
import { cn } from '../lib/cn';

const SOURCE_KIND_LABEL: Record<'text' | 'table' | 'section', string> = {
  text: 'Source wording',
  table: 'From a table in the source',
  // A SURVEY item is written from its section, not copied from one sentence of it.
  section: 'Written from this part of the source',
};

// The item's original wording, fetched when the dialog shows the item. undefined while loading, null when there is none to show
// (unavailable, or the request failed). Keyed by job and item: when J/K moves on before an answer arrives, the late answer is
// dropped twice over (the effect's cleanup flag, and the key check), so item A's words never appear under item B.
function useEntrySource(jobId: string | undefined, entry: DryRunDiffEntry): Extract<EntrySource, { text: string }> | null | undefined {
  const key = jobId && entry.sourceRef ? `${jobId}\u0000${entry.localId}` : null;
  const [answer, setAnswer] = useState<{ key: string; source: Extract<EntrySource, { text: string }> | null } | null>(null);
  useEffect(() => {
    if (!key || !jobId) return;
    const controller = new AbortController();
    let current = true;
    // Through a resolved promise, so even a synchronous throw lands in the failure branch and never breaks the dialog.
    Promise.resolve()
      .then(() => getEntrySource(jobId, entry.localId, controller.signal))
      .then(
        (source) => {
          if (current) setAnswer({ key, source: source && source.kind !== 'unavailable' ? source : null });
        },
        () => {
          if (current) setAnswer({ key, source: null });
        },
      );
    return () => {
      current = false;
      controller.abort();
    };
  }, [key, jobId, entry.localId]);
  if (!key) return null;
  return answer && answer.key === key ? answer.source : undefined;
}

// What a reviewer needs to judge an item without leaving the dialog: where it came from, which
// KB documents informed its score, and where it scored worst. Shown for every item, clean ones
// included. Whether an item is scored, or its scores are stale, is the details pane's to say, so
// the strip stays silent about both in its own text. The wording-only scoring note describes a score,
// so it needs a fresh one: a SURVEY "create" Requirement with a score that is not stale, with or without
// a source location (the weakest-area row likewise needs fresh category scores). Only offsets are stored with an item, so with a jobId the
// strip asks the server to read the wording again from the job's kept upload and quotes it; when there is none (no kept original, no span of
// its own, a failed read) it says where the original wording is instead of implying an excerpt. Every free-text block carries dir="auto" and
// inline names sit in <bdi>, so Hebrew content does not reorder the surrounding English.
export function EvidenceStrip({
  entry,
  jobId,
  jobMode,
  kbCitations,
  collapsible = false,
  quality,
}: {
  entry: DryRunDiffEntry;
  // The item's job: with it, the strip quotes the item's original wording (GET /jobs/:id/diff/:localId/source). Without it, the plain line.
  jobId?: string;
  jobMode?: 'baseline' | 'survey' | null;
  kbCitations?: KbCitation[];
  // The item dialog: the file, the location and the source line stay in view; the weakest area, the scoring note and the KB references
  // fold into one closed "How this was scored" disclosure (one level, nothing nested), so they do not push the requirement text down.
  collapsible?: boolean;
  // The item's Quality panel (gauge, score explanation, grounding line), folded into the same disclosure after the weakest area. Its
  // actions that change state (Re-check quality, Score this item) are the caller's to keep outside, in view.
  quality?: React.ReactNode;
}): React.ReactElement {
  // Only Requirements are scored: an Epic or Feature never names a weakest area, whatever its stored data holds.
  const weakest = entry.qualityStale || !isScoredType(entry.type) ? null : weakestCategory(entry.qualityCategoryScores, entry.qualityCategoryChecklist);
  const hasCitations = !!kbCitations && kbCitations.length > 0;
  const noteApplies = jobMode === 'survey' && entry.type === 'Requirement' && entry.action === 'create' &&
    entry.qualityScore != null &&
    !entry.qualityStale;

  const weakestRow = weakest ? (
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
          {'“'}
          {weakest.checklistText}
          {'”'}
        </p>
      )}
    </div>
  ) : null;

  const source = useEntrySource(jobId, entry);
  const sourceFade = useSkeletonCrossfade(source === undefined);
  let sourceLine: React.ReactNode = null;
  if (entry.sourceRef && source === undefined) {
    // Two text lines' worth of space, drawn only after the shared skeleton delay: a fast answer shows nothing, then the quote.
    sourceLine = (
      <div data-testid="source-wording-loading" role="status" aria-busy="true" className="flex max-w-[68ch] flex-col gap-1.5 py-0.5">
        <span className="sr-only">Loading the source wording…</span>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  } else if (entry.sourceRef && source) {
    sourceLine = (
      <figure className={cn('flex flex-col gap-1', sourceFade)}>
        <figcaption className="text-xs text-ink-3">{SOURCE_KIND_LABEL[source.kind]}</figcaption>
        <blockquote dir="auto" className="max-w-[68ch] whitespace-pre-line border-s-2 border-hairline ps-3 text-sm text-ink-1">
          {source.text}
        </blockquote>
        {source.truncated && <p className="text-xs text-ink-3">Shortened.</p>}
      </figure>
    );
  } else if (entry.sourceRef) {
    sourceLine = <p className="text-xs text-ink-3">The original wording is in the source file, at the location above.</p>;
  }

  if (collapsible) {
    const hasWhy = !!weakest || hasCitations || noteApplies || !!quality;
    // The closed line says what is worth knowing without opening it: the score (marked when it predates an edit) and the weakest area.
    const summaryParts: string[] = [];
    if (quality && entry.qualityScore != null) {
      summaryParts.push(`Quality ${clampScore(entry.qualityScore)} of 100${entry.qualityStale ? ', from before your edit' : ''}`);
    }
    if (weakest) summaryParts.push(`Weakest area: ${categoryLabel(weakest.key).replace(/[.。]$/, '')}, ${weakest.score} of 100`);
    return (
      <section aria-label="Evidence" className="flex flex-col gap-2 rounded-sm border border-hairline bg-surface-alt p-3 text-sm">
        {entry.sourceRef && <SourceProvenance sourceRef={entry.sourceRef} showScoringNote={false} />}
        {!entry.sourceRef && <p className="text-xs text-ink-3">No source location recorded.</p>}
        {sourceLine}
        {hasWhy && (
          <Disclosure
            title="How this was scored"
            summary={summaryParts.length > 0 ? <span dir="auto">{summaryParts.join(' · ')}</span> : undefined}
            className="bg-surface"
          >
            {(noteApplies || hasCitations) && <SourceProvenance sourceRef={null} showScoringNote={noteApplies} kbCitations={kbCitations} />}
            {weakestRow}
            {quality}
          </Disclosure>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Evidence" className="flex flex-col gap-2 border-b border-hairline bg-surface-alt px-5 py-3 text-sm">
      {(entry.sourceRef || hasCitations || noteApplies) && (
        <SourceProvenance sourceRef={entry.sourceRef} showScoringNote={noteApplies} kbCitations={kbCitations} />
      )}
      {!entry.sourceRef && <p className="text-xs text-ink-3">No source location recorded.</p>}
      {weakestRow}
      {sourceLine}
    </section>
  );
}
