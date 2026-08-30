import { useMemo } from 'react';
import { Check, Circle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useNow } from '../hooks/useNow';
import { useSecondsSinceLastUpdate } from '../hooks/useSecondsSinceLastUpdate';
import { useWindowStartedAt } from '../hooks/useWindowStartedAt';
import { useWindowBaselineUnits } from '../hooks/useWindowBaselineUnits';
import { parseDeterministicSubtreeChunk } from '../utils/deterministicSubtreeChunk';
import { ElapsedTimer } from './ElapsedTimer';
import { ProgressBar } from '../ui/ProgressBar';
import { Spinner } from '../ui/Spinner';
import { Chip } from '../ui/Chip';
import { InfoTip } from '../ui/Tooltip';
import { Stepper } from '../ui/Stepper';
import type { JobStage, NarrationEvent } from '../api/events';

// Short sub-labels shown next to the currently-active section in the step
// list -- the narration message itself is more verbose (includes block
// counts), this is just "which of the section's three passes is running".
// describe_figure/parse_done have no per-section step row (see the
// SectionStepList render guard below, gated on branchCount > 0) so their
// entries here are never actually looked up -- present only so this Record
// stays exhaustive over NarrationEvent['phase'].
//
// DESIGN.md §11.3 -- also the source of ProgressBanner's own headline
// (`text-title`, "the phase headline in plain language -- 'Checking for
// duplicates,' never dedup_check"): reused directly rather than
// duplicating a second near-identical Record for the same concept in the
// same file.
const PHASE_SUBLABEL: Record<NarrationEvent['phase'], string> = {
  describe_figure: 'Describing figures',
  parse_done: 'Parsing complete',
  table_detected: 'Detecting tables',
  preparing_analysis: 'Preparing analysis',
  deterministic_subtree: 'Extracting deterministic hierarchy',
  // STAGE 1 of SURVEY's per-branch generation -- deciding structure only,
  // before any requirement text exists (see events.ts's own comment for the
  // stale-'analyze_section'-label gap this replaces).
  build_skeleton: 'Building document structure',
  analyze_section: 'Analyzing and synthesizing requirements',
  infer_hierarchy: 'Analyzing structure',
  generate_requirements: 'Generating requirements',
  // STAGE 2 -- whole-document figure/table -> node mapping, between
  // build_skeleton and analyze_section/section_complete.
  map_scope: 'Mapping figures and tables to their sections',
  score_requirements: 'Scoring quality',
  score_requirements_done: 'Scoring complete',
  section_complete: 'Section complete',
  detect_conflicts: 'Checking for conflicts',
  regroup_roots: 'Grouping by topic',
  infer_trace_links: 'Resolving trace links',
  // Docx-only, fires during parse like describe_figure/parse_done above --
  // never actually looked up for the same reason (no per-section row),
  // present only so this Record stays exhaustive.
  page_alignment: 'Deriving page numbers',
  // dedup_check is never looked up for the SectionStepList sub-label (it
  // always carries branchCount 0, so no per-section row reads it), but IS
  // now read for ProgressBanner's own headline -- spec's own quoted example
  // text.
  dedup_check: 'Checking for duplicates',
  writing: 'Writing to Azure DevOps',
  job_failed: 'Job failed',
  // Never actually looked up (a chunk_warning never becomes `latest` in a
  // way that reads this map -- it's surfaced via CollapsibleWarnings, not
  // the section step sublabel), present only so this Record stays exhaustive.
  chunk_warning: 'A chunk of work failed',
};

// Fraction of a branch's OWN total work that stage 1 (its skeleton call)
// accounts for, used both to discount the cross-branch credit build_skeleton
// carries and as the credit stage 3's own opening event may claim for the
// branch it is starting -- see the priorBranchCredit comment below for why
// that discount is needed at all. ~0.3 is the same stage-cost split
// orchestrator/src/modules/pipeline/eta.service.ts's Part B recalibration
// note derives (skeleton ~0.52 of ~1.63 total per-branch units); it is not
// a free-floating fudge factor, and the two should move together.
const SKELETON_STAGE_SHARE = 0.3;

// Fraction of ONE section's own work considered done once a given phase
// STARTS (not finishes) -- e.g. seeing "generate_requirements" start means
// this section's hierarchy pass already finished, so that section is
// already ~40% through its own three passes. Used only to give the overall
// bar partial credit WITHIN the currently-running section, instead of the
// bar sitting frozen at the previous section's total for however long that
// section's three passes take (the actual bug being fixed here: blocksDone
// only updates once a WHOLE section finishes, which can be many minutes).
const PHASE_START_WEIGHT: Record<NarrationEvent['phase'], number> = {
  describe_figure: 0,
  parse_done: 0,
  table_detected: 0,
  preparing_analysis: 0,
  deterministic_subtree: 0,
  // Fires at the very start of a branch's own three-stage sequence, before
  // build_skeleton's own skeleton call has returned -- no credit accrued yet.
  build_skeleton: 0,
  // STAGE 3's opening event: by the time content authoring starts for this
  // branch, the branch's own skeleton call (stage 1) has genuinely finished,
  // which is exactly SKELETON_STAGE_SHARE of its work. This value is also
  // what the stage-1 clamp below is measured against -- stage 1 may never run
  // the bar past the SMALLEST number stage 3 can report, and since stage 3
  // now opens with analyze_section (it used to open with section_complete,
  // which claims a whole section share) that floor moved down to here.
  analyze_section: SKELETON_STAGE_SHARE,
  infer_hierarchy: 0,
  generate_requirements: 0.4,
  // Whole-document, branch_index=None phase (same convention
  // detect_conflicts/regroup_roots/infer_trace_links use) -- included in
  // isTailPhase below for the same reason those three are: no fixed
  // per-section progress model applies, so this value is never actually
  // looked up, present only so this Record stays exhaustive.
  map_scope: 1,
  score_requirements: 0.75,
  score_requirements_done: 1,
  section_complete: 1,
  detect_conflicts: 1,
  regroup_roots: 1,
  infer_trace_links: 1,
  // Parse-stage phase, same as describe_figure/parse_done above -- section
  // scoring hasn't started yet, so no partial credit to give.
  page_alignment: 0,
  // Never actually read: dedup_check/writing both carry branchCount 0, so
  // the `averageSectionShare * PHASE_START_WEIGHT[...]` term this Record
  // feeds is always multiplied by 0 anyway -- their blocksDone/blocksTotal
  // is already a real, direct completed/total count (not "sections done"),
  // unlike every other phase this Record actually matters for.
  dedup_check: 0,
  writing: 0,
  job_failed: 0,
  chunk_warning: 0,
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function ProgressBanner({
  stage,
  startedAt,
  mode,
  narrations,
  completedSectionIndices,
  jobId,
}: {
  stage: JobStage;
  startedAt: string;
  mode: 'baseline' | 'survey';
  // SURVEY-only, richer per-step narration (see NarrationEvent) -- undefined/
  // empty falls back to the coarse stage-only display below, matching
  // pre-narration behavior exactly (BASELINE never produces these at all).
  narrations?: NarrationEvent[];
  // Optional -- when given, the deterministic_subtree ETA's window-start
  // timestamp persists to sessionStorage under this job, surviving a
  // reload of the same running job in the same tab (see
  // useWindowStartedAt's own comment for the live bug this fixes). Absent
  // callers just lose that persistence, not correctness.
  jobId?: string;
  // Branch indices with a durable, uncapped section_complete record (see
  // JobDetail's sectionResultsByIndex) -- union'd into SectionStepList's
  // completedSections below so a row survives the 50-event narration cap on
  // documents with enough branches. See that Set's own comment for why
  // `narrations` alone isn't enough on its own past ~25 sections.
  completedSectionIndices?: number[];
}): React.ReactElement {
  const latest = narrations && narrations.length > 0 ? narrations[narrations.length - 1] : null;

  // score_requirements/score_requirements_done are no longer part of
  // isTailPhase below -- unlike every other whole-document tail phase, the
  // full requirement-node count is known BEFORE scoring starts (see
  // scoring.py's _score_all_requirements), so blocksDone/blocksTotal here
  // carry real cumulative progress, not the fabricated blocksDone===
  // blocksTotal every other tail phase reports. Computed directly (no
  // section-share weighting -- that model doesn't apply once blocksTotal
  // means "requirement nodes scored", not "document blocks").
  const isScoringPhase = latest?.phase === 'score_requirements' || latest?.phase === 'score_requirements_done';
  // Estimated overall progress: fully-completed sections' share of the
  // document, plus partial credit for however far the CURRENT section has
  // gotten through its own three passes. `blocksDone` alone (completed
  // sections only) freezes at the same value for a section's entire
  // multi-minute duration -- this is a genuine estimate, not an exact
  // count, since sections vary in real size and this assumes an even split.
  // The remaining whole-document tail phases (conflict detection, root
  // regrouping, trace-link inference) report blocksDone === blocksTotal --
  // every section is already finished by the time any of them run (see
  // llm_leveling.py's build_survey_tree) -- so the block-based unit model
  // below has no real remaining "blocks" to measure against, even though
  // real work (and real time) is still left. Projecting a number out of it
  // here would be exactly the fabricated-guess this app's own "do not
  // guess, calculate" standard forbids -- these phases show a genuinely
  // indeterminate bar and an honest "no fixed step count for this pass"
  // message instead of a fake countdown.
  // map_scope runs in the exact same whole-document, branch_index=None
  // window regroup_roots already does (between stage 1's skeleton pass
  // across every branch and stage 3's content authoring for any of them) --
  // grouped with it here for the same reason: no fixed per-section progress
  // model applies to a single whole-document pass.
  const isTailPhase =
    latest?.phase === 'detect_conflicts' ||
    latest?.phase === 'regroup_roots' ||
    latest?.phase === 'map_scope' ||
    latest?.phase === 'infer_trace_links';
  // Distinct from isTailPhase -- this phase runs at the very START of
  // analysis (before branchCount is even known), so "Finishing up…" would
  // be actively misleading here. Only shares isTailPhase's OTHER effect:
  // the metrics box showing real "no fixed step count" text instead of
  // rendering blank (see the "cannot be blank" fix below).
  const isPreparingAnalysis = latest?.phase === 'preparing_analysis';
  let completedUnits: number | undefined;
  // Real denominator for THIS phase's progress -- almost always blocksTotal,
  // except describe_figure below, where blocksTotal isn't known yet (block
  // counting hasn't run) but figureCount already is.
  let progressTotal: number | undefined;
  if (latest && isScoringPhase && latest.blocksTotal > 0) {
    completedUnits = latest.blocksDone;
    progressTotal = latest.blocksTotal;
  } else if (
    latest &&
    latest.phase === 'describe_figure' &&
    latest.figureIndex != null &&
    latest.figureCount != null &&
    latest.figureCount > 0
  ) {
    // Real fix for a confirmed live gap: a figure-heavy document (36
    // figures, ~3.5 real minutes of sequential vision-model calls) showed
    // "Working -- no progress estimate for this step yet." the entire time,
    // even though "figure N of 36" was already known and rendered right
    // above this same panel -- the two numbers just weren't wired together.
    completedUnits = latest.figureIndex;
    progressTotal = latest.figureCount;
  } else if (latest && latest.blocksTotal > 0 && !isTailPhase) {
    const averageSectionShare = latest.branchCount > 0 ? latest.blocksTotal / latest.branchCount : 0;
    const withinSectionCredit = averageSectionShare * PHASE_START_WEIGHT[latest.phase];
    // blocksDone is "every block in the branches BEFORE this one"
    // (llm_leveling's blocks_done_before_by_branch). Before Part B that
    // genuinely meant those branches were FINISHED -- one call per branch,
    // so a later branch starting implied every earlier one was done. It no
    // longer does: stage 1 sweeps EVERY branch's skeleton call before the
    // mapping pass or a single word of content exists, so at build_skeleton
    // time the prior branches are one stage of three in, not complete.
    // Taking blocksDone at face value here ran the bar up to ~(N-1)/N
    // during stage 1 alone and then dropped it back to ~1/N on stage 3's
    // first section_complete -- a visibly backward bar, the same regression
    // class as the stepper un-checking B5 fixed.
    //
    // Discounting by SKELETON_STAGE_SHARE alone does NOT fix that: it only
    // holds while 0.3*(N-1)/N <= 1/N, i.e. N <= 4. At N=6 stage 1 still
    // ends at 25% against stage 3's first 16.7%, at N=10 at 27% against
    // 10% -- smaller than the un-discounted jump, still backward, and this
    // suite's own fixtures already use branchCount 6. So the discounted
    // value is additionally CLAMPED to the smallest credit stage 3 can ever
    // report, so stage 1 cannot outrun what comes next at any branch count.
    // That floor is one section's share weighted by stage 3's OPENING phase:
    // stage 3 used to open with section_complete (a whole section share),
    // but now opens with analyze_section for branch 0 (blocksDone 0 +
    // SKELETON_STAGE_SHARE of one section) -- so the clamp tracks
    // PHASE_START_WEIGHT.analyze_section rather than hardcoding the old
    // full-share value, which would have re-opened the same backward step.
    // ONLY build_skeleton is touched -- section_complete's blocksDone still
    // means exactly what it always did -- and the result stays honest in the
    // pessimistic direction.
    const priorBranchCredit =
      latest.phase === 'build_skeleton'
        ? Math.min(
            latest.blocksDone * SKELETON_STAGE_SHARE,
            averageSectionShare * PHASE_START_WEIGHT.analyze_section,
          )
        : latest.blocksDone;
    completedUnits = priorBranchCredit + withinSectionCredit;
    progressTotal = latest.blocksTotal;
  }
  const progressValue =
    completedUnits !== undefined && progressTotal ? (100 * completedUnits) / progressTotal : undefined;
  const clampedProgress = progressValue !== undefined ? Math.min(Math.max(progressValue, 0), 100) : undefined;
  // Single shared clock tick -- both the ETA calc below and the "last
  // update Ns ago" counter derive from this one useNow() call instead of
  // each owning its own setInterval.
  const tickingNow = useNow();
  const secondsSinceUpdate = useSecondsSinceLastUpdate(narrations?.length ?? 0, tickingNow);
  // deterministic_subtree runs as several sequential, whole-chunk-blocking
  // LLM calls (up to 150 nodes each -- see id_tree_builder.py's
  // _apply_synthesis_pass/_apply_title_tag_pass), and also runs TWO
  // distinct passes back to back (synthesis, then title/tag enhancement)
  // that share this same phase string but carry different blocksTotal
  // values. Confirmed live on a real 679-block document: computing the
  // rate from `now - job startedAt` blends in whatever phase ran before
  // this one (here, ~3.5 real minutes of unrelated figure-captioning work)
  // AND, once a second pass starts, blends in the FIRST pass's own
  // duration too -- producing an ETA that is not just imprecise but
  // actively wrong in either direction (confirmed live: an 8-minute
  // estimate on a phase that took under 5, followed by a "~20s left"
  // reading that stayed flat for over two real minutes). Re-baselining to
  // when this exact (phase, blocksTotal) window started fixes both: a new
  // pass beginning (blocksTotal changing) restarts the clock exactly like
  // a new phase starting does.
  const detSubtreeWindowKey =
    latest?.phase === 'deterministic_subtree' ? `${latest.phase}:${latest.blocksTotal}` : undefined;
  // Confirmed live: reloading the SAME running job in the SAME tab
  // partway through a chunk remounts this whole component -- without a
  // storageKey, the window-start ref re-baselines to the reload moment
  // even though completedUnits already reflects several real minutes of
  // prior work, producing a briefly wildly-optimistic ETA (~40s instead
  // of ~5-6 real minutes left) right after reload. jobId-scoped so a
  // different job's leftover sessionStorage entry is never read.
  const detSubtreeStorageKey =
    detSubtreeWindowKey && jobId ? `progress-window:${jobId}:${detSubtreeWindowKey}` : undefined;
  const detSubtreeWindowStartedAt = useWindowStartedAt(detSubtreeWindowKey, tickingNow, detSubtreeStorageKey);
  // Real gap this closes (confirmed live): the ETA fixes above make the
  // wait honest, not informative -- for most of a run the user still
  // watches a static line for 4-9 real minutes with zero content. Chunk
  // position/pass name aren't emitted as structured fields (unlike
  // score_requirements's chunkIndex/chunkCount) -- parsed back out of the
  // same subtreeLabel text every other deterministic_subtree display
  // already reads.
  const detSubtreeChunk =
    latest?.phase === 'deterministic_subtree' ? parseDeterministicSubtreeChunk(latest.subtreeLabel) : null;
  // Real gap this closes: the chunk explainer alone read as a static,
  // interchangeable line no matter how long a chunk had actually been
  // running -- no sense that anything was progressing. A live "this chunk
  // has been running for Xm Ys" clock is honest (it only ever counts real
  // elapsed time, never a fabricated percentage or duration) and visibly
  // alive (ticks every second via the same clock the ETA above already
  // uses). Chunk-scoped, not pass-scoped like detSubtreeWindowKey above --
  // resets at every chunk boundary, not just every pass boundary --
  // reusing the SAME reload-safe hook for the same reason detSubtreeWindowStartedAt does.
  const detSubtreeChunkKey =
    detSubtreeWindowKey && detSubtreeChunk ? `${detSubtreeWindowKey}:chunk${detSubtreeChunk.chunkIndex}` : undefined;
  const detSubtreeChunkStorageKey = detSubtreeChunkKey && jobId ? `progress-window:${jobId}:${detSubtreeChunkKey}` : undefined;
  const detSubtreeChunkStartedAt = useWindowStartedAt(detSubtreeChunkKey, tickingNow, detSubtreeChunkStorageKey);
  const detSubtreeChunkElapsedMs = detSubtreeChunkKey ? tickingNow - detSubtreeChunkStartedAt : undefined;
  // Companion to the window-start recovery above: even with the TRUE
  // window-start timestamp recovered, a tab that starts observing an
  // ALREADY-in-flight chunk (confirmed live: a frontend redeploy mid-run
  // meant the fixed bundle's first render of a window was mid-chunk, even
  // though sessionStorage correctly recovered the window's real start
  // time) would still divide real elapsed time by the FULL completedUnits
  // value, including work that finished before this tab ever started
  // watching -- producing a briefly, confidently wrong small ETA. See
  // useWindowBaselineUnits's own comment for the full story.
  const detSubtreeBaselineUnits = useWindowBaselineUnits(
    detSubtreeWindowKey,
    completedUnits,
    detSubtreeStorageKey ? `${detSubtreeStorageKey}:baseline` : undefined,
  );
  // Real calculated ETA -- NOT a hardcoded guess: derives a rate (ms per
  // "unit" of work, the same completedUnits basis the progress bar itself
  // uses) from THIS job's own actual elapsed time so far, then projects it
  // across the remaining units. Needs at least ~1 real completed unit and
  // 15s of real elapsed time before trusting the rate at all -- one lone
  // block finishing after 2s would otherwise extrapolate a wildly wrong
  // "seconds left" estimate off essentially no data. None at all during a
  // tail phase (see isTailPhase above) -- honest silence beats a fake number.
  let etaText: string | null = null;
  if (mode === 'survey' && latest && completedUnits !== undefined && progressTotal) {
    // An unparseable startedAt (new Date(...).getTime() -> NaN) already
    // fell through to the >= 15_000 check below evaluating false, so this
    // never crashed/rendered a literal NaN -- but it relied on that
    // NaN-comparison coincidence rather than an explicit check, and only
    // matters on the non-deterministic_subtree branch (which doesn't read
    // startedAt at all). Number.isFinite here makes the guard intentional.
    const elapsedMs =
      detSubtreeWindowKey !== undefined
        ? tickingNow - detSubtreeWindowStartedAt
        : tickingNow - new Date(startedAt).getTime();
    // deterministic_subtree only trusts progress THIS tab personally
    // witnessed accumulate since it started observing the current window
    // -- every other phase's rate is unchanged (witnessedUnits ===
    // completedUnits there, same as before).
    const witnessedUnits =
      detSubtreeWindowKey !== undefined
        ? completedUnits - (detSubtreeBaselineUnits ?? completedUnits)
        : completedUnits;
    if (witnessedUnits >= 1 && elapsedMs >= 15_000 && Number.isFinite(elapsedMs)) {
      const msPerUnit = elapsedMs / witnessedUnits;
      const remainingUnits = Math.max(0, progressTotal - completedUnits);
      etaText = `~${formatDuration(msPerUnit * remainingUnits)} left`;
    } else {
      etaText = 'Estimating time left…';
    }
  } else if (mode === 'survey' && isTailPhase) {
    etaText = 'Finishing up…';
  }
  // Only meaningful once section-level analysis has actually started --
  // Whether THIS specific step's own message is grounded in the knowledge
  // base -- shown explicitly (not just implied by an empty citation list)
  // so "is the model using my KB data" has a definite answer instead of a
  // silent absence. Parse-stage phases, and the dedup-check/writing phases
  // (no KB retrieval concept at all -- these check ADO/Chroma, not the KB),
  // have no grounding concept at all.
  const showKbGroundingNote =
    !!latest &&
    latest.phase !== 'describe_figure' &&
    latest.phase !== 'parse_done' &&
    latest.phase !== 'preparing_analysis' && // KB retrieval hasn't run yet AT this exact event -- nothing to report
    latest.phase !== 'dedup_check' &&
    latest.phase !== 'writing';
  // CR-10 ("Wizard UX Options" decision sheet) -- both phases already get
  // their own dedicated, correctly-labeled single bar from RunDetail below
  // (the dedup_check branch's "Checking N of M proposed items" bar, and
  // WriteSubStepper's own bar); the generic metrics panel has no case for
  // either (its label falls through to the wrong word "blocks"), so
  // rendering it too drew a second bar at the identical percentage.
  const ownsPhaseReadout = latest?.phase === 'dedup_check' || latest?.phase === 'writing';

  // DESIGN.md §11.3 -- "the phase headline in plain language... never
  // dedup_check". stage==='writing' is checked ahead of PHASE_SUBLABEL
  // because it's real backend state (JobStage), not narration-derived --
  // it stays accurate through the brief window before the first
  // writing-phase narration lands, the same gap the old stage-based chip
  // label covered.
  const headline = stage === 'writing' ? 'Writing to Azure DevOps' : latest ? PHASE_SUBLABEL[latest.phase] : 'Running';

  return (
    <div className='rounded-md border border-hairline bg-surface shadow-card'>
      {/* DESIGN.md §11.3 -- "the loud element": live pulse dot, the phase
          headline in text-title, one sentence of what that phase is doing
          (the same real, backend-generated narration text the old Activity
          Log rendered -- reused here as a single truncated line, not
          invented), and the percentage pinned right. Replaces the old
          "Running"/"Writing to ADO" chip -- that label duplicated exactly
          what this headline now says, at lower information content. */}
      <div className='flex items-center gap-3 border-b border-hairline px-4 py-3'>
        <span className='relative flex h-2.5 w-2.5 flex-none'>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-live/70' />
          <span className='relative inline-flex h-2.5 w-2.5 rounded-full bg-live' />
        </span>
        <div className='min-w-0 flex-1'>
          <p className='text-title'>{headline}</p>
          {latest?.message && <p className='truncate text-xs text-ink-3' title={latest.message}>{latest.message}</p>}
        </div>
        {clampedProgress !== undefined && (
          <span className='flex-none font-mono text-metric tabular-nums text-ink-1'>{Math.round(clampedProgress)}%</span>
        )}
        <InfoTip content='BASELINE finishes in seconds. SURVEY reads the whole document, merges near-duplicates, infers missing parents, and scores each requirement -- time scales with document size, figures most of all.' />
      </div>

      {/* DESIGN.md §11.3 -- "one meta line replaces the pill row": elapsed,
          model, and the freshness stamp used to each be their own
          same-rank chip fighting the headline above for attention. The
          freshness stamp stays load-bearing (how a reviewer tells "still
          working" from "connection dropped"), just demoted to this quiet
          row. */}
      <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-hairline px-4 py-2 text-meta'>
        <span className='text-ink-3'>elapsed</span>
        <span className='font-mono text-ink-2 tabular-nums'>
          <ElapsedTimer startedAt={startedAt} />
        </span>
        {latest?.model && (
          <>
            <span className='text-ink-3'>·</span>
            <span className='text-ink-3'>model</span>
            <span className='font-mono text-ink-2'>{latest.model}</span>
          </>
        )}
        {narrations && narrations.length > 0 && (
          <>
            <span className='text-ink-3'>·</span>
            <span className='text-ink-3' title='Time since the last progress update from the server'>
              updated {secondsSinceUpdate}s ago
            </span>
          </>
        )}
        {etaText && (
          <>
            <span className='text-ink-3'>·</span>
            {/* Real gap fixed here (found in the "Wizard UX Options" decision
                sheet, CR-4/5 Option B -- "solid type is measured, outlined
                type is projected"): elapsed/model/updated-Ns-ago are all
                real, measured facts; this ETA is the one genuinely
                projected number in the row, and rendering it in the exact
                same plain text let it read as equally certain. A dashed
                outline (this repo's existing ghost/hatched-when-unset
                visual language for "not a settled fact") is the
                typographic separation the sheet's own verdict argues for --
                cheap, and it doesn't require fabricating a second data
                point the way a projected progress-bar segment would. */}
            <span
              className='rounded-full border border-dashed border-hairline-strong px-1.5 py-0.5 font-mono text-ink-3'
              title="Calculated from this job's own elapsed time and progress so far -- not a fixed estimate."
            >
              {etaText}
            </span>
          </>
        )}
      </div>

      <div className='p-5'>
        {/* Real bug fixed here (found in the "Wizard UX Options" decision
            sheet, CR-10 -- confirmed still live): dedup_check and writing
            both reuse blocksDone/blocksTotal to mean something this panel
            has no case for ("blocks" is wrong; it means proposed items
            checked, or items written), AND RunDetail below already renders
            its own dedicated, correctly-labeled single bar for both phases.
            Rendering this generic panel too drew a SECOND bar at the
            identical percentage right above the first -- "not redundancy in
            the display, a claim the data does not support" (the sheet's own
            words). Suppressed for exactly the two phases that already own
            their own readout; every other phase (including the ones with no
            RunDetail bar at all, e.g. describe_figure) is unaffected. */}
        {!ownsPhaseReadout && (
        /* One grouped "current status" panel -- previously these facts
            (stat chips, KB grounding, progress bar, its own label) were five
            separate loosely-stacked elements with only a couple pixels of
            margin between them, reading as sparse and unfinished on a wide
            card. Bordered/tinted as one coherent unit instead. */
        <div className='flex flex-col gap-2.5 rounded-md border border-hairline-strong bg-surface-alt p-3.5'>
          {(latest || showKbGroundingNote) && (
            // One shared wrapping row -- previously the KB-grounding note
            // was a second flex container below the stat chips, so it
            // always dropped to its own line even with plenty of width
            // left on the chips' row (confirmed live). Merged so the
            // browser wraps everything together based on real available
            // width, not a hardcoded break between the two groups.
            <div className='flex flex-wrap items-center gap-2'>
              {latest?.blocksTotal != null && latest.blocksTotal > 0 && (
                <Chip
                  bg='var(--color-surface)'
                  color='var(--color-ink-2)'
                  className='border border-hairline-strong font-mono text-meta font-normal tabular-nums'
                >
                  {/* blocksTotal means "requirement nodes" during scoring,
                      "document blocks" everywhere else -- label reflects
                      which one this event actually is. */}
                  {latest.blocksDone} / {latest.blocksTotal} {isScoringPhase ? 'requirements' : 'blocks'}
                </Chip>
              )}
              {isScoringPhase && latest?.chunkIndex != null && latest.chunkCount != null && (
                <Chip
                  bg='var(--color-surface)'
                  color='var(--color-ink-2)'
                  className='border border-hairline-strong font-mono text-meta font-normal tabular-nums'
                >
                  batch {latest.chunkIndex + 1} of {latest.chunkCount}
                </Chip>
              )}
              {latest?.draftCount != null && (
                <Chip
                  bg='var(--color-surface)'
                  color='var(--color-ink-2)'
                  className='border border-hairline-strong text-meta font-normal tabular-nums'
                >
                  {latest.draftCount} drafted
                </Chip>
              )}
              {latest?.issuesFound != null && (
                <Chip
                  bg={latest.issuesFound > 0 ? 'var(--color-warning-soft)' : 'var(--color-surface)'}
                  color={latest.issuesFound > 0 ? 'var(--color-warning)' : 'var(--color-ink-2)'}
                  className={cn(
                    'border text-meta font-normal tabular-nums',
                    latest.issuesFound > 0 ? 'border-warning-border' : 'border-hairline-strong',
                  )}
                >
                  {latest.issuesFound} issue{latest.issuesFound === 1 ? '' : 's'} flagged
                </Chip>
              )}
              {showKbGroundingNote &&
                (latest!.kbGrounded && latest!.kbCitations.length > 0 ? (
                  <>
                    <span className='text-xs text-ink-3'>Grounded against:</span>
                    {latest!.kbCitations.map((citation) => (
                      <Chip
                        key={citation.sourceFile}
                        bg='var(--color-surface)'
                        color='var(--color-ink-2)'
                        className='border border-hairline-strong font-mono text-meta font-normal tabular-nums'
                      >
                        {citation.sourceFile} · {Math.round(citation.similarity * 100)}%
                      </Chip>
                    ))}
                  </>
                ) : (
                  <Chip
                    bg='var(--color-surface)'
                    color='var(--color-ink-3)'
                    className='w-fit border border-hairline-strong text-meta font-normal'
                  >
                    Not grounded against your knowledge base for this step
                  </Chip>
                ))}
            </div>
          )}
          <div>
            <div className='mb-1 text-xs text-ink-3'>
              {/* Must NEVER render blank -- a genuinely empty line here
                  (the previous behavior when neither branch matched) read
                  as "stuck," indistinguishable from a frozen page. Every
                  branch below is real, honest text -- never a fabricated
                  percentage. */}
              {clampedProgress !== undefined
                ? `~${Math.round(clampedProgress)}% of this section (est.)`
                : isTailPhase || isPreparingAnalysis
                  ? 'A single whole-document pass -- no fixed step count to measure against.'
                  : 'Working — no progress estimate for this step yet.'}
            </div>
            <ProgressBar value={clampedProgress} />
          </div>
        </div>
        )}

        {detSubtreeChunk && (
          <div className='mt-2.5 flex flex-col gap-2.5 rounded-md border border-hairline-strong bg-surface-alt p-3.5'>
            <div className='flex items-center gap-2.5'>
              <span className='font-mono text-meta font-semibold uppercase tracking-wide text-ink-3'>Chunk</span>
              <div className='flex flex-1 gap-1.5'>
                {Array.from({ length: detSubtreeChunk.chunkCount }, (_, index) => {
                  const isDone = index < detSubtreeChunk.chunkIndex - 1;
                  const isActive = index === detSubtreeChunk.chunkIndex - 1;
                  return (
                    <div key={index} className='h-2.5 flex-1 overflow-hidden rounded-full bg-canvas'>
                      {isActive ? (
                        <div
                          className='h-full rounded-full bg-accent'
                          style={{ width: '34%', animation: 'indeterminate-progress var(--duration-ambient) var(--ease-in-out) infinite' }}
                        />
                      ) : (
                        <div className={cn('h-full rounded-full', isDone ? 'bg-ok' : 'bg-hairline')} />
                      )}
                    </div>
                  );
                })}
              </div>
              <span className='font-mono text-meta text-ink-3 tabular-nums'>
                {detSubtreeChunk.chunkIndex} / {detSubtreeChunk.chunkCount}
              </span>
            </div>
            <p className='text-xs text-ink-2'>
              {detSubtreeChunk.passLabel === 'enhancing titles/tags' ? 'Enhancing titles and tags for ' : 'Drafting requirement text for '}
              {detSubtreeChunk.nodeCount != null
                ? `${detSubtreeChunk.nodeCount} heading${detSubtreeChunk.nodeCount === 1 ? '' : 's'}`
                : 'this chunk'}
              {' in one model call'}
              {/* A real, ticking "so far" -- not a fabricated duration or
                  percentage -- since this is the only genuinely alive
                  signal available while the chunk itself has no
                  checkpoint of its own. */}
              {detSubtreeChunkElapsedMs !== undefined ? ` — ${formatDuration(detSubtreeChunkElapsedMs)} so far.` : '.'}
            </p>
          </div>
        )}

        <p className='mt-3 text-xs text-ink-3'>
          You can close this page and come back — the run keeps going server-side.
        </p>
        <RunDetail
          latest={latest}
          narrations={narrations ?? []}
          activeSectionProgress={clampedProgress}
          completedSectionIndices={completedSectionIndices}
        />
        {/* DESIGN.md §11.3's own audit note: the raw scrolling activity log
            this used to render here is explicitly superseded -- "do not
            build it." SectionStepList (rendered by RunDetail above) answers
            "what is left to do," which the log never did; the header's own
            one-sentence narration line above covers "what, right now." */}
      </div>
    </div>
  );
}

// Phase dispatch replacing the old single `branchCount > 0` guard around
// SectionStepList (DESIGN.md Track B, phase B6). That guard was the actual
// structural cause of the "bare spinner, no detail" complaint: dedup_check
// and writing both always carry branchCount 0 (job-events.publisher.ts
// hardcodes it), so the whole detail area used to render NOTHING for
// either phase, for however long they took. Every branch here must yield
// real, honest detail -- never fake progress, never a blank return where a
// phase's real state has nothing to show (the null fallback below is only
// for "no narration has arrived yet at all", not for a known phase).
function RunDetail({
  latest,
  narrations,
  activeSectionProgress,
  completedSectionIndices,
}: {
  latest: NarrationEvent | null;
  narrations: NarrationEvent[];
  activeSectionProgress?: number;
  completedSectionIndices?: number[];
}): React.ReactElement | null {
  if (!latest) return null;
  if (latest.branchCount > 0) {
    return (
      <SectionStepList
        latest={latest}
        narrations={narrations}
        activeSectionProgress={activeSectionProgress}
        completedSectionIndices={completedSectionIndices}
      />
    );
  }
  if (latest.phase === 'describe_figure') {
    return (
      <div className='mt-3 border-t border-hairline pt-3'>
        <p className='text-sm text-ink-2'>
          Describing embedded figures via the vision model
          {latest.figureIndex != null && ` — figure ${latest.figureIndex} so far`}.
        </p>
      </div>
    );
  }
  if (latest.phase === 'parse_done') {
    if (latest.blockCount == null) return null;
    return (
      <div className='mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3'>
        <Chip bg='var(--color-surface)' color='var(--color-ink-2)' className='border border-hairline-strong font-mono text-meta font-normal tabular-nums'>
          {latest.blockCount} blocks
        </Chip>
        <Chip bg='var(--color-surface)' color='var(--color-ink-2)' className='border border-hairline-strong font-mono text-meta font-normal tabular-nums'>
          {latest.tableCount ?? 0} tables
        </Chip>
        <Chip bg='var(--color-surface)' color='var(--color-ink-2)' className='border border-hairline-strong font-mono text-meta font-normal tabular-nums'>
          {latest.figureCount ?? 0} figures
        </Chip>
      </div>
    );
  }
  if (latest.phase === 'dedup_check') {
    const determinate = latest.blocksTotal > 0 ? (100 * latest.blocksDone) / latest.blocksTotal : undefined;
    return (
      <div className='mt-3 flex flex-col gap-1.5 border-t border-hairline pt-3'>
        <p className='font-mono text-sm text-ink-2 tabular-nums'>
          Checking {latest.blocksDone} of {latest.blocksTotal} proposed item{latest.blocksTotal === 1 ? '' : 's'} against existing work items.
        </p>
        <ProgressBar value={determinate} />
      </div>
    );
  }
  if (latest.phase === 'writing') {
    return <WriteSubStepper latest={latest} />;
  }
  // Whole-document tail phases (score_requirements(_done)/detect_conflicts/
  // regroup_roots/infer_trace_links) normally carry a real branchCount and
  // hit the SectionStepList branch above -- this only fires if one somehow
  // doesn't. The metrics box above already renders honest "single
  // whole-document pass" text for that case (see isTailPhase), so there is
  // nothing further this panel needs to add.
  return null;
}

const WRITE_SUBPHASES: { key: NonNullable<NarrationEvent['writeSubPhase']>; label: string }[] = [
  { key: 'discover_types', label: 'Resolve types' },
  { key: 'create', label: 'Create items' },
  { key: 'link_parents', label: 'Link parents' },
  { key: 'trace_links', label: 'Trace links' },
];

// The write phase's own 4-dot sub-stepper -- writeSubPhase is real backend
// state (jobs.service.ts's confirm()), not narration text alone, so this
// renders it as a stepper rather than leaving it buried in `message`.
function WriteSubStepper({ latest }: { latest: NarrationEvent }): React.ReactElement {
  const activeIndex = Math.max(0, WRITE_SUBPHASES.findIndex((s) => s.key === latest.writeSubPhase));
  const determinate = latest.blocksTotal > 0 ? (100 * latest.blocksDone) / latest.blocksTotal : undefined;
  return (
    <div className='mt-3 flex flex-col gap-2 border-t border-hairline pt-3'>
      <Stepper steps={WRITE_SUBPHASES.map((s) => s.label)} activeIndex={activeIndex} activeSpinner />
      {latest.blocksTotal > 0 && (
        <>
          <p className='font-mono text-sm text-ink-2 tabular-nums'>
            {latest.blocksDone} of {latest.blocksTotal} written
          </p>
          <ProgressBar value={determinate} />
        </>
      )}
    </div>
  );
}

// Replaces a raw scrolling log of every narration message (which read as
// noise -- repeated phrasing, no sense of overall position) with a step
// list: one row per document section, plus a final "Resolving trace links"
// step. Each row is done / active / pending -- the same shape a person
// reads at a glance in a CI pipeline view, matched to what THIS pipeline
// actually does per section (infer hierarchy -> generate requirements ->
// score quality) rather than a generic percentage.
function SectionStepList({
  latest,
  narrations,
  activeSectionProgress,
  completedSectionIndices,
}: {
  latest: NarrationEvent;
  narrations: NarrationEvent[];
  // The SAME estimate driving the top-level bar (see ProgressBanner's own
  // completedUnits calc) -- reused here so the CURRENTLY active row shows
  // its own real progress inline, not just a spinner with no sense of how
  // far along it actually is.
  activeSectionProgress?: number;
  // Branch indices with a durable, uncapped section_complete record (see
  // JobDetail's sectionResultsByIndex) -- union'd into completedSections
  // below. See that Set's own comment for why.
  completedSectionIndices?: number[];
}): React.ReactElement {
  const sections = Array.from({ length: latest.branchCount }, (_, i) => i);
  // §2c: quality scoring moved to whole-document scope (one pass AFTER
  // every section's own analysis, not per-section) -- its narration events
  // carry branchIndex=null, which previously left `i < (latest.branchIndex
  // ?? -1)` false for EVERY section during scoring, so the entire step list
  // sat on empty circles for the whole scoring pass even though every
  // section had, in fact, already finished. `scoringActive` makes this an
  // explicit whole-document phase (its own step row below, mirroring
  // "Resolving trace links") instead of silently falling through the
  // per-section check.
  const scoringActive = latest.phase === 'score_requirements' || latest.phase === 'score_requirements_done';
  const conflictsActive = latest.phase === 'detect_conflicts';
  const regroupActive = latest.phase === 'regroup_roots';
  const traceLinksActive = latest.phase === 'infer_trace_links';
  const allSectionsDone = scoringActive || conflictsActive || regroupActive || traceLinksActive;

  // Which sections have GENUINELY finished, tracked from the events that say
  // so rather than inferred from `latest.branchIndex`.
  //
  // The bug this replaces: SURVEY generation runs three stages, and stage 1
  // (build_skeleton) sweeps EVERY branch before stage 3 (analyze_section /
  // section_complete) starts for ANY of them. Both stages count
  // branchIndex 0..N-1 independently, so `i < (latest.branchIndex ?? -1)`
  // climbed to N-1 during stage 1 and then RESET to 0 the moment stage 3
  // began: every section except the first visibly reverted from a checkmark
  // to a pending circle, and the "N steps left" chip jumped backward, for
  // the whole (longest) stage of the run.
  //
  // section_complete is the only event that means "this section is done".
  // It fires exactly once per branch, only in stage 3, and never un-fires --
  // so a set of the branch indices that have emitted it is monotonic across
  // the whole pipeline by construction, which no `latest`-derived inference
  // can be.
  //
  // This also subsumes -- and is why map_scope is deliberately NOT part of
  // `allSectionsDone` above -- the narrower fix that folded `map_scope` in
  // to stop stage-1 checkmarks reverting during the mapping window. Under
  // this scheme no section is ever checked before it genuinely completes, so
  // there is nothing for map_scope to preserve; keeping it would instead
  // flip every row to a checkmark during mapping and then revert them all
  // the instant stage 3 fired -- the same backward step, just one stage
  // boundary later. map_scope remains a tail phase for the top-level bar
  // (see isTailPhase above), which is a separate concern.
  //
  // `narrations` alone is capped (JobDetail keeps the last 50 live events,
  // merged with the durable history fetch), so on a document with enough
  // branches the earliest section_complete events could age out of it while
  // the job is still running and their rows would revert. completedSectionIndices
  // (JobDetail's uncapped sectionResultsByIndex, keyed the same way) covers
  // exactly that gap -- union both rather than relying on either alone.
  // labelsByIndex below still lives with the cap; a stale/missing section
  // label on an old row is cosmetic, not a completion regression.
  // Memoized: ProgressBanner (this component's parent) re-renders every
  // second off its own ticking clock, which previously rebuilt this Set
  // (and labelsByIndex below) from scratch on every single tick even
  // though `narrations`/`completedSectionIndices` themselves usually
  // haven't changed between ticks.
  const completedSections = useMemo(
    () =>
      new Set([
        ...(completedSectionIndices ?? []),
        ...narrations
          .filter((event) => event.phase === 'section_complete' && event.branchIndex !== null)
          .map((event) => event.branchIndex as number),
      ]),
    [completedSectionIndices, narrations],
  );

  // Accumulated from EVERY narration event seen so far, not just the
  // latest -- without this, once a section finishes and a later section's
  // event becomes `latest`, that earlier section's real name would be
  // lost, and a failed job's step list could only ever show the CURRENT
  // section's name, not which named sections it already got through.
  const labelsByIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const event of narrations) {
      if (event.branchIndex !== null && event.sectionLabel) {
        map.set(event.branchIndex, event.sectionLabel);
      }
    }
    return map;
  }, [narrations]);

  // DESIGN.md §11.3.1 -- "This is exactly the paint
  // .hoverable-row[aria-selected='true'] produces (§6), and when §6 lands
  // this row must adopt the class rather than keep spelling it out." §6
  // landed this session; migrated from the hand-rolled
  // border-l-2 border-accent bg-surface-alt to the real shared paint
  // (bg-accent-soft + the 2px rail), driven by a real aria-selected
  // attribute at each call site below, not a class name alone.
  // border-t-0: these rows sit in a plain flex-col gap-1 list with no
  // dividers today; .hoverable-row's own row-separator border isn't part
  // of this row's existing design and stays off. pointer-events-none:
  // confirmed live -- without it, a mouse merely resting over one of these
  // passively-updating rows (no click handler, ever) triggers
  // .hoverable-row's real :hover fill+rail, exactly the false affordance
  // §11.3.1's own note warns against ("these rows are not interactive and
  // must not gain a hover response").
  const rowClass = 'hoverable-row border-t-0 pointer-events-none flex items-center gap-2 rounded-sm px-2 py-1.5 -mx-2';

  // "What's left" -- a real countdown of remaining steps across the WHOLE
  // pipeline (sections + the two whole-document passes), not just this
  // section list in isolation -- directly answers "what's left to do".
  // Same monotonic signal the per-row checkmarks use (see completedSections
  // above) -- `latest.branchIndex` resets to 0 when stage 3 starts, which
  // made this counter jump backward by up to N steps mid-run.
  const sectionsDone = allSectionsDone ? latest.branchCount : completedSections.size;
  const totalSteps = latest.branchCount + 4; // + scoring + detect-conflicts + regroup-roots + trace links
  // map_scope is deliberately NOT a 5th counted step here -- it runs BEFORE
  // scoring, so its own "done-ness" is already folded into sectionsDone
  // above (allSectionsDone) exactly the way scoringActive's own moment
  // already falls through to 0 below (0 of the 4 LATER named steps done
  // yet). Matches wholeDocStepsDone's existing convention: only counts
  // steps that come AFTER the currently active one.
  const wholeDocStepsDone = regroupActive
    ? 2
    : conflictsActive
      ? 1
      : traceLinksActive
        ? 3
        : 0;
  const stepsDone = sectionsDone + wholeDocStepsDone;
  const stepsLeft = Math.max(0, totalSteps - stepsDone);

  return (
    <div className='mt-3 flex flex-col gap-1 border-t border-hairline pt-3'>
      <p className='flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-ink-3'>
        Sections
        <Chip
          bg='var(--color-surface-alt)'
          color='var(--color-ink-2)'
          className='border border-hairline-strong font-mono text-micro font-normal normal-case tabular-nums'
        >
          {latest.branchCount}
        </Chip>
        <InfoTip content="A 'section' here is a processing chunk, not necessarily the document's own chapter count: it starts as the document's real top-level headings, but a single very large heading section gets further split into more, smaller chunks so each one stays a manageable size for the model. The count can therefore be higher than what a human would call the document's table of contents." />
        {stepsLeft > 0 && (
          <Chip
            bg='var(--color-surface)'
            color='var(--color-ink-3)'
            className='ml-auto border border-hairline-strong font-mono text-micro font-normal normal-case tabular-nums'
          >
            {stepsLeft} step{stepsLeft === 1 ? '' : 's'} left
          </Chip>
        )}
      </p>
      {sections.map((i) => {
        const isDone = allSectionsDone || completedSections.has(i);
        // `!isDone` guard: section_complete for branch i makes i both the
        // latest branchIndex AND genuinely complete -- without it the row
        // would render a checkmark while still carrying the active row's
        // selection paint and in-progress mini-bar.
        const isActive = !isDone && i === latest.branchIndex;
        const label = labelsByIndex.get(i);
        return (
          <div
            key={i}
            className={rowClass}
            aria-selected={isActive}
          >
            {isDone ? (
              <Check
                data-testid='section-check-icon'
                className='h-4 w-4 flex-none text-ok'
              />
            ) : isActive ? (
              <Spinner className='text-live' />
            ) : (
              <Circle className='h-4 w-4 flex-none text-ink-3/50' />
            )}
            <div className='min-w-0 flex-1'>
              <p
                className={cn(
                  'text-sm',
                  isActive ? 'font-semibold text-ink-1' : isDone ? 'text-ink-2' : 'text-ink-3',
                )}
              >
                Section {i + 1} of {latest.branchCount}
                {label && `: ${label}`}
                {isActive && ` — ${PHASE_SUBLABEL[latest.phase]}`}
              </p>
              {isActive && <MiniProgress value={activeSectionProgress} />}
            </div>
          </div>
        );
      })}
      {/* These 4 rows are whole-document passes (once per job, not once per
          section) -- they used to sit under the "Sections" header above with
          no label of their own, reading as if they were more sections. Real
          user-reported confusion: "what is the actual difference between the
          stepper and the section todos... the section [count] is weird" when
          most of the rows under "Sections" weren't sections at all. */}
      <p className='mt-2 text-meta font-semibold uppercase tracking-wide text-ink-3'>Scoring &amp; linking</p>
      <div className={rowClass} aria-selected={scoringActive}>
        {conflictsActive || regroupActive || traceLinksActive ? (
          <Check
            data-testid='scoring-check-icon'
            className='h-4 w-4 flex-none text-ok'
          />
        ) : scoringActive ? (
          <Spinner className='text-live' />
        ) : (
          <Circle className='h-4 w-4 flex-none text-ink-3/50' />
        )}
        <div className='min-w-0 flex-1'>
          <p
            className={cn(
              'text-sm',
              scoringActive ? 'font-semibold text-ink-1' : 'text-ink-3',
            )}
          >
            Scoring requirement quality
            {scoringActive && latest.draftCount != null && ` — scoring ${latest.draftCount} requirement(s)`}
          </p>
          {scoringActive && <MiniProgress value={activeSectionProgress} />}
        </div>
      </div>
      <div className={rowClass} aria-selected={conflictsActive}>
        {regroupActive || traceLinksActive ? (
          <Check
            data-testid='conflicts-check-icon'
            className='h-4 w-4 flex-none text-ok'
          />
        ) : conflictsActive ? (
          <Spinner className='text-live' />
        ) : (
          <Circle className='h-4 w-4 flex-none text-ink-3/50' />
        )}
        <p className={cn('text-sm', conflictsActive ? 'font-semibold text-ink-1' : 'text-ink-3')}>
          Checking for conflicting near-duplicates
        </p>
      </div>
      <div className={rowClass} aria-selected={regroupActive}>
        {traceLinksActive ? (
          <Check
            data-testid='regroup-check-icon'
            className='h-4 w-4 flex-none text-ok'
          />
        ) : regroupActive ? (
          <Spinner className='text-live' />
        ) : (
          <Circle className='h-4 w-4 flex-none text-ink-3/50' />
        )}
        <p className={cn('text-sm', regroupActive ? 'font-semibold text-ink-1' : 'text-ink-3')}>
          Grouping disconnected sections by topic
        </p>
      </div>
      <div className={rowClass} aria-selected={traceLinksActive}>
        {traceLinksActive ? (
          <Spinner className='text-live' />
        ) : (
          <Circle className='h-4 w-4 flex-none text-ink-3/50' />
        )}
        <p className={cn('text-sm', traceLinksActive ? 'font-semibold text-ink-1' : 'text-ink-3')}>
          Resolving trace links
        </p>
      </div>
    </div>
  );
}

// A slim inline progress bar for whichever step is currently active -- the
// same estimate driving the top-level bar, repeated here so the step
// itself shows real progress instead of just a spinner with no sense of
// how far along it is.
function MiniProgress({ value }: { value?: number }): React.ReactElement | null {
  if (value === undefined) return null;
  return (
    <div className='mt-1 h-1 w-full max-w-52 overflow-hidden rounded-full bg-canvas'>
      <span
        className='block h-full rounded-full bg-gradient-to-r from-accent-active to-accent'
        style={{
          width: `${Math.min(Math.max(value, 0), 100)}%`,
          transition: 'width 900ms var(--ease-in-out)',
        }}
      />
    </div>
  );
}
