import { Stepper } from '../ui/Stepper';
import { InfoTip } from '../ui/Tooltip';
import type { JobStage, NarrationEvent } from '../api/events';

// SURVEY-only: BASELINE has no scoring/dedup-check distinction worth a
// step of its own (no LLM at all, finishes in seconds) -- see this
// component's only call site in JobDetail.tsx, gated on mode === 'survey'.
const STEPS = ['Parse', 'Analyze', 'Score', 'Dedup-check', 'Review', 'Confirm'];

const STEP_TIPS = [
  'Reading the document and splitting it into sections.',
  'Inferring the work-item hierarchy and drafting requirement text for each section.',
  "Judging each drafted requirement's quality (clarity, testability, atomicity, style, rationale).",
  'Checking whether a near-identical work item already exists under this area path, to avoid creating duplicates.',
  'Awaiting your review of the proposed diff -- nothing is written to Azure DevOps yet.',
  'Writing the reviewed work items to Azure DevOps. This step cannot be undone.',
];

// A persistent, whole-lifecycle overview -- unlike ProgressBanner (which
// only renders while status is 'running'/'writing' and disappears once a
// job reaches diff_ready), this stays visible on the review page too, so
// "where am I in the process" has an answer even while waiting on a human
// decision, previously the one gap in the pipeline with literally no step
// indicator at all.
export function SurveyPipelineSteps({
  status,
  stage,
  latestNarrationPhase,
}: {
  status: string;
  stage: JobStage | null;
  // The most recent narration's own phase, if any -- needed because
  // JobStage alone can't distinguish "generation just finished, about to
  // score" from "mid-scoring, about to reach dedup_check": no dedicated
  // JobStage fires when scoring starts (see job-events.publisher.ts's own
  // comment on which stages the worker actually emits).
  latestNarrationPhase?: NarrationEvent['phase'] | null;
}): React.ReactElement {
  const activeIndex = overallStepIndex(status, stage, latestNarrationPhase);
  return (
    <div className="mb-4 flex items-center gap-1.5">
      {/* The scroll container is its own element (not the whole row) so the
          InfoTip never scrolls away with it -- it previously shared one
          overflow-x-auto with the Stepper, so on a narrow panel the info
          icon itself could scroll out of view along with the later steps.
          The right-edge mask fade is a real "there's more, scroll right"
          affordance -- previously a narrow container just silently clipped
          the later steps with only a bare (easy-to-miss) scrollbar as the
          only signal anything was cut off. */}
      <div className="overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]">
        <Stepper
          steps={STEPS}
          activeIndex={activeIndex}
          activeSpinner={status === 'running' || status === 'writing'}
        />
      </div>
      <InfoTip content={STEP_TIPS[Math.min(activeIndex, STEP_TIPS.length - 1)]} />
    </div>
  );
}

function overallStepIndex(
  status: string,
  stage: JobStage | null,
  latestNarrationPhase?: NarrationEvent['phase'] | null,
): number {
  if (status === 'writing') return 5;
  if (status === 'diff_ready') return 4;
  if (status === 'pending') return 0;
  if (status === 'running') {
    if (stage === 'dedup_check') return 3;
    // detect_conflicts/regroup_roots run AFTER scoring finishes, still
    // BEFORE dedup_check -- without these two, the stepper regressed back
    // to "Analyze" (index 1) during both passes on a real large document,
    // a real behavioral misalignment a user would notice directly (the
    // step indicator moving backwards mid-run).
    if (
      latestNarrationPhase === 'score_requirements' ||
      latestNarrationPhase === 'score_requirements_done' ||
      latestNarrationPhase === 'detect_conflicts' ||
      latestNarrationPhase === 'regroup_roots'
    ) {
      return 2;
    }
    if (stage === 'parse') return 0;
    return 1; // infer_hierarchy_start / generate_requirements_start / _done
  }
  // Terminal non-happy-path statuses (failed/cancelled/rejected/succeeded)
  // have no single "current step" left to point at -- freeze on the
  // furthest real stage-derived position rather than guessing, same
  // honesty standard as ProgressBanner's own ETA calc.
  if (stage === 'dedup_check') return 3;
  if (stage === 'diff_ready') return 4;
  if (stage === 'parse') return 0;
  return 1;
}
