import { cn } from '../lib/cn';

// Exported so ModeBadge.tsx (the persistent chip shown in job list/detail
// headers, after creation) can reuse the exact same description as this
// picker (shown once, only at job creation) -- previously the mode was only
// ever explained the FIRST time, never again once a job existed.
export const MODE_COPY = {
  baseline: {
    title: 'BASELINE',
    description: 'Deterministic, verbatim extraction. No LLM. Fast.',
    estimate: '≈ 3–5 min · no model cost',
  },
  survey: {
    title: 'SURVEY',
    description: 'LLM-driven distillation into formal "shall" requirements. 15-40+ min on real documents.',
    estimate: '≈ 15–40 min · uses your model quota',
  },
} as const;

export function ModeCards({
  value,
  onChange,
}: {
  value: 'baseline' | 'survey';
  onChange: (mode: 'baseline' | 'survey') => void;
}): React.ReactElement {
  return (
    // Stacked (not side-by-side) -- matches the prototype's `.modes` grid
    // (single column, no grid-template-columns) rather than the previous
    // flex-row layout. Reads better at the narrower width this now sits in
    // once the wizard's step 2 uses a real two-column split.
    <div className="flex flex-col gap-2.5" role="radiogroup" aria-label="Analysis mode">
      {(Object.keys(MODE_COPY) as Array<'baseline' | 'survey'>).map((mode) => {
        const selected = value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(mode)}
            className={cn(
              // DESIGN.md §7 Surface category, Selected row: border-accent
              // bg-accent-soft shadow-raised + a 3px accent left rail.
              'relative flex flex-col gap-1.5 rounded-md border bg-surface px-3.5 py-3 text-left transition-colors duration-instant ease-out',
              selected ? 'border-accent bg-accent-soft shadow-raised' : 'border-hairline-strong hover:border-accent-soft-border',
            )}
          >
            {selected && <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-md bg-accent" />}
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'grid h-3.5 w-3.5 flex-none place-items-center rounded-full border',
                  selected ? 'border-accent' : 'border-hairline-strong',
                )}
              >
                {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </span>
              <span className="text-sm font-bold">{MODE_COPY[mode].title}</span>
            </div>
            <span className="text-xs text-ink-3">{MODE_COPY[mode].description}</span>
            <span className="font-mono text-meta text-ink-3">{MODE_COPY[mode].estimate}</span>
          </button>
        );
      })}
    </div>
  );
}
