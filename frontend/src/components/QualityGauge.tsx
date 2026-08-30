import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { InfoTip } from '../ui/Tooltip';
import { cn } from '../lib/cn';
import { qualityIssueLabel } from '../utils/labels';
import { categoryForIssueCode } from '../utils/qualityCategories';

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

// A NaN/Infinity score (a malformed API response) previously passed
// through Math.max(0, Math.min(100, value)) unchanged -- Math.min/max
// with a NaN operand always returns NaN, rendering a literal "NaN" in the
// UI and an invalid `width: NaN%` inline style. Falls back to 0 (the
// bottom of the scale) rather than guessing a more "average" default.
function clampScore(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

// An issue code maps to at most one category (categoryForIssueCode), so a
// single pass fully partitions a code list. Codes with no category match
// (either genuinely unmapped, or there's no categoryScores at all to match
// against) collect into `other` rather than being silently dropped. Shared
// by both the "currently flagged" and "cleared by a rescore" partitions
// below -- same grouping rule, applied to two different code lists.
function partitionByCategory(codes: string[], categoryScores: QualityCategoryScores | null | undefined): { byCategory: Map<string, string[]>; other: string[] } {
  const byCategory = new Map<string, string[]>();
  const other: string[] = [];
  for (const code of codes) {
    const category = categoryScores ? categoryForIssueCode(code) : null;
    const categoryKeyMatch = category && Object.keys(categoryScores ?? {}).some((k) => k.toLowerCase() === category);
    if (category && categoryKeyMatch) {
      const key = Object.keys(categoryScores ?? {}).find((k) => k.toLowerCase() === category)!;
      byCategory.set(key, [...(byCategory.get(key) ?? []), code]);
    } else {
      other.push(code);
    }
  }
  return { byCategory, other };
}

// The `Cleared: <flag>` list rendered both under a category row (next to
// its own crossing text) and standalone under "Other flags" -- identical
// markup, different surrounding context.
function ClearedList({ codes }: { codes: string[] }): React.ReactElement {
  return (
    <>
      {codes.map((code) => (
        <p key={code} className="text-micro text-ink-3">
          Cleared: {qualityIssueLabel(code).label}
        </p>
      ))}
    </>
  );
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
  style: 'Is it written in active voice, naming who or what performs the action?',
  rationale: 'Does it state WHY when the reason isn’t self-evident?',
};

// `matchedChecklistText`, when present, is a VERBATIM quote from the org's
// own ingested checklist document for this exact category (see ingestion's
// quality_category_checklist docstring, app.workitem.model, and
// _match_category_checklist for the exact-key matching heuristic that
// produced it) -- always shown as a citation, never rewritten/padded, and
// never gated on how long or detailed it is. Org checklists vary wildly:
// some state a precise, multi-clause definition per category; others list
// barely more than the category name itself. Both are genuine, honest
// citations of what the org actually wrote -- presenting either as "the
// definition" would overstate what a sparse source document says, so this
// is framed as a quote of the source, not an assertion that it's a good or
// complete explanation. Falls back to the generic placeholder ONLY when no
// confident match exists at all (see KNOWN_CATEGORY_DESCRIPTIONS above for
// the 5 built-in dimensions, which never have KB text behind them) --
// never on the matched text being short.
function categoryDescription(key: string, matchedChecklistText?: string): string {
  if (matchedChecklistText) {
    return `Per your organization's document: "${matchedChecklistText}"`;
  }
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

// CR-7d rescore: DESIGN.md §11.4.4 -- "the improvement is the point, not the
// new number." A signed delta chip, never a bare "+0" for no movement (that
// reads as an error, not a fact).
function formatDelta(current: number, previous: number): { text: string; color: string } {
  const delta = current - previous;
  if (delta === 0) return { text: 'no change', color: 'var(--color-ink-3)' };
  return { text: delta > 0 ? `▲ +${delta}` : `▼ ${delta}`, color: delta > 0 ? 'var(--color-ok)' : 'var(--color-danger)' };
}

// DESIGN.md §11.4.4 -- "Band crossings are named in words, because that is
// the sentence a customer actually wants." Only on an actual crossing -- a
// row that improved without changing band gets its numeral delta and
// nothing more (checked by the caller via a null return here).
function bandCrossingText(current: number, previous: number): string | null {
  const currentBand = bandFor(current);
  const previousBand = bandFor(previous);
  if (currentBand.label === previousBand.label) return null;
  return `Moved from ${previousBand.label} into ${currentBand.label}.`;
}

// Reused by both the overall gauge's pointer/bar and each category row's
// mini-bar -- a single clamp+color helper keeps the two visually consistent
// (same band thresholds, same colors) even though the category rows render
// as slimmer single-color bars rather than the full three-segment scale.
function CategoryRow({
  label,
  description,
  value,
  previousValue,
  issueCodes,
  clearedCodes,
  expanded,
  onToggle,
}: {
  label: string;
  description: string;
  value: number;
  // CR-7d rescore: this category's value from JUST BEFORE the rescore that
  // produced `value`, so a reviewer sees the real before/after delta, not
  // only the new number with no context for what changed. undefined
  // outside the brief post-rescore window (NodeDetailPanel clears it), or
  // when the category is unchanged.
  previousValue?: number;
  // DESIGN.md §11.4.3 point 3 -- the closed-vocabulary issue codes (already
  // fix-oriented, see utils/labels.ts) that are real evidence for THIS
  // category's number, so "why is this 40" has an answer beyond the digit
  // itself. Empty when no flag maps here (a real, common case -- most
  // categories on most items have nothing wrong with them) or this row has
  // no expand affordance at all.
  issueCodes: string[];
  // CR-7d rescore, DESIGN.md §11.4.4 -- codes that were flagged BEFORE the
  // rescore and are absent from issueCodes now: "the most direct evidence
  // the edit worked... it is free" (the rescore already returns the new
  // issues list). Always-visible (not gated behind expand) for exactly
  // that reason -- it shouldn't take a click to see the edit helped.
  clearedCodes: string[];
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const clamped = clampScore(value);
  const color = categoryColor(clamped);
  const crossing = previousValue !== undefined ? bandCrossingText(clamped, previousValue) : null;
  return (
    <div className="flex flex-col">
      {/* DESIGN.md §11.4.3 -- the category's plain-language definition used
          to live ONLY behind an InfoTip hover; it's now the disclosure's
          own first line, visible on click like everything else here. Every
          row can expand now (there's always a definition to show), not
          only rows with a mapped issue -- unlike the issue-remedy list
          below, which stays conditional. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        // DESIGN.md §6 names "quality-category rows" as a .hoverable-row
        // consumer directly -- an earlier pass here substituted a lighter,
        // hand-rolled hover:bg-surface-alt because the real rail's layout
        // impact (left-edge padding, border-t alongside this list's own gap)
        // couldn't be verified without a running browser; now verified live
        // and safe to use the real shared class.
        className="hoverable-row flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 flex-none text-ink-3" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none text-ink-3" />
        )}
        {/* min-w (not a fixed w-20) -- KB-derived category names (e.g.
            "Correct level", "Missing acceptance criteria") can run longer
            than the 5 generic fallback dimension names this width was
            originally sized for. */}
        <span className="w-20 min-w-fit flex-none text-xs whitespace-nowrap text-ink-2">{label}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-alt">
          <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${clamped}%`, backgroundColor: color }} />
        </div>
        {previousValue !== undefined && previousValue !== clamped && (
          <span className="flex-none font-mono text-micro" style={{ color: formatDelta(clamped, previousValue).color }}>
            {formatDelta(clamped, previousValue).text}
          </span>
        )}
        <span className="w-7 flex-none text-right font-mono text-xs font-semibold tabular-nums" style={{ color }}>
          {clamped}
        </span>
      </button>
      {(crossing || clearedCodes.length > 0) && (
        <div className="flex flex-col gap-0.5 pl-5 pt-0.5">
          {crossing && <p className="text-micro text-ink-2">{crossing}</p>}
          <ClearedList codes={clearedCodes} />
        </div>
      )}
      {/* Same always-mounted grid-row disclosure CollapsibleWarnings
          already uses (grid-template-rows is transitionable, height:auto
          is not) -- the fourth use of this exact pattern in the app, not a
          new one. */}
      <div className={cn('grid pl-5 transition-[grid-template-rows] duration-200 ease-out', expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-1 pt-1.5 pb-0.5">
            <p className="text-xs text-ink-3">{description}</p>
            {issueCodes.length > 0 && (
              <ul className="flex flex-col gap-1">
                {issueCodes.map((code) => {
                  const { label: issueLabel, description: remedy } = qualityIssueLabel(code);
                  return (
                    <li key={code} className="text-xs text-ink-2">
                      <span className="font-medium text-ink-1">{issueLabel}.</span> {remedy}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function QualityGauge({
  score,
  categoryScores,
  categoryChecklist,
  qualityIssues,
  previousScore,
  previousCategoryScores,
  previousIssues,
}: {
  score: number;
  categoryScores?: QualityCategoryScores | null;
  // Per-category citation text backing a SUBSET of categoryScores' keys --
  // see ingestion's quality_category_checklist docstring (app.workitem.
  // model) and categoryDescription's own doc comment above for how/why
  // this renders as a citation, not an assertion. A category absent here
  // is real and expected (no KB standard, or the org's document states no
  // separate definition for it), not a lookup failure -- falls back to
  // categoryDescription's generic sentence for that row only.
  categoryChecklist?: Record<string, string> | null;
  // DESIGN.md §11.4.3 point 3 -- grouped by category below so each row can
  // answer "why is THIS number what it is" with the real, already-written
  // fix-oriented remedy text, not just a plain-language definition of what
  // the category measures in the abstract.
  qualityIssues?: string[];
  // CR-7d rescore: score/categoryScores from JUST BEFORE a rescore, so the
  // "Rescored" state shows a real before/after delta rather than a bare new
  // number the reviewer has no context for. Both undefined outside that
  // brief post-rescore window (NodeDetailPanel owns clearing them).
  previousScore?: number | null;
  previousCategoryScores?: QualityCategoryScores | null;
  // CR-7d rescore, DESIGN.md §11.4.4 -- the issues list from JUST BEFORE a
  // rescore, so a code present here but absent from `qualityIssues` now can
  // render as "Cleared: <flag>" -- the most direct, free evidence an edit
  // actually helped (the rescore already returns the new issues list, no
  // extra call needed).
  previousIssues?: string[];
}): React.ReactElement {
  const clamped = clampScore(score);
  const band = bandFor(clamped);
  const clampedPreviousScore = previousScore != null ? clampScore(previousScore) : undefined;
  const headlineCrossing =
    clampedPreviousScore !== undefined ? bandCrossingText(clamped, clampedPreviousScore) : null;
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  function toggleCategory(key: string): void {
    setExpandedCategories((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Grouped once per render, not per row -- see partitionByCategory's own
  // doc comment. Codes with no category match collect into "Other flags"
  // below rather than being silently dropped.
  const { byCategory: issuesByCategory, other: otherIssues } = partitionByCategory(qualityIssues ?? [], categoryScores);

  // Same partition, but for codes CLEARED by a rescore (present in
  // previousIssues, absent from qualityIssues now) -- grouped identically
  // so "Cleared: X" renders under the exact category row it used to flag,
  // never a guessed one.
  const currentIssueSet = new Set(qualityIssues ?? []);
  const clearedCodes = (previousIssues ?? []).filter((code) => !currentIssueSet.has(code));
  const { byCategory: clearedByCategory, other: clearedOther } = partitionByCategory(clearedCodes, categoryScores);

  // req2ado's own display thresholds, not an ADO/LLM-defined scale --
  // matches the semantic-token family each band already keys off (ok/
  // warning/danger), never a raw hex.
  const bandChipClass: Record<(typeof BANDS)[number]['label'], string> = {
    Solid: 'bg-ok-soft border-ok-border text-ok-ink',
    'Needs review': 'bg-warning-soft border-warning-border text-warning-ink',
    'Needs rework': 'bg-danger-soft border-danger-border text-danger-ink',
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-ink-2">Quality</span>
        <InfoTip content="req2ado's own read on this requirement's wording, from a single LLM judgment (0-100). Not an ADO field and not part of the work item." />
        {/* Headline delta always renders (even "no change") when a
            previousScore was supplied at all -- DESIGN.md §11.4.4: the
            words "no change" beat a silent screen just as much as they
            beat a bare "+0". Per-category rows below take the opposite
            rule (no ornament at all when unmoved) since fifteen unchanged
            rows decorated to make one changed row findable inverts the
            signal -- the headline has no such crowding problem. */}
        {clampedPreviousScore !== undefined && (
          <span className="ml-auto flex items-center gap-1 font-mono text-micro">
            <span style={{ color: formatDelta(clamped, clampedPreviousScore).color }}>
              {formatDelta(clamped, clampedPreviousScore).text}
            </span>
            {clampedPreviousScore !== clamped && <span className="text-ink-3">(was {clampedPreviousScore})</span>}
          </span>
        )}
        {/* Real gap fixed here (confirmed against the agreed mockup, which
            has NO axis/tick-scale markup or CSS anywhere for this element):
            this used to render a full 3-segment proportional band scale with
            a floating triangle pointer and a min-max/label legend row below
            it -- a lot of chrome for one number, the exact thing DESIGN.md's
            own ETA section removed a similar calibrated-band/tick/legend
            visualization for ("chrome around one figure reads as more
            information than there is"). The agreed design's own gauge
            header is just the number, "/ 100", and the band as a plain
            tinted chip -- matches `.gauge-top .sc`/`.of`/`.chip` in the
            mockup's own CSS exactly, nothing more. */}
        <span
          className={cn('font-mono text-sm font-semibold tabular-nums', clampedPreviousScore === undefined && 'ml-auto')}
          style={{ color: band.color }}
        >
          {clamped}
        </span>
        <span className="font-mono text-micro text-ink-3">/ 100</span>
        <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-micro font-medium', bandChipClass[band.label])}>
          {band.label}
        </span>
      </div>
      {headlineCrossing && <p className="text-xs text-ink-2">{headlineCrossing}</p>}

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
            <CategoryRow
              key={key}
              label={categoryLabel(key)}
              description={categoryDescription(key, categoryChecklist?.[key])}
              value={value}
              previousValue={previousCategoryScores?.[key]}
              issueCodes={issuesByCategory.get(key) ?? []}
              clearedCodes={clearedByCategory.get(key) ?? []}
              expanded={expandedCategories.has(key)}
              onToggle={() => toggleCategory(key)}
            />
          ))}
        </div>
      )}
      {/* Other flags -- issue codes that are real evidence something's
          wrong but aren't about a single wording dimension (whether this
          is even a requirement, a data conflict in the source, etc.), so
          forcing one onto e.g. "clarity" would be a guess this component
          deliberately does not make (utils/qualityCategories.ts). Never
          dropped just because they don't fit a bar. Always-visible (no
          toggle) -- there's no parent row this detail could hide under. */}
      {otherIssues.length > 0 && (
        <div className="mt-1 flex flex-col gap-1 border-t border-hairline pt-2">
          <span className="text-xs font-semibold text-ink-2">Other flags</span>
          <ul className="flex flex-col gap-1">
            {otherIssues.map((code) => {
              const { label: issueLabel, description: remedy } = qualityIssueLabel(code);
              return (
                <li key={code} className="text-xs text-ink-2">
                  <span className="font-medium text-ink-1">{issueLabel}.</span> {remedy}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {clearedOther.length > 0 && (
        <div className={cn('flex flex-col gap-0.5', otherIssues.length === 0 && 'mt-1 border-t border-hairline pt-2')}>
          <ClearedList codes={clearedOther} />
        </div>
      )}
    </div>
  );
}
