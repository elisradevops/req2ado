import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn';

export function ProgressBar({
  value,
  label,
  valueText,
}: {
  value?: number;
  // Accessible name (required: a progressbar with no name fails axe) and the
  // optional honest reading of the value ("38 percent of the run, estimated"
  // or "No progress estimate for this step").
  label: string;
  valueText?: string;
}): React.ReactElement {
  const determinate = value !== undefined;
  const clamped = determinate ? Math.min(Math.max(value, 0), 100) : undefined;
  // A forward jump of a percent or more eases in; a smaller change, or any move backwards, snaps (DESIGN.md section 8.3).
  const previous = useRef(clamped);
  const snap = clamped !== undefined && previous.current !== undefined && (clamped < previous.current || clamped - previous.current < 1);
  useEffect(() => {
    previous.current = clamped;
  }, [clamped]);
  // The fill is full width, scaled from the reading edge, so a tick is a compositor transform and never a layout.
  const fillStyle = { transform: `scaleX(${(clamped ?? 0) / 100})`, transition: snap ? 'none' : 'transform var(--duration-progress) var(--ease-out)' };
  return (
    <div
      role="progressbar"
      aria-valuenow={determinate ? Math.round(clamped!) : undefined}
      aria-label={label}
      aria-valuetext={valueText}
      aria-valuemin={0}
      aria-valuemax={100}
      className="relative h-1.5 overflow-hidden rounded-full bg-canvas"
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent-active to-accent',
          determinate && 'w-full origin-left rtl:origin-right',
        )}
        style={
          // DESIGN.md §8: the duration here is exactly --duration-progress, and --duration-ambient is the indeterminate
          // segment's own value -- reference the tokens, not the bare numbers, so a future token change doesn't drift.
          determinate ? fillStyle : { width: '34%', animation: 'indeterminate-progress var(--duration-ambient) var(--ease-in-out) infinite' }
        }
      />
    </div>
  );
}
