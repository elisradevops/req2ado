import { useState } from 'react';
import { Check } from 'lucide-react';
import { ElapsedTimer } from './ElapsedTimer';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import type { FileReading, ProposalDecision } from '../api/jobs';

// The new-job page's "What was read from the file" (the approved mockup, 2026-11-25): while the study runs, what it does and how long it has
// taken; then one verdict line and the decisions -- a structure change the study proposes, never applied until the user accepts it. The detail
// lives in "About this file". Headings sit on the page, not in a card.

const KIND_LABEL: Record<string, string> = {
  requirements_export: 'a requirements-tool export',
  requirements_spec: 'a requirements specification',
  prose_spec: 'a specification written as prose',
};

export function kindLabel(kind: FileReading['kind']): string {
  return (kind && KIND_LABEL[kind]) || 'a document';
}

/** The verdict's counts, as one line. */
export function verdictCounts(reading: FileReading): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [plural(reading.requirements, 'requirement'), `${reading.withIds} with IDs`, plural(reading.epics, 'Epic'), plural(reading.features, 'Feature')].join(' · ');
}

// What the study does, in order. It is one call to the server, which reports no step of its own: the list says what happens, it does not
// claim which step is running.
const STUDY_STEPS = ["Reading the file's layout and headings", 'Asking the model three times how the file states its requirements', 'Checking every answer against the file'];

interface Props {
  status: 'studying' | 'ready';
  startedAt?: string;
  reading?: FileReading | null;
  decisions: Record<string, ProposalDecision | undefined>;
  onDecide: (headingId: string, decision: ProposalDecision) => void;
  onOpenAbout: () => void;
}

export function FileStudyPanel({ status, startedAt, reading, decisions, onDecide, onOpenAbout }: Props): React.ReactElement {
  const [why, setWhy] = useState<Record<string, boolean>>({});
  if (status === 'studying') {
    return (
      <section aria-labelledby="file-study-heading" className="flex flex-col gap-2.5" data-testid="file-study-panel">
        <h2 id="file-study-heading" className="text-title">
          Studying the file
        </h2>
        <div role="status" className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-sm text-ink-2">
            <Spinner /> The model reads how this file states its requirements; code checks every answer.
          </p>
          <ol className="flex list-decimal flex-col gap-1 pl-9 text-sm text-ink-2">
            {STUDY_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
        {/* Outside the status region: a clock announced every second would drown the message. */}
        {startedAt && (
          <p className="font-mono text-meta text-ink-3" data-testid="file-study-elapsed">
            <ElapsedTimer startedAt={startedAt} /> so far · Start waits for it
          </p>
        )}
      </section>
    );
  }
  if (!reading) return <></>;
  const open = reading.decisions.filter((d) => decisions[d.headingId] === undefined).length;
  return (
    <section aria-labelledby="file-study-heading" className="flex flex-col gap-2.5" data-testid="file-study-panel">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 id="file-study-heading" className="text-title">
          What was read from the file
        </h2>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onOpenAbout}>
          About this file
        </Button>
      </div>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full bg-ok text-white" aria-hidden="true">
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
        <div>
          <p className="text-sm font-semibold text-ink-1">Read as {kindLabel(reading.kind)}</p>
          <p className="text-sm tabular-nums text-ink-2" data-testid="file-study-counts">
            {verdictCounts(reading)}
          </p>
        </div>
      </div>
      {reading.decisions.length > 0 && (
        <div className="overflow-hidden rounded-md border border-hairline bg-surface" data-testid="file-study-decisions">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline bg-surface-alt px-3 py-2 text-sm">
            <span className="font-semibold text-ink-1">
              {reading.decisions.length} decision{reading.decisions.length === 1 ? '' : 's'}
              {open > 0 ? ` · ${open} open` : ''}
            </span>
            <span className="text-xs text-ink-3">Undecided ones keep the file&apos;s original.</span>
          </div>
          <ul>
            {reading.decisions.map((d) => {
              const text = d.action === 'rename' ? `Rename “${d.title}” to “${d.newTitle}”` : `Remove the level “${d.title}”`;
              const chosen = decisions[d.headingId];
              return (
                <li key={d.headingId} className="grid grid-cols-1 items-center gap-2 border-t border-hairline px-3 py-2 text-sm first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <span dir="auto">{text}</span>
                    <button
                      type="button"
                      className="ml-2 text-xs text-ink-3 underline underline-offset-2"
                      aria-expanded={Boolean(why[d.headingId])}
                      onClick={() => setWhy((current) => ({ ...current, [d.headingId]: !current[d.headingId] }))}
                    >
                      Why?
                    </button>
                    {why[d.headingId] && (
                      <p dir="auto" className="mt-0.5 text-xs text-ink-3">
                        {d.reason}
                      </p>
                    )}
                  </div>
                  <div role="group" aria-label={`Decision for ${d.title}`} className="flex">
                    {(['accept', 'keep'] as const).map((choice) => (
                      <Button
                        key={choice}
                        size="sm"
                        variant={chosen === choice ? 'primary' : 'outline'}
                        aria-pressed={chosen === choice}
                        className={choice === 'accept' ? 'rounded-r-none' : '-ml-px rounded-l-none'}
                        onClick={() => onDecide(d.headingId, choice)}
                      >
                        {choice === 'accept' ? 'Accept' : 'Keep'}
                      </Button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
