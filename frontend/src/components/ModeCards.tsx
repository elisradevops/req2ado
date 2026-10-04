import { Cpu } from 'lucide-react';
import { cn } from '../lib/cn';
import { LABEL_MICRO } from '../utils/labelMicro';
import { formatEtaRange } from '../utils/eta';
import { Select } from '../ui/Select';
import type { EtaEstimate } from '../api/jobs';

// Exported so ModeBadge.tsx (the persistent chip shown in job list/detail
// headers, after creation) can reuse the exact same description as this
// picker (shown once, only at job creation) -- previously the mode was only
// ever explained the FIRST time, never again once a job existed.
//
// `estimate` (a hardcoded, roughly-quarter-hour-to-two-thirds-hour range
// string) is DELETED, along with the trailing time clause in survey's
// description -- both were static copy that never routed through eta.ts's
// formula and, worse, both still carried the removed upper-cap value in
// prose even after the real formula was fixed (DESIGN.md §11.2.3.e's
// hardcoded-time-string table -- and see tokens.test.ts's ratchet pattern
// added in the same change, which is why this comment avoids spelling the
// old range out digit-dash-digit). The real range now comes from the
// server (EtaService, via props below) -- this object keeps only what's
// genuinely static: what each mode IS, and whether it costs model quota.
//
// `sample` is a fixed, illustrative example of what each mode actually
// writes to Azure DevOps -- NOT derived from the uploaded document (no real
// per-document sample exists before a run actually happens). Matches the
// agreed mockup's own "What lands in Azure DevOps" preview: the two modes
// differ in SHAPE (verbatim clause vs. a distilled, scored, titled item),
// and that shape difference is what a description sentence can't show as
// fast as a real-looking example can.
export const MODE_COPY = {
  baseline: {
    title: 'BASELINE',
    description: 'Deterministic, verbatim extraction. No LLM. Fast.',
    costNote: 'no model cost',
    sample: {
      kind: 'verbatim' as const,
      text: '3.2.1 The receiver shall tune across 2–18 GHz in 1 MHz steps with a settling time not exceeding 50 µs.',
    },
  },
  survey: {
    title: 'SURVEY',
    description: 'LLM-driven distillation into formal "shall" requirements.',
    costNote: 'uses your model quota',
    sample: {
      kind: 'structured' as const,
      title: 'Receiver tuning range and step size',
      body: 'The receiver shall tune across the 2–18 GHz band in 1 MHz steps, settling within 50 µs of a commanded change.',
      provenance: 'quality 82 · well-formed · from §3.2.1',
    },
  },
} as const;

function EstimateLine({ estimate }: { estimate: EtaEstimate | undefined }): React.ReactElement {
  if (!estimate) {
    // '--' placeholder (not a blank/0) while the estimate hasn't resolved
    // yet -- same "never silently fall through to 0" convention StatTile
    // already uses for preview counts.
    return <span className="font-mono text-meta text-ink-3">--</span>;
  }
  const { lower, upper } = formatEtaRange(estimate.lowerMinutes, estimate.upperMinutes);
  // DESIGN.md §12: "an estimate is a range with 'typically', never a
  // false-precision point value" -- except when lower===upper (BASELINE's
  // flat, non-probabilistic 1 minute has no range to project), where the
  // "typically" framing would falsely imply uncertainty that isn't there.
  return <span className="font-mono text-meta text-ink-3">{lower === upper ? lower : `${lower} – ${upper}, typically`}</span>;
}

function SamplePreview({ sample }: { sample: (typeof MODE_COPY)['baseline' | 'survey']['sample'] }): React.ReactElement {
  return (
    <span className="block overflow-hidden rounded-sm border border-hairline bg-surface-alt">
      <span className={cn('block px-2.5 pt-2 pb-1', LABEL_MICRO)}>
        What lands in Azure DevOps
      </span>
      <span className="block px-2.5 pt-0.5 pb-2.5">
        {sample.kind === 'verbatim' ? (
          <span className="block font-mono text-meta leading-snug text-ink-2">{sample.text}</span>
        ) : (
          <>
            <span className="block text-xs font-semibold text-ink-1">{sample.title}</span>
            <span className="mt-0.5 block text-meta leading-snug text-ink-2">{sample.body}</span>
            <span className="mt-1 block font-mono text-micro text-ink-3">{sample.provenance}</span>
          </>
        )}
      </span>
    </span>
  );
}

export function ModeCards({
  value,
  onChange,
  baselineEstimate,
  surveyEstimate,
  model,
  onModelChange,
  availableModels,
  modelsLoading,
  modelsError,
}: {
  value: 'baseline' | 'survey';
  onChange: (mode: 'baseline' | 'survey') => void;
  // Server-computed (DESIGN.md §11.2.3.d) -- undefined while in flight or
  // before the first preview/estimate call resolves. Both modes' estimates
  // are shown side by side (the whole point of the card layout is
  // comparing them), so both are threaded in rather than just the
  // currently-selected mode's.
  baselineEstimate?: EtaEstimate;
  surveyEstimate?: EtaEstimate;
  // DESIGN.md §11.2 -- the model picker lives INSIDE the SURVEY card now
  // (was a separate, always-nearly-empty "Options" card below this one --
  // its only content, ever, was this same picker for survey mode; BASELINE
  // never runs an LLM at all, so the card was either this one control or
  // nothing). Undefined/omitted on a caller that doesn't need it (none
  // today, but keeps this component usable standalone).
  model?: string;
  onModelChange?: (model: string) => void;
  availableModels?: string[];
  modelsLoading?: boolean;
  modelsError?: boolean;
}): React.ReactElement {
  return (
    // Stacked (not side-by-side) -- matches the prototype's `.modes` grid
    // (single column, no grid-template-columns) rather than the previous
    // flex-row layout. Reads better at the narrower width this now sits in
    // once the wizard's step 2 uses a real two-column split.
    <div className="flex flex-col gap-2.5" role="radiogroup" aria-label="Analysis mode">
      {(Object.keys(MODE_COPY) as Array<'baseline' | 'survey'>).map((mode) => {
        const selected = value === mode;
        const estimate = mode === 'baseline' ? baselineEstimate : surveyEstimate;
        return (
          // A plain div, not a <button> -- the SURVEY card needs to nest a
          // real interactive <Select> (Radix renders its own trigger
          // <button>), and a <button> inside a <button> is invalid HTML
          // (confirmed real bug when this exact pattern was first tried on
          // QualityGauge's CategoryRow/InfoTip nesting, earlier in this
          // session). tabIndex/onKeyDown restore the same keyboard
          // activation a native button would give for free, matching this
          // codebase's own div-role-button convention (FileDropzone.tsx).
          <div
            key={mode}
            role="radio"
            tabIndex={0}
            aria-checked={selected}
            onClick={() => onChange(mode)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onChange(mode);
              }
            }}
            className={cn(
              // DESIGN.md §7 Surface category, Selected row: border-accent
              // bg-accent-soft shadow-raised + a 3px accent left rail.
              // `.liftable` (§6) supplies the shared hover lift/shadow every
              // other Surface-category element already uses -- the
              // accent-soft border tint on hover stays its own utility
              // since `.liftable` only owns elevation, not border color.
              'liftable relative flex cursor-pointer flex-col gap-2 rounded-md border bg-surface px-3.5 py-3 text-left transition-colors duration-instant ease-out',
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
            <SamplePreview sample={MODE_COPY[mode].sample} />
            <span className="flex items-center gap-1.5">
              <EstimateLine estimate={estimate} />
              <span className="text-meta text-ink-3">· {MODE_COPY[mode].costNote}</span>
            </span>
            {mode === 'survey' && onModelChange && (
              // Both stopPropagation calls are load-bearing, not just the
              // click one -- this control lives inside the card's own
              // onClick/onKeyDown (select-this-mode) surface, and Radix's
              // real SelectTrigger only ever calls preventDefault() on
              // Enter/Space/arrow keys, never stopPropagation() (confirmed
              // against @radix-ui/react-select's own source) -- preventDefault
              // does not stop a React synthetic event from continuing to
              // bubble. Without the onKeyDown guard here too, pressing
              // Enter/Space to open the dropdown bubbles straight up to the
              // ancestor role="radio" div's own onKeyDown and silently
              // switches the selected mode -- a real state change, not a
              // harmless stray call like the click case.
              <span
                className="flex flex-wrap items-center gap-1.5 border-t border-hairline pt-2"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <span className="flex flex-none items-center gap-1 text-xs font-medium text-ink-2">
                  <Cpu className="h-3.5 w-3.5 flex-none text-ink-3" />
                  Model
                </span>
                <Select value={model ?? ''} onChange={(event) => onModelChange(event.target.value)} aria-label="LLM Model" loading={modelsLoading}>
                  <option value="">Default</option>
                  {(availableModels ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
                {modelsError && (
                  <span className="basis-full text-micro text-danger">Couldn't load models — Default will be used.</span>
                )}
                <span className="basis-full text-micro text-ink-3">
                  Fetched live from the backend. Feeds the estimate below — leave it on Default and the estimate falls back to a
                  neutral 1.0×, because the frontend cannot know which model the orchestrator resolves to.
                </span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
