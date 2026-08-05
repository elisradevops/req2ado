import { InfoTip } from '../ui/Tooltip';
import { cn } from '../lib/cn';

// These three bands are req2ado's own display thresholds over the overall
// quality_score, not an ADO- or LLM-defined scale, so they're labeled as our
// judgment call, not a fact about the requirement.
const BANDS = [
  { min: 0, max: 49, label: 'Needs rework', color: 'var(--color-danger)' },
  { min: 50, max: 74, label: 'Needs review', color: 'var(--color-warning)' },
  { min: 75, max: 100, label: 'Solid', color: 'var(--color-ok)' },
] as const;

function bandFor(score: number): (typeof BANDS)[number] {
  return BANDS.find((band) => score <= band.max) ?? BANDS[BANDS.length - 1];
}

// A dynamic key->0-100-score map, NOT a fixed 5-field shape -- see
// ingestion's quality_category_scores docstring (app.workitem.model). When
// an org has ingested its own quality-checklist standard into the
// Knowledge Base, the model derives category names FROM that document's
// own checklist (e.g. "Necessary"/"Unambiguous"/"Verifiable"/etc.) instead
// of the generic 5-dimension fallback used when no KB standard exists.
export type QualityCategoryScores = Record<string, number>;

// Real descriptions only exist for the 5 generic fallback dimensions (the
// scoring prompt's own fixed wording) -- a KB-derived category (e.g.
// "Verifiable") has no equivalent hardcoded copy here, since its real
// definition lives in the org's own ingested document, not this codebase.
// Matched case-insensitively since the model may vary capitalization.
const KNOWN_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  clarity: 'Is the wording unambiguous and free of vague terms (e.g. "user-friendly", "fast")?',
  testability: 'Can this be objectively verified, with clear acceptance criteria?',
  atomicity: 'Is this ONE single requirement, not several bundled together?',
  style: 'Active voice, EARS-style phrasing (names who/what performs the action)?',
  rationale: 'Does it state WHY when the reason isn’t self-evident?',
};

function categoryDescription(key: string): string {
  return (
    KNOWN_CATEGORY_DESCRIPTIONS[key.toLowerCase()] ??
    "From your organization's own ingested quality-checklist standard."
  );
}

// A KB-derived category key can be snake_case verbatim from the org's own
// ingested checklist document (e.g. "completeness_as_requirement") --
// capitalizing only the first character left the rest as a literal,
// underscore-joined string ("Completeness_as_requirement"). Splits on
// '_'/'-' and capitalizes every word instead.
function categoryLabel(key: string): string {
  return key
    .split(/[_-]/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function categoryColor(value: number): string {
  return bandFor(value).color;
}

// Reused by both the overall gauge's pointer/bar and each category row's
// mini-bar -- a single clamp+color helper keeps the two visually consistent
// (same band thresholds, same colors) even though the category rows render
// as slimmer single-color bars rather than the full three-segment scale.
function CategoryRow({ label, description, value }: { label: string; description: string; value: number }): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, value));
  const color = categoryColor(clamped);
  return (
    <div className="flex items-center gap-2">
      {/* min-w (not a fixed w-20) -- KB-derived category names (e.g.
          "Correct level", "Missing acceptance criteria") can run longer
          than the 5 generic fallback dimension names this width was
          originally sized for. */}
      <span className="flex w-20 min-w-fit flex-none items-center gap-1 text-xs whitespace-nowrap text-ink-2">
        {label}
        <InfoTip content={description} />
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-alt">
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${clamped}%`, backgroundColor: color }} />
      </div>
      <span className="w-7 flex-none text-right font-mono text-xs font-semibold tabular-nums" style={{ color }}>
        {clamped}
      </span>
    </div>
  );
}

export function QualityGauge({
  score,
  categoryScores,
}: {
  score: number;
  categoryScores?: QualityCategoryScores | null;
}): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, score));
  const band = bandFor(clamped);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-ink-2">Quality</span>
        <InfoTip content="req2ado's own read on this requirement's wording, from a single LLM judgment (0-100). Not an ADO field and not part of the work item." />
        <span className="ml-auto font-mono text-sm font-semibold tabular-nums" style={{ color: band.color }}>
          {clamped}
        </span>
        <span className="text-xs font-medium" style={{ color: band.color }}>
          {band.label}
        </span>
      </div>

      {/* The bar's own three segments ARE the bands, laid out at their real
          proportional width (49/25/26) -- a reviewer sees not just "this is
          green" but exactly how far into "Solid" territory 90 sits, and how
          close a 72 is to crossing into it. A pointer marks the exact score
          on top of that scale, rather than only filling a plain progress
          bar to `score`%. */}
      <div className="relative pt-2">
        <div
          className="absolute top-0 -translate-x-1/2 transition-[left] duration-300"
          style={{ left: `${clamped}%` }}
        >
          <div className="h-0 w-0 border-x-[4px] border-t-[5px] border-x-transparent" style={{ borderTopColor: band.color }} />
        </div>
        <div className="flex h-1.5 w-full overflow-hidden rounded-full">
          {BANDS.map((b) => (
            <div
              key={b.label}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{
                width: `${b.max - b.min + 1}%`,
                backgroundColor: b.color,
                opacity: b.label === band.label ? 1 : 0.22,
              }}
            />
          ))}
        </div>
      </div>

      {/* Band legend -- explains WHY this score got this label by showing
          the actual thresholds, with the score's own band bolded. Without
          this, "90 · Solid" reads as a bare assertion; with it, a reviewer
          can see 90 sits well inside the 75-100 Solid range and judge for
          themselves how close a borderline score is to the next band. */}
      <div className="flex justify-between text-micro">
        {BANDS.map((b) => (
          <span
            key={b.label}
            className={cn('flex flex-col', b.label === band.label ? 'font-semibold text-ink-1' : 'text-ink-3')}
          >
            <span className="font-mono tabular-nums">
              {b.min}–{b.max}
            </span>
            <span>{b.label}</span>
          </span>
        ))}
      </div>

      {/* Per-dimension breakdown -- answers "why is this 40" with real
          numbers instead of leaving a reviewer to infer it from the overall
          score plus a handful of boolean issue tags. Absent (not zeroed)
          when the model's scoring entry omitted or malformed this field --
          same all-or-nothing tolerance as the overall score itself, so a
          missing breakdown reads as "not available" rather than "all
          categories failed". */}
      {categoryScores && Object.keys(categoryScores).length > 0 && (
        <div className="mt-1 flex flex-col gap-1 border-t border-hairline pt-2">
          {Object.entries(categoryScores).map(([key, value]) => (
            <CategoryRow key={key} label={categoryLabel(key)} description={categoryDescription(key)} value={value} />
          ))}
        </div>
      )}
    </div>
  );
}
