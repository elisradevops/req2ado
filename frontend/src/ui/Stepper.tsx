import { Check } from 'lucide-react';
import { cn } from '../lib/cn';
import { Spinner } from './Spinner';

export function Stepper({
  steps,
  activeIndex,
  activeSpinner = false,
  colors,
}: {
  steps: string[];
  activeIndex: number;
  // A wizard's "active" step is just navigation state (nothing running) --
  // a live pipeline's "active" step has real async work in flight, so it
  // gets a spinner instead of its number, matching the "(V) done -- (C)
  // current+spinner -- (F) upcoming" connected-node stepper the prototype
  // and this app's mockup both use for that case.
  activeSpinner?: boolean;
  // One hex/CSS-color-value per step, applied to that step's own done/active
  // fill (never signal-yellow -- reserved strictly for "this needs your
  // decision", see index.css's own token comment). Optional: a wizard's
  // pure-navigation steps (NewJobWizard) stay uniform navy, unaffected --
  // only a live pipeline with genuinely distinct phases needs per-step
  // color, matching the "give each phase its own identity" ask directly.
  colors?: string[];
}): React.ReactElement {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((step, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        const color = colors?.[index];
        return (
          <li key={step} className="flex shrink-0 items-center gap-2">
            <span
              data-state={done ? 'done' : active ? 'active' : 'pending'}
              style={color && (done || active) ? { backgroundColor: color, borderColor: color } : undefined}
              className={cn(
                'grid h-6 w-6 flex-none place-items-center rounded-full border text-xs font-semibold transition-transform duration-150',
                !color && done && 'border-navy-600 bg-navy-600 text-white',
                color && (done || active) && 'text-white',
                // Navy, not signal-yellow -- signal is reserved strictly for
                // "this needs your decision" (the Confirm gate, see
                // index.css's own token comment); a step indicator isn't a
                // decision surface. The scale pop mirrors the prototype's
                // own active-step treatment.
                !color && active && 'border-navy-600 bg-navy-600 text-white',
                active && 'scale-[1.09]',
                !done && !active && 'border-hairline-strong bg-surface text-ink-3',
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : active && activeSpinner ? <Spinner className="h-3.5 w-3.5 text-white" /> : index + 1}
            </span>
            <span className={cn('whitespace-nowrap text-xs font-medium', active ? 'text-ink-1' : 'text-ink-3')}>
              {step}
            </span>
            {index < steps.length - 1 && (
              <span
                className={cn('mx-1 h-px w-8 transition-colors duration-200', !done && 'bg-hairline-strong')}
                style={done ? { backgroundColor: colors?.[index] ?? 'var(--color-ok)' } : undefined}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
