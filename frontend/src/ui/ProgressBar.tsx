export function ProgressBar({ value }: { value?: number }): React.ReactElement {
  const determinate = value !== undefined;
  const clamped = determinate ? Math.min(Math.max(value, 0), 100) : undefined;
  return (
    <div
      role="progressbar"
      aria-valuenow={determinate ? Math.round(clamped!) : undefined}
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
    </div>
  );
}
