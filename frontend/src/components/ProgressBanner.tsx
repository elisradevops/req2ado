import { Check, Circle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useNow } from '../hooks/useNow';
import { useSecondsSinceLastUpdate } from '../hooks/useSecondsSinceLastUpdate';
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
  analyze_section: 'Analyzing and synthesizing requirements',
  infer_hierarchy: 'Analyzing structure',
  generate_requirements: 'Generating requirements',
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
  analyze_section: 0,
  infer_hierarchy: 0,
  generate_requirements: 0.4,
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
}: {
  stage: JobStage;
  startedAt: string;
  mode: 'baseline' | 'survey';
  // SURVEY-only, richer per-step narration (see NarrationEvent) -- undefined/
  // empty falls back to the coarse stage-only display below, matching
  // pre-narration behavior exactly (BASELINE never produces these at all).
  narrations?: NarrationEvent[];
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
  const isTailPhase =
    latest?.phase === 'detect_conflicts' ||
    latest?.phase === 'regroup_roots' ||
    latest?.phase === 'infer_trace_links';
  // Distinct from isTailPhase -- this phase runs at the very START of
  // analysis (before branchCount is even known), so "Finishing up…" would
  // be actively misleading here. Only shares isTailPhase's OTHER effect:
  // the metrics box showing real "no fixed step count" text instead of
  // rendering blank (see the "cannot be blank" fix below).
  const isPreparingAnalysis = latest?.phase === 'preparing_analysis';
  let completedUnits: number | undefined;
  if (latest && isScoringPhase && latest.blocksTotal > 0) {
    completedUnits = latest.blocksDone;
  } else if (latest && latest.blocksTotal > 0 && !isTailPhase) {
    const averageSectionShare = latest.branchCount > 0 ? latest.blocksTotal / latest.branchCount : 0;
    const withinSectionCredit = averageSectionShare * PHASE_START_WEIGHT[latest.phase];
    completedUnits = latest.blocksDone + withinSectionCredit;
  }
  const progressValue =
    completedUnits !== undefined && latest ? (100 * completedUnits) / latest.blocksTotal : undefined;
  const clampedProgress = progressValue !== undefined ? Math.min(Math.max(progressValue, 0), 100) : undefined;
  // Single shared clock tick -- both the ETA calc below and the "last
  // update Ns ago" counter derive from this one useNow() call instead of
  // each owning its own setInterval.
  const tickingNow = useNow();
  const secondsSinceUpdate = useSecondsSinceLastUpdate(narrations?.length ?? 0, tickingNow);
  // Real calculated ETA -- NOT a hardcoded guess: derives a rate (ms per
  // "unit" of work, the same completedUnits basis the progress bar itself
  // uses) from THIS job's own actual elapsed time so far, then projects it
  // across the remaining units. Needs at least ~1 real completed unit and
  // 15s of real elapsed time before trusting the rate at all -- one lone
  // block finishing after 2s would otherwise extrapolate a wildly wrong
  // "seconds left" estimate off essentially no data. None at all during a
  // tail phase (see isTailPhase above) -- honest silence beats a fake number.
  let etaText: string | null = null;
  if (mode === 'survey' && latest && completedUnits !== undefined && latest.blocksTotal > 0) {
    const elapsedMs = tickingNow - new Date(startedAt).getTime();
    if (completedUnits >= 1 && elapsedMs >= 15_000) {
      const msPerUnit = elapsedMs / completedUnits;
      const remainingUnits = Math.max(0, latest.blocksTotal - completedUnits);
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
          {latest && (
            <div className='flex flex-wrap items-center gap-2'>
              {latest.blocksTotal > 0 && (
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
              {isScoringPhase && latest.chunkIndex != null && latest.chunkCount != null && (
                <Chip
                  bg='var(--color-surface)'
                  color='var(--color-ink-2)'
                  className='border border-hairline-strong font-mono text-meta font-normal tabular-nums'
                >
                  batch {latest.chunkIndex + 1} of {latest.chunkCount}
                </Chip>
              )}
              {latest.draftCount != null && (
                <Chip
                  bg='var(--color-surface)'
                  color='var(--color-ink-2)'
                  className='border border-hairline-strong text-meta font-normal tabular-nums'
                >
                  {latest.draftCount} drafted
                </Chip>
              )}
              {latest.issuesFound != null && (
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
            </div>
          )}
          {showKbGroundingNote &&
            (latest!.kbGrounded && latest!.kbCitations.length > 0 ? (
              <div className='flex flex-wrap items-center gap-1.5'>
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
              </div>
            ) : (
              <Chip
                bg='var(--color-surface)'
                color='var(--color-ink-3)'
                className='w-fit border border-hairline-strong text-meta font-normal'
              >
                Not grounded against your knowledge base for this step
              </Chip>
            ))}
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

        <p className='mt-3 text-xs text-ink-3'>
          You can close this page and come back — the run keeps going server-side.
        </p>
        <RunDetail latest={latest} narrations={narrations ?? []} activeSectionProgress={clampedProgress} />
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
}: {
  latest: NarrationEvent | null;
  narrations: NarrationEvent[];
  activeSectionProgress?: number;
}): React.ReactElement | null {
  if (!latest) return null;
  if (latest.branchCount > 0) {
    return <SectionStepList latest={latest} narrations={narrations} activeSectionProgress={activeSectionProgress} />;
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
}: {
  latest: NarrationEvent;
  narrations: NarrationEvent[];
  // The SAME estimate driving the top-level bar (see ProgressBanner's own
  // completedUnits calc) -- reused here so the CURRENTLY active row shows
  // its own real progress inline, not just a spinner with no sense of how
  // far along it actually is.
  activeSectionProgress?: number;
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

  // Accumulated from EVERY narration event seen so far, not just the
  // latest -- without this, once a section finishes and a later section's
  // event becomes `latest`, that earlier section's real name would be
  // lost, and a failed job's step list could only ever show the CURRENT
  // section's name, not which named sections it already got through.
  const labelsByIndex = new Map<number, string>();
  for (const event of narrations) {
    if (event.branchIndex !== null && event.sectionLabel) {
      labelsByIndex.set(event.branchIndex, event.sectionLabel);
    }
  }

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
  const sectionsDone = allSectionsDone ? latest.branchCount : Math.max(0, latest.branchIndex ?? 0);
  const totalSteps = latest.branchCount + 4; // + scoring + detect-conflicts + regroup-roots + trace links
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
        const isDone = allSectionsDone || i < (latest.branchIndex ?? -1);
        const isActive = !allSectionsDone && i === latest.branchIndex;
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
