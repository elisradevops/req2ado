import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { ProgressBanner } from './ProgressBanner';
import type { NarrationEvent } from '../api/events';
import { FLUSH_INTERVAL_MS, useLiveRunStore } from '../store/liveRunStore';
import { clearDocumentMapCache } from '../hooks/useDocumentMap';
import { getRunMap } from '../api/runMap';

vi.mock('../api/runMap', () => ({ getRunMap: vi.fn().mockResolvedValue(null) }));

describe('ProgressBanner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows no ETA chip before any narration has arrived', () => {
    // No narration yet -- there's no real progress data to calculate a
    // rate from, so no ETA (calculated or "Estimating...") should render
    // at all, rather than a fabricated guess.
    render(<ProgressBanner stage="parse" startedAt="2026-07-09T10:00:00Z" mode="survey" />);
    expect(screen.queryByText(/left/i)).not.toBeInTheDocument();
  });

  describe('time left in this step', () => {
    const scoring = (done: number, total = 427): NarrationEvent => ({
      phase: done >= total ? 'score_requirements_done' : 'score_requirements',
      branchIndex: null, branchCount: 0, blocksDone: done, blocksTotal: total,
      kbGrounded: false, kbCitations: [], message: 'x', chunkIndex: Math.floor(done / 50), chunkCount: 9,
    });
    // "~5m 30s left in this step" -> 330 ; "~40s left ..." -> 40 ; "~12m left ..." -> 720
    const secondsLeft = (): number | null => {
      const match = /~(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?\s*left in this step/i.exec(document.body.textContent ?? '');
      if (!match) return null;
      return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
    };
    const mount = (narrations: NarrationEvent[]) =>
      render(
        // startedAt is years in the past: the estimate must not depend on it at all.
        <ProgressBanner stage="infer_hierarchy_start" startedAt="2020-01-01T00:00:00Z" mode="survey" narrations={narrations} />,
      );

    it('says "Estimating…" until it has watched enough of the step, whatever the job start time says', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-09T10:00:00Z'));
      mount([scoring(0)]);
      expect(screen.getByText('Estimating time left…')).toBeInTheDocument();
      expect(screen.queryByText(/left in this step/i)).not.toBeInTheDocument();
    });

    it('counts down between completions and never rises, then re-fits when the next batch lands', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-09T10:00:00Z'));
      const view = mount([scoring(0)]);

      act(() => vi.advanceTimersByTime(46_000)); // first batch of 50 lands after 46 s
      view.rerender(
        <ProgressBanner stage="infer_hierarchy_start" startedAt="2020-01-01T00:00:00Z" mode="survey" narrations={[scoring(0), scoring(50)]} />,
      );
      const first = secondsLeft();
      expect(first).not.toBeNull();
      // ~377 units left at ~1.09 units/s -> a bit under 6 minutes, nowhere near "hours since the job started".
      expect(first!).toBeGreaterThan(240);
      expect(first!).toBeLessThan(420);

      // 3 minutes pass with NO batch landing: the shown time may only go down.
      let previous = first!;
      for (let i = 0; i < 6; i += 1) {
        act(() => vi.advanceTimersByTime(30_000));
        const now = secondsLeft();
        expect(now).not.toBeNull();
        expect(now!).toBeLessThanOrEqual(previous);
        previous = now!;
      }
      expect(previous).toBeLessThan(first! - 120);
    });

    it('says it is taking longer than expected, instead of a growing number, once the predicted time has passed', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-09T10:00:00Z'));
      const view = mount([scoring(0)]);
      act(() => vi.advanceTimersByTime(46_000));
      view.rerender(
        <ProgressBanner stage="infer_hierarchy_start" startedAt="2020-01-01T00:00:00Z" mode="survey" narrations={[scoring(0), scoring(50)]} />,
      );
      expect(secondsLeft()).not.toBeNull();

      act(() => vi.advanceTimersByTime(20 * 60_000)); // a batch that never returns (the 911 s case, and then some)

      expect(screen.getByText('Taking longer than expected…')).toBeInTheDocument();
      expect(secondsLeft()).toBeNull();
    });

    it('starts a fresh estimate when the next scoring pass begins (a different total)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-09T10:00:00Z'));
      const view = mount([scoring(0)]);
      act(() => vi.advanceTimersByTime(46_000));
      view.rerender(
        <ProgressBanner stage="infer_hierarchy_start" startedAt="2020-01-01T00:00:00Z" mode="survey" narrations={[scoring(50)]} />,
      );
      expect(secondsLeft()).not.toBeNull();

      view.rerender(
        <ProgressBanner stage="infer_hierarchy_start" startedAt="2020-01-01T00:00:00Z" mode="survey" narrations={[scoring(0, 115)]} />,
      );

      expect(screen.getByText('Estimating time left…')).toBeInTheDocument();
    });
  });

  it('shows "Estimating..." (never a literal NaN) for an unparseable startedAt', () => {
    // Real gap this closes: new Date(startedAt).getTime() on an unparseable
    // string is NaN -- previously relied on that NaN failing the >= 15_000
    // comparison by coincidence rather than an explicit guard.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="not-a-real-date"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 1, branchCount: 4, blocksDone: 100, blocksTotal: 400, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText('Estimating time left…')).toBeInTheDocument();
    expect(screen.queryByText(/nan/i)).not.toBeInTheDocument();
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

  it('does not blend an unrelated phase\'s elapsed time into a fresh deterministic_subtree ETA', () => {
    // Real regression this fixes (confirmed live on a real 679-block
    // document): deterministic_subtree's rate used to be computed from
    // `now - job startedAt`, which blends in whatever ran before it (here,
    // ~3.5 real minutes of unrelated figure-captioning work during parse).
    // startedAt is set far in the past so the OLD calc would trivially
    // clear the 15s/1-unit trust threshold and render a fabricated "~X
    // left" number derived from that unrelated time. The fix re-baselines
    // to when THIS deterministic_subtree window (this phase + this
    // blocksTotal) actually started -- on this narration's first render
    // that's "just now", so it must show the same honest "Estimating…"
    // fallback a phase with no history yet always shows, not a number.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2020-01-01T00:00:00Z"
        mode="survey"
        narrations={[
          {
            phase: 'deterministic_subtree',
            branchIndex: null,
            branchCount: 0,
            blocksDone: 150,
            blocksTotal: 275,
            kbGrounded: false,
            kbCitations: [],
            subtreeLabel: 'synthesizing requirement text for 125 node(s) (chunk 2 of 2)',
            message: 'x',
          },
        ]}
      />,
    );
    expect(screen.getByText('Estimating time left…')).toBeInTheDocument();
    expect(screen.queryByText(/~\d.*left/i)).not.toBeInTheDocument();
  });

  it('does not show a falsely-shrinking ETA for a first-time observer arriving mid-chunk (deterministic_subtree)', () => {
    // Real regression this fixes (confirmed live, redeploy mid-run): a tab
    // that starts observing an already-in-flight chunk must not divide
    // real elapsed time by completedUnits that already reflects work it
    // never watched happen -- it must stay on the honest "Estimating…"
    // fallback until it has personally witnessed at least one unit
    // resolve, no matter how much real time passes waiting for that.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T10:10:00Z'));
    const narrations: NarrationEvent[] = [
      {
        phase: 'deterministic_subtree',
        branchIndex: null,
        branchCount: 0,
        blocksDone: 150,
        blocksTotal: 153,
        kbGrounded: false,
        kbCitations: [],
        subtreeLabel: 'enhancing titles/tags for 3 node(s) (chunk 2 of 2)',
        message: 'x',
      },
    ];
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={narrations}
      />,
    );
    expect(screen.getByText('Estimating time left…')).toBeInTheDocument();
    // 30 real seconds pass with NOTHING changing server-side (blocksDone
    // stays 150) -- the old, unbaselined calc would have crossed the 15s
    // trust threshold and shown a wrong, shrinking number by now.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Estimating time left…')).toBeInTheDocument();
    expect(screen.queryByText(/~\d.*left/i)).not.toBeInTheDocument();
  });

  it('shows a chunk track and a real explanation of what a deterministic_subtree chunk is doing', () => {
    // Real gap this fixes (confirmed live): the ETA fixes above make the
    // dead zone honest, not informative -- this is the first real content
    // shown during the 4-9 real minutes a chunk blocks for.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2020-01-01T00:00:00Z"
        mode="survey"
        narrations={[
          {
            phase: 'deterministic_subtree',
            branchIndex: null,
            branchCount: 0,
            blocksDone: 150,
            blocksTotal: 275,
            kbGrounded: false,
            kbCitations: [],
            subtreeLabel: 'synthesizing requirement text for 125 node(s) (chunk 2 of 2)',
            message: 'x',
          },
        ]}
      />,
    );
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    // Real node count (from the label) and a real, deterministically-zero
    // "so far" clock on first render -- not a fabricated percentage or
    // duration range.
    expect(screen.getByText('Drafting requirement text for 125 headings in one model call — 0s so far.')).toBeInTheDocument();
    // No hardcoded minute-range claim -- the app's own standard (this
    // session's ETA fix) is never to fabricate a duration it doesn't have.
    expect(screen.queryByText(/\d+\s*[-–]\s*\d+\+?\s*min/i)).not.toBeInTheDocument();
  });

  it('labels the title/tag pass distinctly from the synthesis pass in the chunk-track explainer', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2020-01-01T00:00:00Z"
        mode="survey"
        narrations={[
          {
            phase: 'deterministic_subtree',
            branchIndex: null,
            branchCount: 0,
            blocksDone: 0,
            blocksTotal: 153,
            kbGrounded: false,
            kbCitations: [],
            subtreeLabel: 'enhancing titles/tags for 150 node(s) (chunk 1 of 2)',
            message: 'x',
          },
        ]}
      />,
    );
    expect(screen.getByText('Enhancing titles and tags for 150 headings in one model call — 0s so far.')).toBeInTheDocument();
  });

  it('does not show a chunk track for phases other than deterministic_subtree', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2020-01-01T00:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 1, branchCount: 4, blocksDone: 100, blocksTotal: 400, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.queryByText(/Drafting requirement text for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enhancing titles and tags for/)).not.toBeInTheDocument();
  });

  it('ticks the per-chunk "so far" clock forward as real time passes, for a genuine sense of progression', () => {
    // Real gap this fixes: the explainer previously read as a static,
    // interchangeable line no matter how long a chunk had actually been
    // running -- nothing ever visibly moved. This must count up on its
    // own, the same live clock the ETA above already ticks from.
    vi.useFakeTimers();
    const narrations: NarrationEvent[] = [
      {
        phase: 'deterministic_subtree',
        branchIndex: null,
        branchCount: 0,
        blocksDone: 0,
        blocksTotal: 275,
        kbGrounded: false,
        kbCitations: [],
        subtreeLabel: 'synthesizing requirement text for 150 node(s) (chunk 1 of 2)',
        message: 'x',
      },
    ];
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2020-01-01T00:00:00Z" mode="survey" narrations={narrations} />);
    expect(screen.getByText(/— 0s so far\.$/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(75_000);
    });
    expect(screen.getByText(/— 1m 15s so far\.$/)).toBeInTheDocument();
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

  it('labels the 4 whole-document rows under their own "Scoring & linking" header, separate from "Sections"', () => {
    // Real user confusion this fixes: those 4 rows (scoring, conflicts,
    // regroup, trace links) are whole-document passes, not per-section work,
    // but previously sat under the "Sections" header with no label of their
    // own -- reading as if they were more sections.
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'analyze_section', branchIndex: 0, branchCount: 1, blocksDone: 10, blocksTotal: 30, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText('Sections')).toBeInTheDocument();
    expect(screen.getByText('Scoring & linking')).toBeInTheDocument();
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

  it('shows a real progress percentage for describe_figure once a pre-counted figureCount is known', () => {
    // Real regression this fixes: with a real figureCount already known
    // (docx pre-count ran ahead of the walk -- see figure_count's own
    // docstring), the metrics line used to still say "Working -- no
    // progress estimate for this step yet." even though "figure 21 of 36"
    // was already known and displayed right above this same panel.
    render(
      <ProgressBanner
        stage="parse"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          {
            phase: 'describe_figure',
            branchIndex: null,
            branchCount: 0,
            blocksDone: 0,
            blocksTotal: 0,
            kbGrounded: false,
            kbCitations: [],
            figureIndex: 21,
            figureCount: 36,
            message: 'Describing an embedded figure via the vision model (figure 21 of 36)',
          },
        ]}
      />,
    );
    expect(screen.getByText(/~58% of this section \(est\.\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/no progress estimate for this step yet/i)).not.toBeInTheDocument();
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

  it('resets the "last update" counter on a new event even when the 50-event cap keeps the list length constant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T10:30:00Z'));
    const makeEvent = (i: number): NarrationEvent => ({
      phase: 'analyze_section', branchIndex: i, branchCount: 100, blocksDone: i, blocksTotal: 1000,
      kbGrounded: false, kbCitations: [], message: `event ${i}`,
    });
    const full = Array.from({ length: 50 }, (_, i) => makeEvent(i));
    const { rerender } = render(
      <ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={full} />,
    );
    act(() => {
      vi.advanceTimersByTime(125_000);
    });
    expect(screen.getByTitle(/time since the last progress update/i)).toHaveTextContent(/2m 5s ago/);

    // JobDetail's `[...current, narration].slice(-50)`: new last object, SAME length.
    const next = [...full, makeEvent(50)].slice(-50);
    expect(next.length).toBe(full.length);
    rerender(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={next} />);
    // The ref resets in an effect, so the display catches up on the next
    // clock tick (same one-render lag useWindowStartedAt documents).
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTitle(/time since the last progress update/i)).toHaveTextContent(/updated 1s ago/);
  });

  it.each([
    ['analyze_section', { branchIndex: 1, sectionLabel: '3.2 Receiver' }, /writing requirement text for “3\.2 Receiver”/],
    ['score_requirements', { branchIndex: null, chunkIndex: 1, chunkCount: 4 }, /scoring requirement batch 2 of 4/],
  ] as const)('shows a live "so far" model-call clock during %s', (phase, extra, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T10:30:00Z'));
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase, branchCount: 4, blocksDone: 10, blocksTotal: 100, kbGrounded: false, kbCitations: [], message: 'x', ...extra } as NarrationEvent,
        ]}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(372_000);
    });
    const clock = screen.getByTestId('model-call-clock');
    expect(clock).toHaveTextContent(expected);
    expect(clock).toHaveTextContent(/6m 12s so far/);
    // After a minute of silence the meta row says what is actually going on.
    expect(screen.getByTitle(/time since the last progress update/i)).toHaveTextContent(/waiting on model · last update 6m 12s ago/);
  });

  it('shows no model-call clock once the phase is not an in-flight model call', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'section_complete', branchIndex: 0, branchCount: 2, blocksDone: 5, blocksTotal: 10, kbGrounded: false, kbCitations: [], message: 'x' },
        ]}
      />,
    );
    expect(screen.queryByTestId('model-call-clock')).not.toBeInTheDocument();
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


// Job transparency: the counted percentage, the fallback to today's estimate,
// and the live view. One phase, one bar -- the counted figure replaces the
// block-based estimate rather than adding a second bar.
describe('ProgressBanner live run view', () => {
  const analyze: NarrationEvent = {
    phase: 'analyze_section', branchIndex: 1, branchCount: 4, blocksDone: 100, blocksTotal: 400,
    kbGrounded: false, kbCitations: [], message: 'x',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    useLiveRunStore.getState().reset();
    useLiveRunStore.getState().begin('job-1');
    clearDocumentMapCache();
    vi.mocked(getRunMap).mockReset();
    vi.mocked(getRunMap).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    useLiveRunStore.getState().reset();
  });

  const send = (progress: Record<string, unknown>): void => {
    act(() => {
      useLiveRunStore.getState().ingestProgress({
        type: 'progress', seq: 1, pct: 38, stage: 'improve', unit: 'items', done: 12, total: 36,
        estimated: true, emittedAt: 'x', ...progress,
      } as never);
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    });
  };

  it('builds the time left from the counted per-item progress, not the chunk-level event that only moves when a chunk lands', () => {
    // The synthesis step as seen live: the server's event says 0 of 275 until a 150-node chunk returns
    // (minutes), while the counted progress -- the one the bar and "N of M items" show -- moves per item.
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[analyze]} jobId="job-1" />);
    send({ seq: 1, done: 0, total: 275, pct: 2 });
    expect(screen.getByText('Estimating time left…')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(50_000));
    send({ seq: 2, done: 21, total: 275, pct: 3 });
    act(() => vi.advanceTimersByTime(50_000));
    send({ seq: 3, done: 43, total: 275, pct: 4 });

    expect(screen.getByText(/left in this step/i)).toBeInTheDocument();
  });

  it('keeps today\'s block-based estimate and label when there are no progress events', () => {
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[analyze]} jobId="job-1" />);
    expect(screen.getByText(/of this section \(est\.\)/)).toBeInTheDocument();
    expect(screen.queryByText(/of the run/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-run-panel')).not.toBeInTheDocument();
  });

  it('shows the counted percentage, named for what is counted, instead of the estimate', () => {
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[analyze]} jobId="job-1" />);
    send({});
    expect(screen.getByText('38%')).toBeInTheDocument();
    expect(screen.getByText('38% of the run (est.) — 12 of 36 items in this step')).toBeInTheDocument();
    expect(screen.queryByText(/of this section \(est\.\)/)).not.toBeInTheDocument();
  });

  it('has exactly one progress bar, named, with an honest reading of its value', () => {
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[analyze]} jobId="job-1" />);
    send({ pct: 38 });
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute('aria-label', 'Run progress');
    expect(bars[0]).toHaveAttribute('aria-valuenow', '38');
    expect(bars[0]).toHaveAttribute('aria-valuetext', '38 percent of the run, estimated');
  });

  it('drops the start-of-chunk blocks chip once a counted figure says the same thing', () => {
    const props = { stage: 'infer_hierarchy_start' as const, startedAt: '2026-07-09T10:00:00Z', mode: 'survey' as const, narrations: [analyze], jobId: 'job-1' };
    const { rerender } = render(<ProgressBanner {...props} />);
    expect(screen.getByText('100 / 400 blocks')).toBeInTheDocument();
    send({});
    rerender(<ProgressBanner {...props} />);
    expect(screen.queryByText('100 / 400 blocks')).not.toBeInTheDocument();
    expect(screen.getByText(/12 of 36 items in this step/)).toBeInTheDocument();
  });

  it('names the bar and says so when there is no estimate at all', () => {
    render(<ProgressBanner stage="parse" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[{ ...analyze, phase: 'preparing_analysis', blocksTotal: 0, blocksDone: 0, branchCount: 0 }]} jobId="job-1" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-label', 'Run progress');
    expect(bar).toHaveAttribute('aria-valuetext', 'No progress estimate for this step');
  });

  it('explains how the percentage is counted', () => {
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[analyze]} jobId="job-1" />);
    send({});
    expect(screen.getByRole('button', { name: 'How the percentage is counted' })).toBeInTheDocument();
  });

  it('has the one polite status region from the first render, even with no live events', () => {
    render(<ProgressBanner stage="parse" startedAt="2026-07-09T10:00:00Z" mode="survey" jobId="job-1" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('drops the "bar moves when the call returns" note once the run counts items live', () => {
    const props = { stage: 'infer_hierarchy_start' as const, startedAt: '2026-07-09T10:00:00Z', mode: 'survey' as const, narrations: [analyze], jobId: 'job-1' };
    const { rerender } = render(<ProgressBanner {...props} />);
    expect(screen.getByTestId('model-call-clock')).toBeInTheDocument(); // today's behaviour with no live events
    send({});
    rerender(<ProgressBanner {...props} />);
    expect(screen.queryByTestId('model-call-clock')).not.toBeInTheDocument();
  });

  it('restarts the "updated … ago" stamp when live frames arrive between narration events', () => {
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[analyze]} jobId="job-1" />);
    act(() => {
      vi.advanceTimersByTime(125_000);
    });
    expect(screen.getByText(/waiting on model · last update 2m 5s ago/)).toBeInTheDocument();
    act(() => {
      useLiveRunStore.getState().ingestLive({ type: 'live', seq: 1, lane: 0, kind: 'item', ref: 'r1', title: 'T', emittedAt: 'x' });
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 1000);
    });
    // One more clock tick: the counter restarts when the effect runs, and shows on the next render.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/updated [01]s ago/)).toBeInTheDocument();
  });

  it('does not let a heartbeat pretend the run produced something', () => {
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[analyze]} jobId="job-1" />);
    act(() => {
      vi.advanceTimersByTime(125_000);
    });
    act(() => {
      useLiveRunStore.getState().ingestHeartbeat({ type: 'heartbeat', at: 'x', idleSeconds: 120, inFlight: [] });
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 1000);
    });
    expect(screen.getByText(/waiting on model · last update 2m \d+s ago/)).toBeInTheDocument();
  });

  it('shows the live view only after live events arrive', () => {
    render(<ProgressBanner stage="infer_hierarchy_start" startedAt="2026-07-09T10:00:00Z" mode="survey" narrations={[analyze]} jobId="job-1" />);
    expect(screen.queryByTestId('live-run-panel')).not.toBeInTheDocument();
    send({});
    expect(screen.getByTestId('live-run-panel')).toBeInTheDocument();
  });
});
