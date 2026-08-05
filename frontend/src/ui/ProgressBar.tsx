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
          determinate
            ? { width: `${clamped}%`, transition: 'width 900ms var(--ease-in-out)' }
            : { width: '34%', animation: 'indeterminate-progress 1.5s var(--ease-in-out) infinite' }
        }
      />
    </div>
  );
}
