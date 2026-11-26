import { useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { ElapsedTimer } from './ElapsedTimer';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Alert } from '../ui/Alert';
import type { FileReading, ProposalDecision } from '../api/jobs';
import { appliedCounts, isApplied } from '../utils/buildPreview';

// The new-job page's "What was read from the file" (the approved mockup, 2026-11-25): while the study runs, what it does and how long it has
// taken; then one verdict line and the decisions -- a structure change the study proposes, applied unless the user undoes it before Start
// (owner rule R4, 2026-11-26). The detail
// lives in "About this file". Headings sit on the page, not in a card.

const KIND_LABEL: Record<string, string> = {
  requirements_export: 'a requirements-tool export',
  requirements_spec: 'a requirements specification',
  prose_spec: 'a specification written as prose',
};

export function kindLabel(kind: FileReading['kind']): string {
  return (kind && KIND_LABEL[kind]) || 'a document';
}

/** The verdict's counts, as one line: as the job will build them, with the proposals that apply. */
export function verdictCounts(reading: FileReading, decisions: Record<string, ProposalDecision | undefined> = {}): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const { epics, features } = appliedCounts(reading, decisions);
  return [plural(reading.requirements, 'requirement'), `${reading.withIds} with IDs`, plural(epics, 'Epic'), plural(features, 'Feature')].join(' · ');
}

// What the study does, in order. It is one call to the server, which reports no step of its own: the list says what happens, it does not
// claim which step is running.
const STUDY_STEPS = ["Reading the file's layout and headings", 'Asking the model three times how the file states its requirements', 'Checking every answer against the file'];

interface Props {
  status: 'studying' | 'ready' | 'failed';
  /** Why the study failed (status 'failed'): one plain sentence, cause first. */
  error?: string | null;
  /** Asks the study again (status 'failed'). */
  onRetry?: () => void;
  startedAt?: string;
  reading?: FileReading | null;
  decisions: Record<string, ProposalDecision | undefined>;
  onDecide: (headingId: string, decision: ProposalDecision) => void;
  onOpenAbout: () => void;
}

export function FileStudyPanel({ status, startedAt, reading, decisions, onDecide, onOpenAbout, error, onRetry }: Props): React.ReactElement {
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
  // The study is required (owner decision, 2026-11-25): the tree is built by what it learned, so a failed study holds Start and offers to try
  // again here, in the same place the result would be, rather than falling back to building from the headings alone.
  if (status === 'failed') {
    return (
      <section aria-labelledby="file-study-heading" className="flex flex-col gap-2.5" data-testid="file-study-panel">
        <h2 id="file-study-heading" className="text-title">
          The file could not be studied
        </h2>
        <Alert severity="warning">
          <div className="flex flex-col gap-2" data-testid="file-study-failed">
            <span>{error || 'The model did not finish reading the file.'} Start waits until the study succeeds.</span>
            <span className="text-xs">Try again. If it keeps failing, choose a faster model or ask your administrator.</span>
            {onRetry && (
              <div>
                <Button size="sm" variant="outline" onClick={onRetry}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
                </Button>
              </div>
            )}
          </div>
        </Alert>
      </section>
    );
  }
  if (!reading) return <></>;
  const undone = reading.decisions.filter((d) => !isApplied(decisions[d.headingId])).length;
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
            {verdictCounts(reading, decisions)}
          </p>
        </div>
      </div>
      {reading.decisions.length > 0 && (
        <div className="overflow-hidden rounded-md border border-hairline bg-surface" data-testid="file-study-decisions">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline bg-surface-alt px-3 py-2 text-sm">
            <span className="font-semibold text-ink-1">
              {reading.decisions.length} change{reading.decisions.length === 1 ? '' : 's'} to the file&apos;s structure
              {undone > 0 ? ` · ${undone} undone` : ''}
            </span>
            <span className="text-xs text-ink-3">Applied unless you undo them before Start.</span>
          </div>
          <ul>
            {reading.decisions.map((d) => {
              const applied = isApplied(decisions[d.headingId]);
              const text = !applied
                ? `Kept “${d.title}” as the file has it`
                : d.action === 'rename'
                  ? `Renamed “${d.title}” to “${d.newTitle}”`
                  : `Removed the level “${d.title}”`;
              return (
                <li key={d.headingId} className="grid grid-cols-1 items-center gap-2 border-t border-hairline px-3 py-2 text-sm first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <span dir="auto">{text}</span>{' '}
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
                  <Button
                    size="sm"
                    variant="outline"
                    className="justify-self-start sm:justify-self-end"
                    aria-label={applied ? `Undo: keep “${d.title}” as the file has it` : `Apply the change to “${d.title}” again`}
                    onClick={() => onDecide(d.headingId, applied ? 'keep' : 'accept')}
                  >
                    {applied ? (
                      <>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Undo
                      </>
                    ) : (
                      'Apply again'
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
