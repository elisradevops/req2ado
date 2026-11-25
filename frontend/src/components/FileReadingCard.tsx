import { ElapsedTimer } from './ElapsedTimer';
import { OverviewLines } from './DocumentOverviewCard';
import { StudyFindings, type StudyStatus } from './DocumentStudyCard';
import { FileRulesCard, type RulesStatus } from './FileRulesCard';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Disclosure } from '../ui/Disclosure';
import { SectionCard } from '../ui/SectionCard';
import { Spinner } from '../ui/Spinner';
import type { DocumentOverview, DocumentStudy, LeftOut, RulebookView } from '../api/jobs';
import { pagesPhrase } from '../utils/leftOut';

export interface FileReadingRules {
  status: RulesStatus;
  view: RulebookView | null;
  error: string | null;
  startedAt?: string;
  modelLabel?: string;
  modelHint?: { readWith: string; jobUses: string } | null;
}

export interface FileReadingStudy {
  status: StudyStatus;
  done: number;
  total: number;
  view: DocumentStudy | null;
  error: string | null;
  startedAt?: string;
}

interface Props {
  overview: DocumentOverview | undefined;
  leftOut: LeftOut | null | undefined;
  /** The optional AI summary (SURVEY): its text opens the card when written; while it is written one small line says so (Start never waits). */
  aiSummary: { status: 'idle' | 'pending' | 'ready' | 'none'; text?: string };
  onRewriteSummary: () => void;
  rules: FileReadingRules;
  study: FileReadingStudy;
  /** SURVEY's knowledge-base readiness, shown at the foot of the card. */
  knowledgeBase?: React.ReactNode;
  onRelearn: () => void;
  /** Stops waiting for both readings (the file's layout and the document): Start goes free, and the job reads what is missing itself. */
  onStopWaiting: () => void;
  /** After stopping: reads the file now after all. */
  onReadNow: () => void;
  onSaveEdit: (rulebook: Record<string, unknown>) => Promise<string | null>;
}

/** With AI review's optional summary of the file: its text once written, one line while it is written (Start never waits), and "Write it
 * again". Shared by this card and the study panel, so the summary shows whichever of the two the page uses. */
export function AiSummaryBlock({ aiSummary, onRewriteSummary }: { aiSummary: Props['aiSummary']; onRewriteSummary: () => void }): React.ReactElement {
  return (
    <>
      {aiSummary.status === 'ready' && aiSummary.text && (
        <div className="flex flex-col gap-1">
          <p dir="auto" className="break-words text-sm text-ink-1">{aiSummary.text}</p>
          <span className="text-xs text-ink-3">AI summary, written by a model from the document’s headings and opening text. Check it against the file.</span>
        </div>
      )}
      {aiSummary.status === 'pending' && (
        <p className="flex items-center gap-2 text-xs text-ink-3" role="status" data-testid="ai-summary-pending">
          <Spinner /> Writing an AI summary… optional, up to about 90 seconds. If you start now, the job runs without it.
        </p>
      )}
      {aiSummary.status === 'none' && <p className="text-xs text-ink-3">No AI summary this time. You can continue.</p>}
      {/* aria-disabled, not disabled: a natively disabled button drops keyboard focus, and this one is pressed from the keyboard. */}
      {aiSummary.status !== 'idle' && (
        <Button
          variant="outline"
          size="sm"
          className={aiSummary.status === 'pending' ? 'cursor-default self-start opacity-60' : 'self-start'}
          aria-disabled={aiSummary.status === 'pending'}
          onClick={() => {
            if (aiSummary.status !== 'pending') onRewriteSummary();
          }}
        >
          Write it again
        </Button>
      )}
    </>
  );
}

/** What is being waited on, as one line: the step (of two), and the part of the document for the second. Null when nothing is. */
export function readingLine(rules: FileReadingRules, study: FileReadingStudy): string | null {
  if (rules.status === 'idle' || rules.status === 'loading') return "Reading the file's layout · step 1 of 2";
  if (study.status === 'reading') {
    return study.total > 0 ? `Reading the document · step 2 of 2 · part ${Math.min(study.done + 1, study.total)} of ${study.total}` : 'Reading the document · step 2 of 2';
  }
  if (study.status === 'waiting' && rules.status !== 'cancelled') return 'Reading the document · step 2 of 2';
  return null;
}

/**
 * The wizard's one card about the file (BASELINE and SURVEY alike): what the file is and how it is built (its sections), what is left out (front
 * matter, by the document's own headings and pages), how items will be built (the rules, in words), and what the model learned from reading it.
 * One status line, one timer and one "Stop waiting" for the two readings Start waits on (DESIGN.md §11.2, §16.15, §16.20).
 */
export function FileReadingCard({ overview, leftOut, aiSummary, onRewriteSummary, rules, study, knowledgeBase, onRelearn, onStopWaiting, onReadNow, onSaveEdit }: Props): React.ReactElement {
  const waiting = readingLine(rules, study);
  const startedAt = rules.status === 'loading' ? rules.startedAt : study.startedAt;
  const stopped = rules.status === 'cancelled' || study.status === 'cancelled';
  return (
    <SectionCard title="This file and how it will be read">
      <div className="flex flex-col gap-4" data-testid="file-reading-card">
        {waiting && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex items-center gap-2 text-sm text-ink-2" role="status">
              <Spinner /> {waiting}
            </p>
            {/* Outside the status region: a clock announced every second would drown the message. */}
            {startedAt && (
              <span className="text-meta text-ink-3" data-testid="file-reading-elapsed">
                <ElapsedTimer startedAt={startedAt} /> so far
              </span>
            )}
            {/* "Stop waiting" is in the sticky Start bar, beside the button it frees: one button for both readings. */}
          </div>
        )}
        {rules.modelLabel && rules.status !== 'idle' && rules.status !== 'cancelled' && !rules.view?.skipped && (
          <p className="font-mono text-meta text-ink-3">Model: {rules.modelLabel}</p>
        )}
        {stopped && (
          <div className="flex flex-wrap items-center gap-2" data-testid="file-reading-stopped">
            <p className="text-sm text-ink-2">Stopped waiting. The job reads the file&apos;s layout and the document when it starts, which adds time to the job.</p>
            <Button size="sm" variant="outline" onClick={onReadNow}>
              Read now instead
            </Button>
          </div>
        )}

        <AiSummaryBlock aiSummary={aiSummary} onRewriteSummary={onRewriteSummary} />

        <section className="flex flex-col gap-1.5" aria-label="Structure">
          <h3 className="text-xs font-semibold text-ink-2">From the file’s text and structure</h3>
          {overview?.lines && overview.lines.length > 0 ? (
            <OverviewLines lines={overview.lines} />
          ) : overview ? (
            <p dir="auto" className="break-words text-sm text-ink-1">{overview.synopsis}</p>
          ) : (
            <p className="text-sm text-ink-3">No overview available for this document. You can still continue.</p>
          )}
          {overview?.caveat && <Alert severity="warning">{overview.caveat}</Alert>}
        </section>

        {leftOut && leftOut.parts.length > 0 && (
          <section className="flex flex-col gap-1.5 rounded-md border border-hairline bg-canvas p-3" aria-label="Left out" data-testid="file-reading-left-out">
            <h3 className="text-xs font-semibold text-ink-2">Left out: not requirements{pagesPhrase(leftOut.pages)}</h3>
            <ul className="flex flex-wrap gap-1.5">
              {leftOut.parts.map((part, index) => (
                <li key={`${part.text}-${index}`} dir="auto" className="rounded-full border border-hairline-strong bg-surface px-2 py-0.5 font-mono text-meta text-ink-2">
                  {part.text}
                  {part.page ? ` · p${part.page}` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(rules.status === 'ready' || rules.status === 'error') && (
          <section className="flex flex-col gap-1.5" aria-label="How items are built">
            <h3 className="text-xs font-semibold text-ink-2">How items are built</h3>
            <FileRulesCard
              embedded
              status={rules.status}
              view={rules.view}
              error={rules.error}
              modelLabel={rules.modelLabel}
              modelHint={rules.modelHint}
              onRelearn={onRelearn}
              onStopWaiting={onStopWaiting}
              onReadNow={onReadNow}
              onSaveEdit={onSaveEdit}
            />
          </section>
        )}

        {study.status === 'ready' && study.view && (
          <Disclosure title="What the model learned from reading the document">
            <div className="flex flex-col gap-2">
              <p className="text-xs text-ink-3">Later steps use this; it never creates items.</p>
              <StudyFindings study={study.view} />
            </div>
          </Disclosure>
        )}
        {study.status === 'error' && (
          <p className="text-xs text-ink-3">{study.error ?? 'The document could not be read.'} The job can start without it, and will say so in its warnings.</p>
        )}

        {knowledgeBase}
      </div>
    </SectionCard>
  );
}
