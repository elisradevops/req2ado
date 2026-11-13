import type { StepState } from '../../ui/Stepper';
import { Button } from '../../ui/Button';

const STATE_WORDS: Record<StepState, string> = {
  done: 'Finished',
  current: 'In progress',
  awaiting: 'Waiting for you',
  pending: 'Not started yet',
  failed: 'Failed here',
  skipped: 'Skipped',
};

// DESIGN.md §11.3.5. The view of a phase the run is NOT currently in: a finished phase is a read-only record of what it
// produced, a pending phase says what it is for. Neither shows an ETA (§16.21), and neither ever moves by itself.
export function PhaseSummary({
  label,
  state,
  purpose,
  produced,
  onBackToLive,
  backLabel = 'Back to live',
  children,
}: {
  label: string;
  state: StepState;
  purpose: string;
  /** What the phase produced, in counted words, when that is known. */
  produced: string | null;
  onBackToLive: () => void;
  /** The way back is to the live phase while running, and to the phase the job rests on afterwards. */
  backLabel?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-hairline bg-surface p-4" data-testid="phase-summary">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-title">
            {label}
          </h2>
          <p className="text-xs text-ink-3">{STATE_WORDS[state]}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBackToLive}>
          {backLabel}
        </Button>
      </div>
      <p className="text-sm text-ink-2">{purpose}</p>
      {produced && <p className="font-mono text-meta text-ink-2">{produced}</p>}
      {children}
    </div>
  );
}
