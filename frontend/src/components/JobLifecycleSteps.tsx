import { Stepper, type StepState } from '../ui/Stepper';
import { InfoTip } from '../ui/Tooltip';
import type { JobStage } from '../api/events';

export type LifecycleKey = 'parse' | 'analyze' | 'score' | 'dedupCheck' | 'review' | 'write';

interface StepDef {
  key: LifecycleKey;
  label: string;
  tip: string;
}

// SURVEY runs two LLM passes (Analyze, Score) BASELINE never has -- BASELINE
// is deterministic, verbatim, no LLM at all, so Analyze/Score would sit
// permanently grey and misrepresent the pipeline if shown for it.
const SURVEY_STEPS: StepDef[] = [
  { key: 'parse', label: 'Parse', tip: 'Reading the document and splitting it into sections.' },
  { key: 'analyze', label: 'Analyze', tip: 'Inferring the work-item hierarchy and drafting requirement text for each section.' },
  { key: 'score', label: 'Score', tip: "Judging each drafted requirement's quality (clarity, testability, atomicity, style, rationale)." },
  {
    key: 'dedupCheck',
    label: 'Dedup check',
    tip: 'Checking whether a near-identical work item already exists under this area path, to avoid creating duplicates.',
  },
  { key: 'review', label: 'Review', tip: 'Awaiting your review of the proposed diff -- nothing is written to Azure DevOps yet.' },
  { key: 'write', label: 'Write', tip: 'Writing the reviewed work items to Azure DevOps. This step cannot be undone.' },
];

const BASELINE_STEPS: StepDef[] = [
  { key: 'parse', label: 'Parse', tip: 'Reading the document verbatim -- deterministic, no LLM, no distillation.' },
  {
    key: 'dedupCheck',
    label: 'Dedup check',
    tip: 'Checking whether a near-identical work item already exists under this area path, to avoid creating duplicates.',
  },
  { key: 'review', label: 'Review', tip: 'Awaiting your review of the proposed diff -- nothing is written to Azure DevOps yet.' },
  { key: 'write', label: 'Write', tip: 'Writing the reviewed work items to Azure DevOps. This step cannot be undone.' },
];

function stepsFor(mode: 'baseline' | 'survey'): StepDef[] {
  return mode === 'survey' ? SURVEY_STEPS : BASELINE_STEPS;
}

// Which step the pipeline has REACHED, independent of how that step should
// be painted (done/current/failed/etc -- see statesFor). Ported verbatim
// from the pre-rebuild SurveyPipelineSteps' overallStepIndex, including its
// comments: the detect_conflicts/regroup_roots guard exists because those
// two whole-tree passes run AFTER scoring finishes but BEFORE dedup_check,
// so without it the stepper would regress backwards to "Analyze" mid-run on
// a real large document -- a real, user-visible regression on the original
// index-based version.
function reachedKeyFor(
  mode: 'baseline' | 'survey',
  status: string,
  stage: JobStage | null,
  // Not NarrationEvent['phase'] alone -- JobDetail.tsx resolves a job_failed
  // event's own lastPhase (a free-text field, not the strict phase union)
  // through this same prop before calling in here, so the type has to
  // admit that too.
  latestNarrationPhase?: string | null,
): LifecycleKey {
  if (status === 'writing') return 'write';
  if (status === 'diff_ready' || status === 'rejected') return 'review';
  if (status === 'succeeded') return 'write';
  if (status === 'pending') return 'parse';

  let key: LifecycleKey;
  if (status === 'running') {
    // Real bug this fixes (confirmed live): `dedup_check` is BOTH a
    // JobStage (`stage`, the coarse SSE signal checked below) AND its own
    // NarrationEvent phase, with real content ("Checking for existing/
    // duplicate work items...") that starts arriving before the coarser
    // stage event catches up. In that real gap, `stage` was still
    // whatever it was during scoring, and `latestNarrationPhase ===
    // 'dedup_check'` matched none of the recognized score-adjacent
    // phases below -- falling through to the hardcoded "Analyze" default,
    // then jumping straight to Dedup check (skipping Score entirely,
    // visibly) once `stage` finally updated. Same bug class this
    // function's own comments already fixed twice for detect_conflicts/
    // regroup_roots/infer_trace_links -- this was the one phase still
    // missing from that list.
    if (stage === 'dedup_check' || latestNarrationPhase === 'dedup_check') {
      key = 'dedupCheck';
    } else if (
      latestNarrationPhase === 'score_requirements' ||
      latestNarrationPhase === 'score_requirements_done' ||
      latestNarrationPhase === 'detect_conflicts' ||
      latestNarrationPhase === 'regroup_roots' ||
      // Another whole-tree pass that runs after scoring, before dedup_check --
      // omitting it here regressed the stepper backward to "Analyze" (confirmed
      // live), the exact bug this whole condition exists to prevent.
      latestNarrationPhase === 'infer_trace_links'
    ) {
      key = 'score';
    } else if (stage === 'parse') {
      key = 'parse';
    } else {
      key = 'analyze'; // infer_hierarchy_start / generate_requirements_start / _done
    }
  } else {
    // Terminal non-happy-path statuses (failed/cancelled) have no single
    // "current step" left to point at -- freeze on the furthest real
    // stage-derived position rather than guessing, same honesty standard
    // as ProgressBanner's own ETA calc. Real bug fixed here (confirmed
    // live): this branch used to check ONLY `stage`, never
    // `latestNarrationPhase` -- but `stage` is set exclusively by the live
    // SSE subscription (JobDetail.tsx), which never opens for a job that
    // was already terminal on page load (the common case: navigating
    // straight to an already-failed/cancelled job, not watching it fail).
    // `stage` was therefore always null in that case, and every such job
    // silently fell through to the hardcoded "Analyze" default below
    // regardless of how far it actually got -- a real job that finished
    // parsing, scoring, and dedup/grouping/trace-link inference before
    // failing at the very last phase still showed "failed at Analyze".
    if (stage === 'dedup_check' || latestNarrationPhase === 'dedup_check') key = 'dedupCheck';
    else if (stage === 'diff_ready') key = 'review';
    else if (
      latestNarrationPhase === 'score_requirements' ||
      latestNarrationPhase === 'score_requirements_done' ||
      latestNarrationPhase === 'detect_conflicts' ||
      latestNarrationPhase === 'regroup_roots' ||
      latestNarrationPhase === 'infer_trace_links'
    ) {
      key = 'score';
    } else if (stage === 'parse') key = 'parse';
    else key = 'analyze';
  }

  // Baseline never actually emits an analyze/score narration phase (it runs
  // no LLM), so this only fires defensively -- collapse back to the one
  // step baseline does have.
  if (mode === 'baseline' && (key === 'analyze' || key === 'score')) return 'parse';
  return key;
}

// Paints every step relative to the reached key. A single "active index"
// (the pre-rebuild version's whole API) can't express completed HISTORY,
// a frozen-at-failure state, or a skipped step all at once -- this is why
// the stepper needed a full per-step state vector, not just a number.
function statesFor(keys: LifecycleKey[], reached: LifecycleKey, status: string): StepState[] {
  const reachedIndex = keys.indexOf(reached);
  return keys.map((key, index) => {
    if (index < reachedIndex) return 'done';
    if (index > reachedIndex) {
      // A rejected diff is a decision, not an omission -- Write is
      // explicitly skipped, not merely "not reached yet".
      return status === 'rejected' && key === 'write' ? 'skipped' : 'pending';
    }
    switch (status) {
      case 'pending':
        return 'awaiting'; // queued, nothing running yet
      case 'running':
        return 'current';
      case 'diff_ready':
        return 'awaiting'; // a human decision point, not a running process
      case 'writing':
        return 'current';
      case 'succeeded':
        return 'done';
      case 'rejected':
        return 'done'; // the review step itself WAS completed -- a decision was made
      case 'failed':
      case 'cancelled':
        return 'failed';
      default:
        return 'pending';
    }
  });
}

// A persistent, whole-lifecycle overview -- unlike ProgressBanner (which
// only renders while status is 'running'/'writing' and disappears once a
// job reaches diff_ready), this stays visible on the review page too, so
// "where am I in the process" has an answer even while waiting on a human
// decision. Renders for BOTH modes now (previously survey-only) -- baseline
// jobs get their own 4-step set instead of being gated out entirely.
export function JobLifecycleSteps({
  mode,
  status,
  stage,
  latestNarrationPhase,
  subLabelByKey,
}: {
  mode: 'baseline' | 'survey';
  status: string;
  stage: JobStage | null;
  // The most recent narration's own phase, if any -- needed because
  // JobStage alone can't distinguish "generation just finished, about to
  // score" from "mid-scoring, about to reach dedup_check": no dedicated
  // JobStage fires when scoring starts (see job-events.publisher.ts's own
  // comment on which stages the worker actually emits). Not
  // NarrationEvent['phase'] alone -- JobDetail.tsx resolves a job_failed
  // event's own lastPhase (free text, not the strict phase union) through
  // this same prop, so the real last-reached phase survives even when the
  // very last narration IS the failure marker itself.
  latestNarrationPhase?: string | null;
  // Optional real sub-phase context this stepper's own keys can't show on
  // their own (figure-caption progress during "Parse", which of
  // deterministic_subtree's two chunked passes is active during
  // "Analyze") -- computed by the caller from the same narration data it
  // already has, since only it knows the raw fields these come from.
  subLabelByKey?: Partial<Record<LifecycleKey, string>>;
}): React.ReactElement {
  const stepDefs = stepsFor(mode);
  const keys = stepDefs.map((s) => s.key);
  const reached = reachedKeyFor(mode, status, stage, latestNarrationPhase);
  const states = statesFor(keys, reached, status);
  const reachedIndex = Math.max(0, keys.indexOf(reached));

  let tip = stepDefs[reachedIndex].tip;
  // detect_conflicts/regroup_roots/infer_trace_links are deliberately mapped
  // onto the "Score" step (reachedKeyFor above -- giving them their own step
  // would regress the stepper backward), but Score's own static tip
  // ("Judging each drafted requirement's quality...") is wrong for these --
  // confirmed live: the tooltip visibly disagreed with the narration bar's
  // own text for the same moment. Override it to describe the actual
  // sub-phase instead of always describing scoring.
  if (reached === 'score' && latestNarrationPhase === 'detect_conflicts') {
    tip = 'Checking newly-drafted requirements against each other for near-duplicate/conflicting values.';
  } else if (reached === 'score' && latestNarrationPhase === 'regroup_roots') {
    tip = 'Grouping disconnected sections under a shared topic before dedup check.';
  } else if (reached === 'score' && latestNarrationPhase === 'infer_trace_links') {
    tip = 'Resolving trace/coverage links between requirements.';
  }
  if (status === 'cancelled') tip = 'Cancelled here.';
  else if (status === 'failed') tip = 'The job failed here.';

  return (
    // No bottom margin/padding of its own -- this sits inside a shared
    // bordered container together with NarrationTicker (JobDetail.tsx),
    // flush against the ticker's dark bar below it.
    <div className="flex items-center gap-1.5 p-3.5">
      {/* The scroll container is its own element (not the whole row) so the
          InfoTip never scrolls away with it -- it previously shared one
          overflow-x-auto with the Stepper, so on a narrow panel the info
          icon itself could scroll out of view along with the later steps.
          The right-edge mask fade is a real "there's more, scroll right"
          affordance -- previously a narrow container just silently clipped
          the later steps with only a bare (easy-to-miss) scrollbar as the
          only signal anything was cut off.

          py-0.5 (2px top+bottom, so 4px combined -- matches
          `@keyframes pulse-ring`'s exact peak box-shadow spread in
          index.css) is a deliberate fix, not stray spacing. Per the CSS
          Overflow spec, a `visible` value paired with a non-`visible`
          value on the other axis resolves to the SAME type as that other
          axis -- setting `overflow-x-auto` alone therefore forces
          `overflow-y` to compute as `auto` too, in every compliant
          browser, not just some engines; an explicit `overflow-y-visible`
          would still be overridden the same way, so it isn't used here.
          The pulse's glow was being clipped flat by that forced auto
          scrollport; this padding gives the scrollport itself enough room
          that the glow fits within its own bounds instead of relying on
          bleeding past them. */}
      <div className="min-w-0 flex-1 overflow-x-auto py-0.5 [mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]">
        <Stepper steps={stepDefs.map((s) => s.label)} states={states} subLabels={keys.map((key) => subLabelByKey?.[key])} />
      </div>
      <InfoTip content={tip} />
    </div>
  );
}
