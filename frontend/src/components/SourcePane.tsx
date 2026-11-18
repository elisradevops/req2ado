import { useEffect, useState } from 'react';
import { getEntrySource, type EntrySource } from '../api/jobs';
import { Skeleton, useSkeletonCrossfade } from '../ui/Skeleton';
import { Button } from '../ui/Button';
import { LABEL_MICRO } from '../utils/labelMicro';
import { cn } from '../lib/cn';
import type { DryRunDiffEntry } from './DiffTree';
import { SourceProvenance } from './SourceProvenance';

export const SOURCE_KIND_LABEL: Record<'text' | 'table' | 'section', string> = {
  text: 'Source wording',
  table: 'From a table in the source',
  // A SURVEY item is written from its section, not copied from one sentence of it.
  section: 'Written from this part of the source',
};

// The item's original wording, fetched when the dialog shows the item. undefined while loading, null when there is none to show
// (unavailable, or the request failed). Keyed by job and item: when J/K moves on before an answer arrives, the late answer is
// dropped twice over (the effect's cleanup flag, and the key check), so item A's words never appear under item B.
export function useEntrySource(jobId: string | undefined, entry: DryRunDiffEntry): Extract<EntrySource, { text: string }> | null | undefined {
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


// Letters and digits only, so "the same words" survives whitespace, punctuation and markdown marks, and nothing weaker passes.
const lettersOf = (text: string): string => text.replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

// Whether the item's text is the source wording itself (BASELINE copies it): the quote is then redundant, so one line says so.
export function isSameAsSource(description: string, source: { kind: string; text: string; truncated?: boolean }): boolean {
  if (source.kind !== 'text' || source.truncated) return false;
  const quote = lettersOf(source.text);
  return quote.length > 0 && quote === lettersOf(description);
}

// The Source column of the item dialog (DESIGN.md §11.6): where the item came from and the original wording, beside the proposed text.
// Chosen from `entry.sourceRef`, which is known at once, never from the fetched quote, so the layout does not jump when J/K steps on.
// A long quote is clamped to ten lines with a button while the columns are stacked; in two columns it runs on and scrolls with the page.
export function SourcePane({ entry, jobId }: { entry: DryRunDiffEntry; jobId?: string }): React.ReactElement {
  const source = useEntrySource(jobId, entry);
  const fade = useSkeletonCrossfade(source === undefined);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [entry.localId]);
  let quote: React.ReactNode = null;
  if (source === undefined) {
    quote = (
      <div data-testid="source-wording-loading" role="status" aria-busy="true" className="flex flex-col gap-1.5 py-0.5">
        <span className="sr-only">Loading the source wording…</span>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  } else if (source && isSameAsSource(entry.description, source)) {
    quote = <p className="text-sm text-ink-2">Same as the source.</p>;
  } else if (source) {
    quote = (
      <figure className={cn('flex flex-col gap-1', fade)}>
        <figcaption className="text-xs text-ink-3">{SOURCE_KIND_LABEL[source.kind]}</figcaption>
        <blockquote
          dir="auto"
          className={cn('whitespace-pre-line border-s-2 border-hairline ps-3 text-sm text-ink-1', !expanded && 'line-clamp-10 @4xl:line-clamp-none')}
        >
          {source.text}
        </blockquote>
        {source.text.split('\n').length > 10 || source.text.length > 900 ? (
          <Button size="sm" variant="ghost" className="w-fit @4xl:hidden" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Show less' : 'Show full quote'}
          </Button>
        ) : null}
        {source.truncated && <p className="text-xs text-ink-3">Shortened.</p>}
      </figure>
    );
  } else {
    quote = <p className="text-xs text-ink-3">The original wording is in the source file, at the location above.</p>;
  }
  return (
    <section aria-labelledby={`source-${entry.localId}`} className="flex min-w-0 flex-col gap-2 @4xl:border-s @4xl:border-hairline @4xl:ps-6">
      <h3 id={`source-${entry.localId}`} className={cn(LABEL_MICRO, 'text-ink-2')}>
        Source
      </h3>
      {entry.sourceRef && <SourceProvenance sourceRef={entry.sourceRef} showScoringNote={false} />}
      {quote}
    </section>
  );
}
