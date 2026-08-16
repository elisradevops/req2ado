import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBanner } from './ProgressBanner';
import type { NarrationEvent } from '../api/events';

describe('ProgressBanner', () => {
  it('shows no ETA chip before any narration has arrived', () => {
    // No narration yet -- there's no real progress data to calculate a
    // rate from, so no ETA (calculated or "Estimating...") should render
    // at all, rather than a fabricated guess.
    render(<ProgressBanner stage="parse" startedAt="2026-07-09T10:00:00Z" mode="survey" />);
    expect(screen.queryByText(/left/i)).not.toBeInTheDocument();
  });

  it('shows a real calculated ETA (not a hardcoded guess) once enough progress data exists', () => {
    // startedAt is far enough in the past that elapsedMs comfortably clears
    // the 15s/1-unit trust threshold -- this must render an actual "~Xm Ys
    // left" derived from blocksDone/blocksTotal and real elapsed time, not
    // the old static "~40 min" text.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 1, branchCount: 4, blocksDone: 100, blocksTotal: 400, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText(/~.+ left/i)).toBeInTheDocument();
  });

  it('never shows a fabricated "~0s left" during the detect_conflicts/regroup_roots/trace-link tail phases', () => {
    // Confirmed real bug (screenshot): these whole-document tail phases
    // report blocksDone === blocksTotal (every section is already finished
    // by the time any of them run) -- the old calc added withinSectionCredit
    // on top of an already-full blocksDone, overshooting blocksTotal, going
    // negative, and clamping to a fake "~0s left" while the job was still
    // genuinely working. Must show "Finishing up…" and an indeterminate bar
    // instead of any fabricated number. score_requirements is deliberately
    // NOT included here anymore -- see the dedicated test below for why.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'infer_trace_links', branchIndex: null, branchCount: 4, blocksDone: 682, blocksTotal: 682, kbGrounded: true, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.queryByText(/~0s left/i)).not.toBeInTheDocument();
    expect(screen.getByText('Finishing up…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('shows real determinate progress and a batch chip during score_requirements -- unlike other tail phases, the total is known upfront', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          {
            phase: 'score_requirements', branchIndex: null, branchCount: 4, blocksDone: 150, blocksTotal: 553,
            kbGrounded: false, kbCitations: [], message: 'x', draftCount: 150, chunkIndex: 0, chunkCount: 4,
          },
        ]}
      />,
    );
    expect(screen.queryByText('Finishing up…')).not.toBeInTheDocument();
    expect(screen.getByText('150 / 553 requirements')).toBeInTheDocument();
    expect(screen.getByText('batch 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow');
  });

  it('shows the latest narration message instead of the coarse stage label when narrations are present', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'infer_hierarchy', branchIndex: 0, branchCount: 3, blocksDone: 0, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'Analyzing structure (section 1 of 3)' },
          { phase: 'generate_requirements', branchIndex: 0, branchCount: 3, blocksDone: 0, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'Generating formal requirements (section 1 of 3)' },
        ]}
      />,
    );
    expect(screen.getAllByText('Generating formal requirements (section 1 of 3)').length).toBeGreaterThan(0);
    expect(screen.queryByText(/analyzing structure\.\.\./i)).not.toBeInTheDocument();
  });

  it('renders a determinate progress bar reflecting blocksDone/blocksTotal from the latest narration', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'infer_hierarchy', branchIndex: 1, branchCount: 4, blocksDone: 20, blocksTotal: 40, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    // Exactly one progressbar element: the linear bar. The active-step
    // indicator is a plain spinner (aria-hidden), not a second
    // role=progressbar element.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('renders a step per document section, marking earlier sections done and the current one active', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'generate_requirements', branchIndex: 1, branchCount: 3, blocksDone: 10, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText('Section 1 of 3')).toBeInTheDocument();
    expect(screen.getByText(/Section 2 of 3.*Generating requirements/)).toBeInTheDocument();
    expect(screen.getByText('Section 3 of 3')).toBeInTheDocument();
    expect(screen.getByText('Resolving trace links')).toBeInTheDocument();
  });

  it('renders a real sublabel (not "undefined") for the analyze_section phase and a valid progress value', () => {
    // Regression: the backend's SURVEY redesign replaced infer_hierarchy/
    // generate_requirements with one holistic analyze_section phase --
    // PHASE_SUBLABEL/PHASE_START_WEIGHT previously had no entry for it,
    // so the active section rendered "Section 1 of 6 — undefined" and the
    // progress bar's value became NaN (confirmed live against a real job).
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 0, branchCount: 6, blocksDone: 0, blocksTotal: 679, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText(/Section 1 of 6.*Analyzing and synthesizing requirements/)).toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    // A real finite number, not NaN. Non-zero on purpose: analyze_section is
    // stage 3's OPENING event, and by then this branch's own skeleton call
    // has genuinely finished (PHASE_START_WEIGHT.analyze_section) -- which is
    // also the floor stage 1's own clamp is measured against.
    const percent = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'));
    expect(Number.isFinite(percent)).toBe(true);
    expect(percent).toBeGreaterThan(0);
  });

  it('renders a real sublabel (not "undefined") for the new build_skeleton phase and a valid progress value', () => {
    // B5: build_skeleton replaces the stale 'analyze_section' label stage 1
    // (skeleton generation) used to fire -- same regression class as the
    // analyze_section test above (PHASE_SUBLABEL/PHASE_START_WEIGHT missing
    // an entry renders "undefined" and a NaN progress value).
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'build_skeleton', branchIndex: 0, branchCount: 6, blocksDone: 0, blocksTotal: 679, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText(/Section 1 of 6.*Building document structure/)).toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  // B6: build_skeleton's blocksDone is "blocks in the branches BEFORE this
  // one", which only meant "those branches are DONE" back when a branch was
  // one LLM call. Post-Part-B, stage 1 sweeps every branch's skeleton before
  // any content exists, so taking blocksDone at face value ran the bar to
  // ~(N-1)/N during stage 1 and then dropped it back to ~1/N on stage 3's
  // first section_complete -- a visibly backward bar.
  //
  // Parameterized over branch count deliberately. A plain
  // SKELETON_STAGE_SHARE discount happens to hold at N=4 and FAILS for every
  // larger document (N=6: 25% -> 16.7%; N=10: 27% -> 10%), so testing the
  // single N=4 case would have pinned exactly the boundary where the bug
  // hides. N=6 is not hypothetical -- the build_skeleton sublabel test above
  // already uses branchCount 6.
  const BLOCKS_PER_BRANCH = 100;
  describe.each([4, 6, 10])(
    'stage-1 -> stage-3 progress continuity across %i branches',
    (branchCount) => {
      const blocksTotal = branchCount * BLOCKS_PER_BRANCH;

      const percentFor = (narration: NarrationEvent): number => {
        const view = render(
          <ProgressBanner
            stage="infer_hierarchy_start"
            startedAt="2026-07-09T10:00:00Z"
            mode="survey"
            narrations={[narration]}
          />,
        );
        const percent = Number(view.getByRole('progressbar').getAttribute('aria-valuenow'));
        view.unmount();
        return percent;
      };

      it('never runs the bar further during stage 1 than stage 3 will report for its very first branch', () => {
        // Last stage-1 event: the final branch's skeleton starts, so every
        // OTHER branch has finished stage 1 of three.
        const skeletonPercent = percentFor({
          phase: 'build_skeleton',
          branchIndex: branchCount - 1,
          branchCount,
          blocksDone: (branchCount - 1) * BLOCKS_PER_BRANCH,
          blocksTotal,
          kbGrounded: false,
          kbCitations: [],
          message: 'x',
        });

        // First stage-3 event: branch 0's content authoring STARTS. Stage 3
        // opens with analyze_section, not section_complete (that fire was
        // missing entirely until the Part B final fix wave) -- this is the
        // smallest number stage 3 can ever report, and therefore the real
        // ceiling stage 1 must stay under.
        const contentPercent = percentFor({
          phase: 'analyze_section',
          branchIndex: 0,
          branchCount,
          blocksDone: 0,
          blocksTotal,
          kbGrounded: false,
          kbCitations: [],
          message: 'x',
        });

        expect(skeletonPercent).toBeLessThanOrEqual(contentPercent);

        // ...and stage 3's own opening event must not outrun its closing one.
        const sectionDonePercent = percentFor({
          phase: 'section_complete',
          branchIndex: 0,
          branchCount,
          blocksDone: 0,
          blocksTotal,
          kbGrounded: false,
          kbCitations: [],
          message: 'x',
        });
        expect(contentPercent).toBeLessThanOrEqual(sectionDonePercent);

        // Still genuinely nonzero during stage 1 -- the fix discounts and
        // clamps the cross-branch credit, it does not freeze the bar at zero
        // for the whole skeleton sweep. Note this clamp is deliberately tight:
        // the bar plateaus at SKELETON_STAGE_SHARE/branchCount for branches 1
        // through N-1 (the "advances monotonically" test below only asserts
        // non-decreasing, so a flat plateau also satisfies it) -- this is the
        // necessary cost of keeping stage 1's ceiling at or under stage 3's
        // real floor (analyze_section, branch 0) at every branch count; see
        // the Part B final fix wave's report for the full tradeoff.
        expect(skeletonPercent).toBeGreaterThan(0);
      });

      it('advances monotonically across the whole stage-1 sweep, never stepping backward', () => {
        const sweep = Array.from({ length: branchCount }, (_, branchIndex) =>
          percentFor({
            phase: 'build_skeleton',
            branchIndex,
            branchCount,
            blocksDone: branchIndex * BLOCKS_PER_BRANCH,
            blocksTotal,
            kbGrounded: false,
            kbCitations: [],
            message: 'x',
          }),
        );
        const sorted = [...sweep].sort((a, b) => a - b);
        expect(sweep).toEqual(sorted);
      });
    },
  );

  it('treats the new map_scope phase as a whole-document tail phase -- "Finishing up…", no fabricated ETA, no crash', () => {
    // B5: STAGE 2 (figure/table mapping) previously fired no narration at
    // all. Same tail-phase treatment as detect_conflicts/regroup_roots/
    // infer_trace_links (branch_index=null, blocksDone===blocksTotal) --
    // must not throw, and must not compute a fabricated ETA/percentage.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'map_scope', branchIndex: null, branchCount: 2, blocksDone: 30, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText('Mapping figures and tables to their sections')).toBeInTheDocument();
    expect(screen.getByText('Finishing up…')).toBeInTheDocument();
    expect(screen.queryByText(/~0s left/i)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  // The "stepper regresses backward" bug class this whole narration redesign
  // exists to prevent, in its final and widest form: stage 1 (build_skeleton)
  // sweeps EVERY branch before stage 3 (analyze_section/section_complete)
  // starts for ANY of them, and both stages count branchIndex 0..N-1
  // independently. Inferring "done" from `i < (latest.branchIndex ?? -1)`
  // therefore climbed to N-1 across stage 1 and RESET to 0 when stage 3
  // began. Completion is now tracked from the section_complete events
  // themselves, which fire once per branch, only in stage 3, and never reset.
  //
  // The fixtures below walk the real pipeline order for a 3-branch document:
  // build_skeleton x3 -> map_scope -> analyze_section/section_complete x3.
  const STAGE_1_SWEEP: NarrationEvent[] = [0, 1, 2].map((branchIndex) => ({
    phase: 'build_skeleton',
    branchIndex,
    branchCount: 3,
    blocksDone: branchIndex * 10,
    blocksTotal: 30,
    kbGrounded: false,
    kbCitations: [],
    message: 'x',
  }));
  const STAGE_2_MAPPING: NarrationEvent = {
    phase: 'map_scope',
    branchIndex: null,
    branchCount: 3,
    blocksDone: 30,
    blocksTotal: 30,
    kbGrounded: false,
    kbCitations: [],
    message: 'x',
  };
  const stage3Event = (phase: 'analyze_section' | 'section_complete', branchIndex: number): NarrationEvent => ({
    phase,
    branchIndex,
    branchCount: 3,
    blocksDone: branchIndex * 10,
    blocksTotal: 30,
    kbGrounded: false,
    kbCitations: [],
    message: 'x',
  });

  const checkCount = (narrations: NarrationEvent[]): number => {
    const view = render(
      <ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={narrations} />,
    );
    const count = view.queryAllByTestId('section-check-icon').length;
    view.unmount();
    return count;
  };

  const stepsLeft = (narrations: NarrationEvent[]): number => {
    const view = render(
      <ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={narrations} />,
    );
    const match = /(\d+) steps? left/.exec(view.container.textContent ?? '');
    view.unmount();
    // No chip at all means zero left -- see SectionStepList's own `stepsLeft > 0` guard.
    return match ? Number(match[1]) : 0;
  };

  it('never un-checks a section across the stage-1 -> stage-2 -> stage-3 transitions', () => {
    const timeline: NarrationEvent[] = [
      ...STAGE_1_SWEEP,
      STAGE_2_MAPPING,
      stage3Event('analyze_section', 0),
      stage3Event('section_complete', 0),
      stage3Event('analyze_section', 1),
      stage3Event('section_complete', 1),
      stage3Event('analyze_section', 2),
      stage3Event('section_complete', 2),
    ];
    const counts = timeline.map((_, i) => checkCount(timeline.slice(0, i + 1)));

    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    // ...and it genuinely reaches "all done", rather than being monotonic by
    // never checking anything at all.
    expect(counts.at(-1)).toBe(3);
    // Nothing may be claimed complete before the first section_complete: the
    // whole point is that stage 1 finishing a branch's SKELETON is not that
    // branch finishing.
    expect(counts[STAGE_1_SWEEP.length]).toBe(0);
  });

  it('never steps the "N steps left" countdown backward across those same transitions', () => {
    const timeline: NarrationEvent[] = [
      ...STAGE_1_SWEEP,
      STAGE_2_MAPPING,
      stage3Event('analyze_section', 0),
      stage3Event('section_complete', 0),
      stage3Event('analyze_section', 1),
      stage3Event('section_complete', 1),
    ];
    const remaining = timeline.map((_, i) => stepsLeft(timeline.slice(0, i + 1)));

    expect(remaining).toEqual([...remaining].sort((a, b) => b - a));
    // 3 sections + 4 whole-document passes, 2 sections genuinely done.
    expect(remaining.at(-1)).toBe(5);
  });

  it('keeps a completed section checked once a later section becomes the active one', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          stage3Event('section_complete', 0),
          stage3Event('section_complete', 1),
          stage3Event('analyze_section', 2),
        ]}
      />,
    );
    // Sections 1 and 2 checked; section 3 is the active one, not a checkmark.
    expect(screen.getAllByTestId('section-check-icon')).toHaveLength(2);
    expect(screen.getByText(/Section 3 of 3.*Analyzing and synthesizing requirements/)).toBeInTheDocument();
  });

  it('keeps a section checked via completedSectionIndices once its section_complete event ages out of the capped narrations window', () => {
    // On a document with enough branches, JobDetail's live `narrations` list
    // is capped at the last 50 events -- an early branch's section_complete
    // can age out mid-run while the job is still going. completedSectionIndices
    // (JobDetail's uncapped sectionResultsByIndex) is the durable signal that
    // covers exactly that gap; simulate the cap having already evicted branch
    // 0 and 1's section_complete events from `narrations`.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[stage3Event('analyze_section', 2)]}
        completedSectionIndices={[0, 1]}
      />,
    );
    expect(screen.getAllByTestId('section-check-icon')).toHaveLength(2);
    expect(screen.getByText(/Section 3 of 3.*Analyzing and synthesizing requirements/)).toBeInTheDocument();
  });

  it('does not check a section via completedSectionIndices alone without the prop -- confirms the fixture above is real, not incidental', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[stage3Event('analyze_section', 2)]}
      />,
    );
    expect(screen.queryAllByTestId('section-check-icon')).toHaveLength(0);
  });

  it('shows each section\'s real name (its own heading) instead of an anonymous index', () => {
    // Without sectionLabel, the step list could only ever show "Section N
    // of M" -- no way to tell WHICH real content the job analyzed or
    // failed on.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 1, branchCount: 3, blocksDone: 10, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x', sectionLabel: 'Backplane Power Budget' },
        ]}
      />,
    );
    expect(screen.getByText(/Section 2 of 3: Backplane Power Budget/)).toBeInTheDocument();
  });

  it('retains an earlier section\'s real name after a later section becomes active', () => {
    // The whole point for debugging a failed job: by the time it dies on
    // section 3, you still see what sections 1 and 2 actually were, not
    // just their generic index.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 0, branchCount: 3, blocksDone: 0, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x', sectionLabel: 'Display' },
          { phase: 'analyze_section', branchIndex: 1, branchCount: 3, blocksDone: 10, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x', sectionLabel: 'Audio' },
          { phase: 'analyze_section', branchIndex: 2, branchCount: 3, blocksDone: 20, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x', sectionLabel: 'Backplane Power Budget' },
        ]}
      />,
    );
    expect(screen.getByText(/Section 1 of 3: Display/)).toBeInTheDocument();
    expect(screen.getByText(/Section 2 of 3: Audio/)).toBeInTheDocument();
    expect(screen.getByText(/Section 3 of 3: Backplane Power Budget/)).toBeInTheDocument();
  });

  it('marks the trace-links step active and every section done once trace-link inference starts', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'infer_trace_links', branchIndex: null, branchCount: 2, blocksDone: 30, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getAllByTestId('section-check-icon')).toHaveLength(2);
    // Appears twice now, legitimately -- the header's own phase headline
    // (PHASE_SUBLABEL) and SectionStepList's own trace-links row both say
    // this for the same phase.
    expect(screen.getAllByText('Resolving trace links').length).toBeGreaterThan(0);
  });

  it('marks every section done and shows an active scoring step once whole-document scoring starts', () => {
    // Regression: §2c moved quality scoring out of the per-branch loop into
    // one whole-document pass, whose narration events carry branchIndex=null
    // -- confirmed live (real job) that this left every section step stuck
    // on an empty/pending circle for the entire scoring pass, even though
    // every section had already finished, reading as "no progress" even
    // when scoring 150 requirements was well underway.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'score_requirements', branchIndex: null, branchCount: 4, blocksDone: 682, blocksTotal: 682, kbGrounded: true, kbCitations: [], message: 'x', draftCount: 150 },
        ]}
      />,
    );
    expect(screen.getAllByTestId('section-check-icon')).toHaveLength(4);
    expect(screen.getByText(/Scoring requirement quality.*scoring 150 requirement\(s\)/)).toBeInTheDocument();
  });

  it('shows a persistent reassurance that the run continues if the page is closed', () => {
    render(<ProgressBanner stage="parse" startedAt="2026-07-09T10:00:00Z" mode="survey" />);
    expect(screen.getByText(/you can close this page/i)).toBeInTheDocument();
  });

  it('shows the phase headline and the latest narration as one sentence in the header, with no raw activity log', () => {
    // DESIGN.md §11.3's own audit note: the raw scrolling activity log this
    // used to render (every narration message in a collapsible list) is
    // explicitly superseded -- "do not build it." The header now carries a
    // plain-language phase headline (text-title) plus the latest
    // narration as a single sentence; SectionStepList (asserted elsewhere)
    // is what answers "what is left."
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 0, branchCount: 2, blocksDone: 0, blocksTotal: 10, kbGrounded: false, kbCitations: [], message: 'First message' },
          { phase: 'score_requirements', branchIndex: 0, branchCount: 2, blocksDone: 0, blocksTotal: 10, kbGrounded: false, kbCitations: [], message: 'Second message', draftCount: 4 },
        ]}
      />,
    );
    expect(screen.getByText('Scoring quality')).toBeInTheDocument();
    expect(screen.getByText('Second message')).toBeInTheDocument();
    expect(screen.queryByText('First message')).not.toBeInTheDocument();
    expect(screen.queryByText(/activity log/i)).not.toBeInTheDocument();
  });

  it('renders a describe_figure narration (parse stage) without a section step list', () => {
    // Regression: the parse stage (docx/pptx/pdf figure vision-captioning)
    // used to be a total black box -- confirmed live on a real 39-figure
    // document that took several minutes with zero narration. describe_figure
    // carries branchCount=0 (no section exists yet), so the per-section step
    // list must not render for it.
    render(
      <ProgressBanner
        stage="parse"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'describe_figure', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0, kbGrounded: false, kbCitations: [], figureIndex: 3, message: 'Describing an embedded figure via the vision model (figure 3 so far)' },
        ]}
      />,
    );
    // The header's own one-sentence narration line and RunDetail's
    // describe_figure branch both legitimately say this -- getAllByText
    // tolerates that expected duplication.
    expect(screen.getAllByText(/figure 3 so far/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Section 1 of/)).not.toBeInTheDocument();
  });

  it('never renders a blank metrics line during preparing_analysis (must always show real text)', () => {
    // Real regression this fixes: blocksTotal is 0 for preparing_analysis
    // (not known yet), which previously made the progress-estimate line
    // render nothing at all -- a visually blank box that read as "stuck."
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'preparing_analysis', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0, kbGrounded: false, kbCitations: [], message: 'Preparing analysis' },
        ]}
      />,
    );
    expect(screen.getByText(/no fixed step count to measure against/i)).toBeInTheDocument();
    expect(screen.queryByText(/not grounded against your knowledge base/i)).not.toBeInTheDocument();
  });

  it('renders a parse_done narration with real block/table/figure counts', () => {
    render(
      <ProgressBanner
        stage="parse"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'parse_done', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0, kbGrounded: false, kbCitations: [], blockCount: 682, tableCount: 5, figureCount: 39, message: 'Finished parsing the document -- 682 block(s), 5 table(s), 39 figure(s)' },
        ]}
      />,
    );
    expect(screen.getAllByText(/682 block\(s\), 5 table\(s\), 39 figure\(s\)/).length).toBeGreaterThan(0);
  });

  it('shows the real KB file names a section was grounded against, not just a count', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          {
            phase: 'analyze_section', branchIndex: 0, branchCount: 2, blocksDone: 0, blocksTotal: 10,
            kbGrounded: true, kbCitations: [{ sourceFile: 'requirements-standard.pdf', similarity: 0.82 }],
            message: 'x',
          },
        ]}
      />,
    );
    expect(screen.getByText('Grounded against:')).toBeInTheDocument();
    // similarity must be VISIBLE text, not only a hover title attribute
    // (DESIGN.md Track B, phase B6) -- matched as one chip's full content.
    expect(screen.getByText('requirements-standard.pdf · 82%')).toBeInTheDocument();
  });

  it('tells the user a section was NOT grounded against the knowledge base, rather than staying silent', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 0, branchCount: 2, blocksDone: 0, blocksTotal: 10, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText(/not grounded against your knowledge base/i)).toBeInTheDocument();
  });

  it('shows a live "last update" ticker once narration has started', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 0, branchCount: 2, blocksDone: 0, blocksTotal: 10, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getAllByText(/\d+s ago/i).length).toBeGreaterThan(0);
  });

  it('renders a real N-of-M counter for dedup_check, despite its branchCount always being 0', () => {
    // Regression this fixes (DESIGN.md Track B, phase B6): dedup_check
    // always carries branchCount 0 (job-events.publisher.ts hardcodes it),
    // so the old `branchCount > 0` guard around SectionStepList rendered
    // NOTHING at all for this phase -- a bare spinner with no detail for
    // however long the dedup pass took.
    render(
      <ProgressBanner
        stage="dedup_check"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'dedup_check', branchIndex: null, branchCount: 0, blocksDone: 12, blocksTotal: 40, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText(/checking 12 of 40 proposed items/i)).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('renders exactly ONE progress bar for dedup_check, not two at the same percentage (CR-10, "Wizard UX Options" decision sheet)', () => {
    // Real bug found on review, confirmed still live: the generic metrics
    // panel above RunDetail computes a progress value for dedup_check too
    // (branchCount is 0, so the section-share math falls through to
    // blocksDone directly) and rendered its OWN chip+bar for it, mislabelled
    // "12 / 40 blocks" (isScoringPhase is false, so the label never says
    // "proposed items") -- stacked directly above RunDetail's own correctly
    // labelled "Checking 12 of 40 proposed items" bar at the identical
    // percentage. An earlier version of this exact test asserted the TWO-bar
    // output as the expected, correct behavior; it was not -- see the sheet's
    // own words: "not redundancy in the display, it is a claim the data does
    // not support."
    render(
      <ProgressBanner
        stage="dedup_check"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'dedup_check', branchIndex: null, branchCount: 0, blocksDone: 12, blocksTotal: 40, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.queryByText(/\d+ \/ \d+ blocks/)).not.toBeInTheDocument();
    const progressBars = screen.getAllByRole('progressbar');
    expect(progressBars).toHaveLength(1);
    expect(progressBars[0]).toHaveAttribute('aria-valuenow', '30');
  });

  it('renders exactly ONE progress bar during writing too -- the identical structural bug, same branchCount-0 code path as dedup_check', () => {
    render(
      <ProgressBanner
        stage="writing"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          {
            phase: 'writing', branchIndex: null, branchCount: 0, blocksDone: 5, blocksTotal: 20,
            kbGrounded: false, kbCitations: [], message: 'x', writeSubPhase: 'create',
          },
        ]}
      />,
    );
    expect(screen.queryByText(/\d+ \/ \d+ blocks/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it.each(['discover_types', 'create', 'link_parents', 'trace_links'] as const)(
    'renders the write sub-stepper for writeSubPhase "%s", despite writing always carrying branchCount 0',
    (writeSubPhase) => {
      render(
        <ProgressBanner
          stage="writing"
          startedAt="2026-07-09T10:00:00Z"
          mode="survey"
          narrations={[
            { phase: 'writing', writeSubPhase, branchIndex: null, branchCount: 0, blocksDone: 2, blocksTotal: 5, kbGrounded: false, kbCitations: [], message: 'x' },
          ]}
        />,
      );
      expect(screen.getByText('Resolve types')).toBeInTheDocument();
      expect(screen.getByText('Create items')).toBeInTheDocument();
      expect(screen.getByText('Link parents')).toBeInTheDocument();
      expect(screen.getByText('Trace links')).toBeInTheDocument();
      expect(screen.getByText('2 of 5 written')).toBeInTheDocument();
    },
  );

  it('renders parse_done block/table/figure counts as real, discrete chips -- not just buried in the message string', () => {
    render(
      <ProgressBanner
        stage="parse"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          {
            phase: 'parse_done', branchIndex: null, branchCount: 0, blocksDone: 0, blocksTotal: 0,
            kbGrounded: false, kbCitations: [], blockCount: 682, tableCount: 5, figureCount: 39,
            message: 'Finished parsing the document',
          },
        ]}
      />,
    );
    expect(screen.getByText('682 blocks')).toBeInTheDocument();
    expect(screen.getByText('5 tables')).toBeInTheDocument();
    expect(screen.getByText('39 figures')).toBeInTheDocument();
  });
});
