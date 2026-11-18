import { useEffect, useRef } from 'react';
import { Check, Circle, Minus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Spinner } from '../../ui/Spinner';
import type { StepState } from '../../ui/Stepper';
import type { LifecycleKey } from '../JobLifecycleSteps';

export interface PhaseRailRow {
  key: LifecycleKey;
  label: string;
  state: StepState;
  /** The one line under the label: what a finished phase produced, a counted position, or what a pending phase is for. */
  line: string;
}

// DESIGN.md §11.3.5. A vertical tab list of the run's phases: the checklist of what is done, what is running and what is
// still to come, which is also how you look back at a finished phase or ahead at a pending one.
export function PhaseRail({
  rows,
  selectedKey,
  liveKey,
  onSelect,
  orientation = 'vertical',
}: {
  rows: PhaseRailRow[];
  selectedKey: LifecycleKey;
  liveKey: LifecycleKey;
  onSelect: (key: LifecycleKey) => void;
  // 'vertical' (default): a list beside the view from `lg`. 'horizontal': a strip at every width, for a job whose run is over (§11.3.5).
  orientation?: 'vertical' | 'horizontal';
}): React.ReactElement {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Research #4 (DESIGN.md §8.3): a phase whose state changed after first paint (the run finished it, or it became current) cross-fades
  // its glyph and name in once at --motion-milestone. Read from the states of the previous commit; nothing animates on first paint. The
  // page's one polite status region (LiveStatusRegion) already announces the step change, so this is decoration on top of a fact.
  const previousStates = useRef<Record<string, StepState> | null>(null);
  useEffect(() => {
    previousStates.current = Object.fromEntries(rows.map((row) => [row.key, row.state]));
  });

  function move(fromIndex: number, delta: number): void {
    const next = (fromIndex + delta + rows.length) % rows.length;
    const key = rows[next].key;
    onSelect(key);
    tabRefs.current[key]?.focus();
  }

  return (
    <div role="tablist" aria-orientation={orientation} aria-label="Run phases" // A vertical list from `lg` (running job); below it, and for a finished run, a horizontal strip, so six tall rows do not push the phase view down.
    className={cn('flex flex-row overflow-x-auto rounded-md border border-hairline bg-surface', orientation === 'vertical' && 'lg:flex-col lg:overflow-visible')}>
      {rows.map((row, index) => {
        const selected = row.key === selectedKey;
        const before = previousStates.current?.[row.key];
        const advanced = before !== undefined && before !== row.state && (row.state === 'done' || row.state === 'current');
        return (
          <button
            key={row.key}
            ref={(el) => {
              tabRefs.current[row.key] = el;
            }}
            type="button"
            role="tab"
            id={`phase-tab-${row.key}`}
            aria-selected={selected}
            aria-controls="phase-view"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(row.key)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                event.preventDefault();
                move(index, -1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                move(index, -index);
              } else if (event.key === 'End') {
                event.preventDefault();
                move(index, rows.length - 1 - index);
              }
            }}
            // `.hoverable-row` (§6) paints hover, the selected fill and the hairline between rows.
            className={cn('hoverable-row flex min-w-[7.5rem] flex-none items-start gap-3 px-3.5 py-3 text-left first:border-t-0', orientation === 'vertical' && 'lg:min-w-0')}
          >
            {/* keyed by state, so a change remounts the glyph and name and the one-shot fade plays once */}
            <span
              key={row.state}
              data-phase-advance={advanced ? row.key : undefined}
              className={cn('flex min-w-0 flex-1 items-start gap-3', advanced && 'animate-[fadeIn_var(--motion-milestone)_var(--ease-out)_backwards]')}
            >
            <PhaseGlyph state={row.state} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className={cn('text-sm', selected || row.state === 'current' ? 'font-semibold text-ink-1' : 'text-ink-2')}>{row.label}</span>
                {row.key === liveKey && row.state === 'current' && <span className="text-meta text-live">● Live</span>}
              </span>
              {/* Below lg the strip is compact, but the state line stays in the accessible name. */}
              <span className={cn('text-xs text-ink-3', orientation === 'vertical' ? 'sr-only lg:not-sr-only lg:block' : 'sr-only')}>{row.line}</span>
            </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// A glyph and a word-bearing line carry the state: never colour alone (§13).
function PhaseGlyph({ state }: { state: StepState }): React.ReactElement {
  const cls = 'mt-0.5 h-4 w-4 flex-none';
  if (state === 'done') return <Check className={cn(cls, 'text-ok')} aria-hidden="true" />;
  if (state === 'failed') return <X className={cn(cls, 'text-danger')} aria-hidden="true" />;
  if (state === 'skipped') return <Minus className={cn(cls, 'text-ink-3')} aria-hidden="true" />;
  if (state === 'current') return <Spinner className={cn(cls, 'text-live')} aria-hidden="true" />;
  if (state === 'awaiting') return <Circle className={cn(cls, 'text-accent')} aria-hidden="true" />;
  return <Circle className={cn(cls, 'text-ink-3/50')} aria-hidden="true" />;
}
