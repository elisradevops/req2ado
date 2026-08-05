import { Check, RefreshCw, X } from 'lucide-react';
import { cn } from '../lib/cn';

export type StepState = 'done' | 'current' | 'awaiting' | 'pending' | 'failed' | 'skipped';

// Circle chrome per state (DESIGN.md §7, Navigation category / Stepper node
// row). `current` and `awaiting` share a ring treatment -- the colour alone
// (accent vs hairline-strong) is what makes `awaiting` visually distinct
// from `pending`, fixing the bug where a diff_ready job's Review step
// rendered as a bare number indistinguishable from an upcoming step.
const STATE_CIRCLE_CLASSES: Record<StepState, string> = {
  done: 'border-ok bg-ok text-white',
  current: 'border-accent bg-accent-soft text-accent',
  awaiting: 'border-accent bg-accent-soft text-accent',
  pending: 'border-hairline-strong bg-surface text-ink-3',
  failed: 'border-danger bg-surface text-danger',
  skipped: 'border-hairline-strong bg-surface text-ink-3',
};

const STATE_LABEL_CLASSES: Record<StepState, string> = {
  done: 'text-ink-1',
  current: 'text-ink-1 font-semibold',
  awaiting: 'text-ink-1 font-semibold',
  pending: 'text-ink-3',
  failed: 'text-danger',
  skipped: 'text-ink-3 line-through',
};

// Legacy activeIndex-only path (NewJobWizard's pure-navigation steps, and
// any caller not yet migrated to `states`) -- activeSpinner distinguishes a
// wizard's "just navigation, nothing running" active step (`awaiting`) from
// a live pipeline's "real async work in flight" active step (`current`).
function deriveStates(stepCount: number, activeIndex: number, activeSpinner: boolean): StepState[] {
  return Array.from({ length: stepCount }, (_, index) => {
    if (index < activeIndex) return 'done';
    if (index === activeIndex) return activeSpinner ? 'current' : 'awaiting';
    return 'pending';
  });
}

export function Stepper({
  steps,
  activeIndex,
  activeSpinner = false,
  colors,
  states,
}: {
  steps: string[];
  // Superseded by `states` (DESIGN.md Track B, phase B3) but kept as the
  // path NewJobWizard and any other unmigrated caller still uses.
  activeIndex?: number;
  activeSpinner?: boolean;
  // One hex/CSS-color-value per step, applied to that step's own done/current
  // fill (never signal-yellow -- reserved strictly for "this needs your
  // decision", see DESIGN.md §15.7). Only meaningful alongside the legacy
  // activeIndex path -- a caller passing `states` directly has no per-step
  // color override today.
  colors?: string[];
  // Full per-step state vector -- the one lifecycle stepper (B3) always
  // passes this, since a single "active index" can't express completed
  // history, a frozen-at-failure state, or a skipped step all at once.
  states?: StepState[];
}): React.ReactElement {
  const resolvedStates = states ?? deriveStates(steps.length, activeIndex ?? 0, activeSpinner);

  return (
    <ol className="flex items-stretch">
      {steps.map((step, index) => {
        const state = resolvedStates[index];
        const color = colors?.[index];
        const isColorOverride = Boolean(color) && (state === 'done' || state === 'current' || state === 'awaiting');
        // Both halves of the segment between step i and i+1 key off the
        // SAME underlying step (i)'s done-ness, so the line never changes
        // colour partway across -- see this step's right segment and the
        // next step's left segment, which intentionally compute the same
        // boolean from each side.
        const leftSegmentDone = index > 0 && resolvedStates[index - 1] === 'done';
        const rightSegmentDone = state === 'done';

        return (
          <li key={step} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <div className="flex w-full items-center">
              <span
                className={cn('h-px flex-1 transition-colors duration-slow', index === 0 ? 'bg-transparent' : leftSegmentDone ? 'bg-ok' : 'bg-hairline-strong')}
              />
              <span
                data-state={state}
                style={isColorOverride ? { backgroundColor: color, borderColor: color } : undefined}
                className={cn(
                  'relative grid h-7 w-7 flex-none place-items-center rounded-full border-2 text-xs font-semibold transition-colors duration-fast ease-out',
                  !isColorOverride && STATE_CIRCLE_CLASSES[state],
                  isColorOverride && 'text-white',
                  state === 'current' && 'animate-[pulse-ring_var(--duration-ambient)_var(--ease-in-out)_infinite]',
                )}
              >
                {state === 'done' && <Check className="h-3.5 w-3.5" />}
                {state === 'current' && <RefreshCw className="h-3.5 w-3.5" style={{ animation: 'spin 0.7s linear infinite' }} />}
                {state === 'failed' && <X className="h-3.5 w-3.5" />}
                {(state === 'awaiting' || state === 'pending' || state === 'skipped') && index + 1}
              </span>
              <span
                className={cn(
                  'h-px flex-1 transition-colors duration-slow',
                  index === steps.length - 1 ? 'bg-transparent' : rightSegmentDone ? 'bg-ok' : 'bg-hairline-strong',
                )}
              />
            </div>
            <span className={cn('whitespace-nowrap text-meta font-medium', STATE_LABEL_CLASSES[state])}>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
