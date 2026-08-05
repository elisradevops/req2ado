import { ElapsedTimer } from './ElapsedTimer';

// Sits flush under JobLifecycleSteps, dark so it reads as "live status",
// not another card -- the fix for "2+ minutes and I have no idea what's
// going on": `sentence` is guaranteed non-empty by narrationTicker.ts's own
// contract, so this bar never renders a bare spinner with no text.
export function NarrationTicker({
  sentence,
  // Only pending/running/writing have a meaningful ticking elapsed time --
  // a completed job's "time since it started" would just grow forever,
  // which is not the same thing as "how long the run took" (that needs a
  // completedAt timestamp the backend doesn't expose to the frontend yet).
  // Honest omission beats a misleading number.
  isLive,
  startedAt,
}: {
  sentence: string;
  isLive: boolean;
  startedAt: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-b-md bg-ink-1 px-3.5 py-2 text-white">
      {/* key={sentence} remounts the span on every sentence change, so the
          fadeIn is a real "something changed" signal, not decoration. */}
      <span key={sentence} className="min-w-0 flex-1 truncate text-sm animate-[fadeIn_var(--duration-base)_var(--ease-out)]">
        {sentence}
      </span>
      {isLive && (
        <span className="flex-none font-mono text-xs tabular-nums text-ink-on-dark-dim">
          Elapsed: <ElapsedTimer startedAt={startedAt} />
        </span>
      )}
    </div>
  );
}
