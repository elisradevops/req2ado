import { cn } from '../lib/cn';

const MODE_COPY = {
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
              'flex flex-col gap-1.5 rounded-md border bg-surface px-3.5 py-3 text-left transition-colors',
              selected ? 'border-navy-600 shadow-[inset_0_0_0_1px_var(--color-navy-600)]' : 'border-hairline-strong hover:border-navy-300',
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'grid h-3.5 w-3.5 flex-none place-items-center rounded-full border',
                  selected ? 'border-navy-600' : 'border-hairline-strong',
                )}
              >
                {selected && <span className="h-1.5 w-1.5 rounded-full bg-navy-600" />}
              </span>
              <span className="text-sm font-bold">{MODE_COPY[mode].title}</span>
            </div>
            <span className="text-xs text-ink-3">{MODE_COPY[mode].description}</span>
            <span className="font-mono text-[11px] text-ink-3">{MODE_COPY[mode].estimate}</span>
          </button>
        );
      })}
    </div>
  );
}
