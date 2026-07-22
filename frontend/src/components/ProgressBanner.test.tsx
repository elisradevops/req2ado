import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('shows the ~40 min messaging for survey jobs', () => {
    render(<ProgressBanner stage="parse" startedAt="2026-07-09T10:00:00Z" mode="survey" />);
    expect(screen.getByText(/up to ~40 min/i)).toBeInTheDocument();
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
    expect(screen.getByText('Generating formal requirements (section 1 of 3)')).toBeInTheDocument();
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
    // Multiple elements have role=progressbar now (the linear bar + a
    // CircularProgress spinner per active step in the section list) --
    // the linear one is the only .MuiLinearProgress-root.
    const progressbars = screen.getAllByRole('progressbar');
    const linear = progressbars.find((el) => el.classList.contains('MuiLinearProgress-root'));
    expect(linear).toHaveAttribute('aria-valuenow', '50');
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
    expect(screen.getAllByTestId('CheckCircleIcon')).toHaveLength(2);
    expect(screen.getByText('Resolving trace links')).toBeInTheDocument();
  });
});
