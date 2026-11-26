import { Cpu } from 'lucide-react';
import { cn } from '../lib/cn';
import { LABEL_MICRO } from '../utils/labelMicro';
import { formatEtaRange } from '../utils/eta';
import { Select } from '../ui/Select';
import { describeModelFacts } from '../utils/modelFacts';
import type { EtaEstimate, ModelDetail } from '../api/jobs';

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
// `sample` is a generic example of the SHAPE each mode writes to Azure DevOps
// (verbatim clause vs. a titled, rewritten item), in placeholders only: a
// realistic clause, section number, unit or score would be read as real
// output (DESIGN.md §11.2.5).
// The two modes as the owner named them (2026-11-25): both read the file with AI; With AI review also scores, writes acceptance criteria and
// suggests wording, which the reviewer accepts or not.
export const MODE_COPY = {
  baseline: {
    title: 'Standard',
    description: "The file's own structure and text, with clean titles.",
  },
  survey: {
    title: 'With AI review',
    description: 'The same items, plus scoring, acceptance criteria and wording suggestions.',
  },
} as const;

function EstimateLine({ estimate, cached }: { estimate: EtaEstimate | undefined; cached?: boolean }): React.ReactElement {
  // A file the result cache already holds is served in seconds, whatever the measured range says; the side panel says the same.
  if (cached) {
    return (
      <>
        <span className="font-mono text-meta text-ink-3">A few seconds</span>
        <span className="basis-full text-meta text-ink-3">this file was already processed</span>
      </>
    );
  }
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
  return (
    <>
      <span className="font-mono text-meta text-ink-3">{lower === upper ? lower : `${lower} – ${upper}, typically`}</span>
    </>
  );
}

export function ModeCards({
  value,
  onChange,
  baselineEstimate,
  surveyEstimate,
  surveyCached,
  model,
  onModelChange,
  availableModels,
  modelDetails,
  recommendedModel,
  modelsLoading,
  modelsError,
  lastUsed,
}: {
  value: 'baseline' | 'survey';
  onChange: (mode: 'baseline' | 'survey') => void;
  // The mode of the person's last job: a "Last used" label on that card only. It never selects it (BASELINE stays the default, D1).
  lastUsed?: 'baseline' | 'survey';
  // Server-computed (DESIGN.md §11.2.3.d) -- undefined while in flight or
  // before the first preview/estimate call resolves. Both modes' estimates
  // are shown side by side (the whole point of the card layout is
  // comparing them), so both are threaded in rather than just the
  // currently-selected mode's.
  baselineEstimate?: EtaEstimate;
  surveyEstimate?: EtaEstimate;
  // A SURVEY job of this very file would come from the result cache: the SURVEY card says so instead of quoting the measured range.
  surveyCached?: boolean;
  // DESIGN.md §11.2 -- the model picker lives INSIDE the SURVEY card now
  // (was a separate, always-nearly-empty "Options" card below this one --
  // its only content, ever, was this same picker for survey mode; BASELINE
  // never runs an LLM at all, so the card was either this one control or
  // nothing). Undefined/omitted on a caller that doesn't need it (none
  // today, but keeps this component usable standalone).
  model?: string;
  onModelChange?: (model: string) => void;
  availableModels?: string[];
  /** What the server can state per model; absent from an older orchestrator, and the list then stays plain. */
  modelDetails?: ModelDetail[];
  /** The model the admin configured as the default, when this user is offered it. */
  recommendedModel?: string | null;
  modelsLoading?: boolean;
  modelsError?: boolean;
}): React.ReactElement {
  // "Default" means the recommended model (the one the orchestrator resolves it to), so its facts are the ones to show.
  const shownModelId = model || recommendedModel || '';
  const shownDetail = shownModelId ? modelDetails?.find((d) => d.id === shownModelId) : undefined;
  return (
    // Side by side and compact (the approved mockup): the name, the time, one line. The model the AI review uses sits in the row under them,
    // beside the line both modes share, so the Standard card is never a tall empty box.
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2" role="radiogroup" aria-label="Analysis mode">
        {(Object.keys(MODE_COPY) as Array<'baseline' | 'survey'>).map((mode) => {
          const selected = value === mode;
          const estimate = mode === 'baseline' ? baselineEstimate : surveyEstimate;
          return (
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
                // DESIGN.md §7 Surface category, Selected row; `.liftable` (§6) supplies the shared hover lift.
                'liftable relative flex cursor-pointer flex-col gap-1.5 rounded-md border bg-surface px-3.5 py-3 text-left transition-colors duration-instant ease-out',
                selected ? 'border-accent bg-accent-soft shadow-raised' : 'border-hairline-strong hover:border-accent-soft-border',
              )}
            >
              {selected && <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-md bg-accent" />}
              <div className="flex items-center gap-2">
                <span className={cn('grid h-3.5 w-3.5 flex-none place-items-center rounded-full border', selected ? 'border-accent' : 'border-hairline-strong')}>
                  {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                </span>
                <span className="text-sm font-bold">{MODE_COPY[mode].title}</span>
                {lastUsed === mode && <span className={cn('ml-2', LABEL_MICRO)}>Last used</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  <EstimateLine estimate={estimate} cached={mode === 'survey' && surveyCached} />
                </span>
              </div>
              <span className="pl-6 text-xs text-ink-3">{MODE_COPY[mode].description}</span>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-1 items-center gap-2 md:grid-cols-2 md:gap-3">
        <p className="text-xs text-ink-3">Both modes use AI to read the file.</p>
        {value === 'survey' && onModelChange && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="flex flex-none items-center gap-1 text-xs font-medium text-ink-2">
              <Cpu className="h-3.5 w-3.5 flex-none text-ink-3" />
              Model
            </span>
            <Select value={model ?? ''} onChange={(event) => onModelChange(event.target.value)} aria-label="AI model" loading={modelsLoading}>
              <option value="">{recommendedModel ? `Default (${recommendedModel})` : 'Default'}</option>
              {(availableModels ?? []).map((m) => (
                <option key={m} value={m}>
                  {m === recommendedModel ? `${m} · Recommended` : m}
                </option>
              ))}
            </Select>
            {modelsError && <span className="basis-full text-micro text-danger">Couldn't load models — Default will be used.</span>}
            {shownDetail && <span className="basis-full text-meta text-ink-3">{describeModelFacts(shownDetail).join(' · ')}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
