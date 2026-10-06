export function ProgressBar({
  value,
  // A model call is in flight: overlays a slow sheen on the filled part so a
  // determinate bar that is legitimately not moving for minutes still reads
  // as alive. Never changes the width -- the number stays honest.
  active,
  label,
  valueText,
}: {
  value?: number;
  active?: boolean;
  // Accessible name and the honest reading of the value ("38 percent of the
  // run, estimated" or "No progress estimate for this step"). Optional, so
  // every existing bar is unchanged.
  label?: string;
  valueText?: string;
}): React.ReactElement {
  const determinate = value !== undefined;
  const clamped = determinate ? Math.min(Math.max(value, 0), 100) : undefined;
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
        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent-active to-accent"
        style={
          // DESIGN.md §8: 900ms/1.5s here are exactly --duration-progress and
          // --duration-ambient's own values -- reference the tokens, not the
          // bare numbers, so a future token change doesn't drift.
          determinate
            ? { width: `${clamped}%`, transition: 'width var(--duration-progress) var(--ease-in-out)' }
            : { width: '34%', animation: 'indeterminate-progress var(--duration-ambient) var(--ease-in-out) infinite' }
        }
      />
      {active && determinate && (
        <span
          data-testid="progress-active"
          className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,transparent_25%,var(--color-shimmer-highlight)_37%,transparent_63%)] bg-[length:400%_100%] opacity-60"
          style={{ width: `${clamped}%`, animation: 'shimmer var(--duration-ambient) var(--ease-linear) infinite' }}
        />
      )}
    </div>
  );
}
