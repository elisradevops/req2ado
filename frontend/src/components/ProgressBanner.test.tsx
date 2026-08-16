import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBanner } from './ProgressBanner';

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
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
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

  it('does not un-check already-completed sections when map_scope becomes the latest phase', () => {
    // Regression guard for the exact "stepper regresses backward" bug class
    // this whole task (build_skeleton/map_scope) exists to prevent. Before
    // this fix, map_scope's own branch_index=null left SectionStepList's
    // `allSectionsDone` false (map_scope was only wired into the separate
    // top-level isTailPhase, not this component's own allSectionsDone), so
    // `isDone = allSectionsDone || i < (latest.branchIndex ?? -1)` evaluated
    // to false for EVERY section the moment map_scope became latest --
    // sections that already showed a checkmark visibly reverted to a plain
    // pending circle for the whole mapping window, even though every
    // section had, in fact, already finished its own analysis pass.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          // Sections 0 and 1 already finished (only section 2, the last
          // one, is still "active" at this point).
          { phase: 'analyze_section', branchIndex: 2, branchCount: 3, blocksDone: 20, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x' },
          // Whole-document mapping starts next -- branchIndex is null.
          { phase: 'map_scope', branchIndex: null, branchCount: 3, blocksDone: 30, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    // All 3 sections must show a checkmark -- none may revert to pending.
    expect(screen.getAllByTestId('section-check-icon')).toHaveLength(3);
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
