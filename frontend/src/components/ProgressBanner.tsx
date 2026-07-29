import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useNow } from '../hooks/useNow';
import { ElapsedTimer } from './ElapsedTimer';
import { ProgressBar } from '../ui/ProgressBar';
import { Spinner } from '../ui/Spinner';
import { Chip } from '../ui/Chip';
import { InfoTip } from '../ui/Tooltip';
import { Stepper } from '../ui/Stepper';
import type { JobStage, NarrationEvent } from '../api/events';

const STAGE_LABELS: Record<JobStage, string> = {
  parse: 'Parsing document...',
  infer_hierarchy_start: 'Analyzing structure...',
  infer_hierarchy_done: 'Structure analysis complete.',
  generate_requirements_start: 'Generating requirements...',
  generate_requirements_done: 'Finalizing...',
  diff_ready: 'Diff ready.',
  failed: 'Job failed.',
  cancelled: 'Job cancelled.',
};

// Short sub-labels shown next to the currently-active section in the step
// list -- the narration message itself is more verbose (includes block
// counts), this is just "which of the section's three passes is running".
// describe_figure/parse_done have no per-section step row (see the
// SectionStepList render guard below, gated on branchCount > 0) so their
// entries here are never actually looked up -- present only so this Record
// stays exhaustive over NarrationEvent['phase'].
const PHASE_SUBLABEL: Record<NarrationEvent['phase'], string> = {
  describe_figure: 'Describing figures',
  parse_done: 'Parsing complete',
  analyze_section: 'Analyzing and synthesizing requirements',
  infer_hierarchy: 'Analyzing structure',
  generate_requirements: 'Generating requirements',
  score_requirements: 'Scoring quality',
  score_requirements_done: 'Scoring complete',
  section_complete: 'Section complete',
  infer_trace_links: 'Resolving trace links',
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
  analyze_section: 0,
  infer_hierarchy: 0,
  generate_requirements: 0.4,
  score_requirements: 0.75,
  score_requirements_done: 1,
  section_complete: 1,
  infer_trace_links: 1,
};

// The prototype's 3-column `.phasebar` overview -- gives an at-a-glance
// sense of where in the WHOLE pipeline a job is (independent of the
// per-section detail below it), rather than only ever showing one
// section's current pass. "Analysing sections" covers every real
// per-section phase; "Building the diff" starts once trace-link inference
// (the last, whole-tree step) begins.
type MacroPhase = 'reading' | 'analysing' | 'building';

const MACRO_PHASES: { key: MacroPhase; label: string }[] = [
  { key: 'reading', label: 'Reading document' },
  { key: 'analysing', label: 'Analysing sections' },
  { key: 'building', label: 'Building the diff' },
];

function macroPhaseFor(latest: NarrationEvent | null): MacroPhase {
  if (!latest) return 'reading';
  if (latest.phase === 'describe_figure' || latest.phase === 'parse_done') return 'reading';
  return latest.phase === 'infer_trace_links' ? 'building' : 'analysing';
}

// One distinct hue per macro phase -- never signal-yellow (reserved for
// "this needs your decision"), each an existing semantic token so this
// doesn't invent new colors outside the design system: info-blue for
// intake, the app's own primary navy for the heavy-lifting analysis pass,
// live-cyan for the final assembly pass (ties to the same cyan the
// "Running" chip and every active spinner in this card already use).
const MACRO_PHASE_COLORS = ['var(--color-info)', 'var(--color-navy-600)', 'var(--color-live)'];

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// A live "last update Ns ago" ticker -- distinct from a real stall-detection
// heuristic (which would need a judgment call about what counts as "too
// long" per phase, easy to get wrong and cry wolf). This is deliberately
// honest instead: it never claims something is stuck, it just answers "is
// this still moving" with a real, ticking number, so a quiet phase (e.g. a
// real vision-LLM call that itself takes a while) reads as "still working"
// rather than leaving the user to guess.
function useSecondsSinceLastUpdate(narrationCount: number, now: number): number {
  const lastUpdateAtRef = useRef<number>(Date.now());

  useEffect(() => {
    lastUpdateAtRef.current = Date.now();
    // Deliberately re-runs only when a NEW narration actually arrives
    // (count changes), not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrationCount]);

  return Math.max(0, Math.floor((now - lastUpdateAtRef.current) / 1000));
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
  const [logExpanded, setLogExpanded] = useState(false);
  const latest = narrations && narrations.length > 0 ? narrations[narrations.length - 1] : null;

  // Estimated overall progress: fully-completed sections' share of the
  // document, plus partial credit for however far the CURRENT section has
  // gotten through its own three passes. `blocksDone` alone (completed
  // sections only) freezes at the same value for a section's entire
  // multi-minute duration -- this is a genuine estimate, not an exact
  // count, since sections vary in real size and this assumes an even split.
  // The two whole-document tail phases (scoring, trace-link inference)
  // report blocksDone === blocksTotal -- every section is already finished
  // by the time either runs (see llm_leveling.py's
  // _score_all_requirements/build_survey_tree) -- so the block-based unit
  // model below has no real remaining "blocks" to measure against, even
  // though real work (and real time) is still left. Projecting a number
  // out of it here would be exactly the fabricated-guess this app's own
  // "do not guess, calculate" standard forbids -- these phases show a
  // genuinely indeterminate bar and an honest "no fixed step count for
  // this pass" message instead of a fake countdown.
  const isTailPhase =
    latest?.phase === 'score_requirements' ||
    latest?.phase === 'score_requirements_done' ||
    latest?.phase === 'infer_trace_links';
  let completedUnits: number | undefined;
  if (latest && latest.blocksTotal > 0 && !isTailPhase) {
    const averageSectionShare = latest.branchCount > 0 ? latest.blocksTotal / latest.branchCount : 0;
    const withinSectionCredit = averageSectionShare * PHASE_START_WEIGHT[latest.phase];
    completedUnits = latest.blocksDone + withinSectionCredit;
  }
  const progressValue =
    completedUnits !== undefined && latest ? (100 * completedUnits) / latest.blocksTotal : undefined;
  const clampedProgress = progressValue !== undefined ? Math.min(Math.max(progressValue, 0), 100) : undefined;
  const activeMacroPhase = macroPhaseFor(latest);
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
  // parse-stage phases (describe_figure/parse_done) carry branchCount=0
  // (no section exists yet), and infer_trace_links has no single active
  // section either way (branchIndex=null there is handled inside
  // SectionStepList itself).
  const showSectionSteps = !!latest && latest.branchCount > 0;
  // Whether THIS specific step's own message is grounded in the knowledge
  // base -- shown explicitly (not just implied by an empty citation list)
  // so "is the model using my KB data" has a definite answer instead of a
  // silent absence. Parse-stage phases have no grounding concept at all.
  const showKbGroundingNote = !!latest && latest.phase !== 'describe_figure' && latest.phase !== 'parse_done';

  return (
    <div className='rounded-md border border-hairline bg-surface shadow-card'>
      <div className='flex items-center gap-2 border-b border-hairline px-4 py-2.5'>
        <Chip
          bg='var(--color-live)'
          color='#fff'
          className='gap-1.5 py-1 pl-1.5 text-[11px] tracking-wide uppercase'
        >
          <span className='relative flex h-2 w-2 flex-none'>
            <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70' />
            <span className='relative inline-flex h-2 w-2 rounded-full bg-white' />
          </span>
          Running
        </Chip>
        <span className='ml-auto flex items-center gap-1.5'>
          {narrations && narrations.length > 0 && (
            <Chip
              bg='var(--color-surface-alt)'
              color='var(--color-ink-3)'
              className='border border-hairline-strong font-mono text-[11px] font-normal tabular-nums'
              title='Time since the last progress update from the server'
            >
              {secondsSinceUpdate}s ago
            </Chip>
          )}
          <Chip
            bg='var(--color-navy-600)'
            color='#fff'
            className='font-mono text-[11px] font-normal tabular-nums'
          >
            <ElapsedTimer startedAt={startedAt} />
          </Chip>
          {etaText && (
            <Chip
              bg='var(--color-info)'
              color='#fff'
              className='font-mono text-[11px] font-normal tabular-nums'
              title="Calculated from this job's own elapsed time and progress so far -- not a fixed estimate."
            >
              {etaText}
            </Chip>
          )}
        </span>
      </div>

      <div className='p-5'>
        <div className='mb-4'>
          <Stepper
            steps={MACRO_PHASES.map((p) => p.label)}
            activeIndex={MACRO_PHASES.findIndex((p) => p.key === activeMacroPhase)}
            activeSpinner
            colors={MACRO_PHASE_COLORS}
          />
        </div>

        {/* The one thing worth reading first on a page a user glances at for
            15-40 minutes: what the system is doing RIGHT NOW. Bumped to the
            loudest text on the card -- previously the same weight as every
            supporting chip below it, which was the real root of the "no
            visual hierarchy" complaint. */}
        <p className='mb-3 flex items-center gap-1.5 text-base leading-snug font-semibold text-ink-1'>
          {latest ? latest.message : STAGE_LABELS[stage]}
          <InfoTip content='BASELINE finishes in seconds. SURVEY reads the whole document, merges near-duplicates, infers missing parents, and scores each requirement -- typically 15-40+ minutes for a real document.' />
        </p>

        {/* One grouped "current status" panel -- previously these facts
            (stat chips, KB grounding, progress bar, its own label) were five
            separate loosely-stacked elements with only a couple pixels of
            margin between them, reading as sparse and unfinished on a wide
            card. Bordered/tinted as one coherent unit instead. */}
        <div className='flex flex-col gap-2.5 rounded-md border border-hairline-strong bg-surface-alt p-3.5'>
          {latest && (
            <div className='flex flex-wrap items-center gap-2'>
              {latest.blocksTotal > 0 && (
                <Chip
                  bg='var(--color-surface)'
                  color='var(--color-ink-2)'
                  className='border border-hairline-strong font-mono text-[11px] font-normal tabular-nums'
                >
                  {latest.blocksDone} / {latest.blocksTotal} blocks
                </Chip>
              )}
              {latest.model && (
                <Chip
                  bg='var(--color-navy-300)'
                  color='#fff'
                  className='font-mono text-[11px] font-normal'
                >
                  {latest.model}
                </Chip>
              )}
              {latest.draftCount != null && (
                <Chip
                  bg='var(--color-surface)'
                  color='var(--color-ink-2)'
                  className='border border-hairline-strong text-[11px] font-normal tabular-nums'
                >
                  {latest.draftCount} drafted
                </Chip>
              )}
              {latest.issuesFound != null && (
                <Chip
                  bg={latest.issuesFound > 0 ? '#FDF3E6' : 'var(--color-surface)'}
                  color={latest.issuesFound > 0 ? 'var(--color-warning)' : 'var(--color-ink-2)'}
                  className={cn(
                    'border text-[11px] font-normal tabular-nums',
                    latest.issuesFound > 0 ? 'border-[#EED8B4]' : 'border-hairline-strong',
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
                    className='border border-hairline-strong font-mono text-[11px] font-normal'
                    title={`similarity ${Math.round(citation.similarity * 100)}%`}
                  >
                    {citation.sourceFile}
                  </Chip>
                ))}
              </div>
            ) : (
              <Chip
                bg='var(--color-surface)'
                color='var(--color-ink-3)'
                className='w-fit border border-hairline-strong text-[11px] font-normal'
              >
                Not grounded against your knowledge base for this step
              </Chip>
            ))}
          <div>
            <div className='mb-1 text-xs text-ink-3'>
              {clampedProgress !== undefined
                ? `~${Math.round(clampedProgress)}% of this section (est.)`
                : isTailPhase && 'A single whole-document pass -- no fixed step count to measure against.'}
            </div>
            <ProgressBar value={clampedProgress} />
          </div>
        </div>

        <p className='mt-3 text-xs text-ink-3'>
          You can close this page and come back — the run keeps going server-side.
        </p>
        {showSectionSteps && (
          <SectionStepList
            latest={latest!}
            narrations={narrations ?? []}
            activeSectionProgress={clampedProgress}
          />
        )}

        {narrations && narrations.length > 0 && (
          <div className='mt-3 border-t border-hairline pt-2'>
            <button
              type='button'
              onClick={() => setLogExpanded((prev) => !prev)}
              aria-expanded={logExpanded}
              className='flex items-center gap-1.5 text-xs font-medium text-ink-3 hover:text-ink-1'
            >
              {logExpanded ? (
                <ChevronDown className='h-3.5 w-3.5' />
              ) : (
                <ChevronRight className='h-3.5 w-3.5' />
              )}
              Activity log ({narrations.length})
            </button>
            <div
              className={cn(
                'grid transition-[grid-template-rows] duration-200 ease-out',
                logExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
              )}
            >
              <div className='min-h-0 overflow-hidden'>
                <ul className='mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto pr-1'>
                  {narrations.map((event, index) => (
                    <li
                      key={index}
                      className='font-mono text-[11px] text-ink-3'
                    >
                      {event.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
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
  const traceLinksActive = latest.phase === 'infer_trace_links';
  const allSectionsDone = scoringActive || traceLinksActive;

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

  // The active row gets a tinted background + a left accent rule -- the
  // check/spinner/circle icon alone read as too quiet to find at a glance
  // in a list of otherwise-identical gray rows (the "no visual hierarchy"
  // complaint this redesign addresses).
  const rowClass = (isActive: boolean) =>
    cn(
      'flex items-center gap-2 rounded-sm px-2 py-1.5 -mx-2',
      isActive && 'border-l-2 border-navy-600 bg-surface-alt',
    );

  // "What's left" -- a real countdown of remaining steps across the WHOLE
  // pipeline (sections + the two whole-document passes), not just this
  // section list in isolation -- directly answers "what's left to do".
  const sectionsDone = allSectionsDone ? latest.branchCount : Math.max(0, latest.branchIndex ?? 0);
  const totalSteps = latest.branchCount + 2; // + scoring + trace links
  const stepsDone = sectionsDone + (traceLinksActive ? 1 : 0);
  const stepsLeft = Math.max(0, totalSteps - stepsDone);

  return (
    <div className='mt-3 flex flex-col gap-1 border-t border-hairline pt-3'>
      <p className='flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3'>
        Sections
        <Chip
          bg='var(--color-surface-alt)'
          color='var(--color-ink-2)'
          className='border border-hairline-strong font-mono text-[10.5px] font-normal normal-case tabular-nums'
        >
          {latest.branchCount}
        </Chip>
        <InfoTip content="A 'section' here is a processing chunk, not necessarily the document's own chapter count: it starts as the document's real top-level headings, but a single very large heading section gets further split into more, smaller chunks so each one stays a manageable size for the model. The count can therefore be higher than what a human would call the document's table of contents." />
        {stepsLeft > 0 && (
          <Chip
            bg='var(--color-surface)'
            color='var(--color-ink-3)'
            className='ml-auto border border-hairline-strong font-mono text-[10.5px] font-normal normal-case tabular-nums'
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
            className={rowClass(isActive)}
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
      <div className={rowClass(scoringActive)}>
        {traceLinksActive ? (
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
              scoringActive ? 'font-semibold text-ink-1' : traceLinksActive ? 'text-ink-2' : 'text-ink-3',
            )}
          >
            Scoring requirement quality
            {scoringActive && latest.draftCount != null && ` — scoring ${latest.draftCount} requirement(s)`}
          </p>
          {scoringActive && <MiniProgress value={activeSectionProgress} />}
        </div>
      </div>
      <div className={rowClass(traceLinksActive)}>
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
        className='block h-full rounded-full bg-gradient-to-r from-navy-600 to-navy-300'
        style={{
          width: `${Math.min(Math.max(value, 0), 100)}%`,
          transition: 'width 900ms var(--ease-in-out)',
        }}
      />
    </div>
  );
}
