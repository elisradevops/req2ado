import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProgressBanner } from './ProgressBanner';

describe('ProgressBanner', () => {
  it.each([
    ['parse', /parsing/i],
    ['infer_hierarchy_start', /analyzing structure/i],
    ['generate_requirements_done', /finalizing/i],
  ])('renders a human label for stage %s', (stage, expectedText) => {
    render(<ProgressBanner stage={stage as any} startedAt="2026-07-09T10:00:00Z" mode="survey" />);
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

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

  it('never shows a fabricated "~0s left" during the scoring/trace-link tail phases', () => {
    // Confirmed real bug (screenshot): score_requirements/score_requirements_done
    // and infer_trace_links report blocksDone === blocksTotal (every section
    // is already finished by the time either runs) -- the old calc added
    // withinSectionCredit on top of an already-full blocksDone, overshooting
    // blocksTotal, going negative, and clamping to a fake "~0s left" while
    // the job was still genuinely working. Must show "Finishing up…" and an
    // indeterminate bar instead of any fabricated number.
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
    expect(screen.queryByText(/~0s left/i)).not.toBeInTheDocument();
    expect(screen.getByText('Finishing up…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
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
    // The activity log (added alongside the main message) also lists every
    // narration seen so far, including this same text -- getAllByText
    // tolerates that expected duplication.
    expect(screen.getAllByText('Generating formal requirements (section 1 of 3)').length).toBeGreaterThan(0);
    expect(screen.queryByText(/analyzing structure\.\.\./i)).not.toBeInTheDocument();
  });

  it('falls back to the coarse stage label when narrations is empty (baseline mode / no narration yet)', () => {
    render(<ProgressBanner stage="parse" startedAt="2026-07-09T10:00:00Z" mode="baseline" narrations={[]} />);
    expect(screen.getByText(/parsing/i)).toBeInTheDocument();
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
    expect(screen.getByText('Resolving trace links')).toBeInTheDocument();
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

  it('highlights "Building the diff" once trace-link inference starts, not "Analysing sections"', () => {
    render(
      <ProgressBanner
        stage="infer_hierarchy_start"
        startedAt="2026-07-09T10:00:00Z"
        mode="survey"
        narrations={[
          { phase: 'infer_trace_links', branchIndex: null, branchCount: 2, blocksDone: 30, blocksTotal: 30, kbGrounded: false, kbCitations: [] as { sourceFile: string; similarity: number }[], message: 'x' },
        ]}
      />,
    );
    expect(screen.getByText('Building the diff').closest('li')?.querySelector('[data-state]')).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Analysing sections').closest('li')?.querySelector('[data-state]')).toHaveAttribute('data-state', 'done');
  });

  it('expands a collapsed activity log listing every narration seen so far, on click', async () => {
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
    const toggle = screen.getByRole('button', { name: /activity log \(2\)/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('First message')).toBeInTheDocument();
    expect(screen.getAllByText('Second message').length).toBeGreaterThan(0);
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
    // The message also appears in the (collapsed but present) activity log
    // -- getAllByText tolerates that expected duplication.
    expect(screen.getAllByText(/figure 3 so far/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Section 1 of/)).not.toBeInTheDocument();
    expect(screen.getByText('Reading document').closest('li')?.querySelector('[data-state]')).toHaveAttribute('data-state', 'active');
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
    expect(screen.getByText('requirements-standard.pdf')).toBeInTheDocument();
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
    expect(screen.getByText(/\d+s ago/i)).toBeInTheDocument();
  });
});
