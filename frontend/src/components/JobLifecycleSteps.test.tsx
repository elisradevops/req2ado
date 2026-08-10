import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JobLifecycleSteps } from './JobLifecycleSteps';
import type { JobStage, NarrationEvent } from '../api/events';

function stateOf(label: string): string | null {
  return screen.getByText(label).closest('li')?.querySelector('[data-state]')?.getAttribute('data-state') ?? null;
}

describe('JobLifecycleSteps', () => {
  it('renders all 6 survey steps, 4 for baseline (no Analyze/Score)', () => {
    const survey = render(<JobLifecycleSteps mode="survey" status="running" stage="parse" latestNarrationPhase={null} />);
    expect(screen.getByText('Analyze')).toBeInTheDocument();
    expect(screen.getByText('Score')).toBeInTheDocument();
    survey.unmount();

    render(<JobLifecycleSteps mode="baseline" status="running" stage="parse" latestNarrationPhase={null} />);
    expect(screen.queryByText('Analyze')).not.toBeInTheDocument();
    expect(screen.queryByText('Score')).not.toBeInTheDocument();
    expect(screen.getAllByText('Parse').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Write').length).toBeGreaterThan(0);
  });

  it('shows a queued, non-spinning "current" step while pending', () => {
    render(<JobLifecycleSteps mode="survey" status="pending" stage={null} latestNarrationPhase={null} />);
    expect(stateOf('Parse')).toBe('awaiting');
    expect(stateOf('Write')).toBe('pending');
  });

  it('marks the running step "current" from stage alone, with no narration yet', () => {
    render(<JobLifecycleSteps mode="survey" status="running" stage="parse" latestNarrationPhase={null} />);
    expect(stateOf('Parse')).toBe('current');
    expect(stateOf('Analyze')).toBe('pending');
  });

  it('does not regress from Score back to Analyze during detect_conflicts/regroup_roots/infer_trace_links', () => {
    // infer_trace_links included -- confirmed live: leaving it out of this
    // guard regressed the stepper backward to "Analyze" during trace/coverage
    // link resolution, the exact bug this whole condition exists to prevent.
    const cases: NarrationEvent['phase'][] = [
      'detect_conflicts',
      'regroup_roots',
      'infer_trace_links',
      'score_requirements',
      'score_requirements_done',
    ];
    for (const phase of cases) {
      const { unmount } = render(<JobLifecycleSteps mode="survey" status="running" stage="infer_hierarchy_start" latestNarrationPhase={phase} />);
      expect(stateOf('Score')).toBe('current');
      expect(stateOf('Analyze')).toBe('done');
      unmount();
    }
  });

  it('shows a phase-specific tooltip for detect_conflicts/regroup_roots/infer_trace_links instead of Score\'s static "judging quality" tip', async () => {
    const cases: [NarrationEvent['phase'], string][] = [
      ['detect_conflicts', /near-duplicate\/conflicting values/i],
      ['regroup_roots', /grouping disconnected sections/i],
      ['infer_trace_links', /trace\/coverage links/i],
    ];
    for (const [phase, expectedTip] of cases) {
      const { unmount } = render(<JobLifecycleSteps mode="survey" status="running" stage="infer_hierarchy_start" latestNarrationPhase={phase} />);
      fireEvent.focus(screen.getByLabelText('More information'));
      expect(await screen.findByText(expectedTip)).toBeInTheDocument();
      expect(screen.queryByText(/judging each drafted requirement/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('marks dedup_check as current from stage, and everything before it done', () => {
    render(<JobLifecycleSteps mode="survey" status="running" stage="dedup_check" latestNarrationPhase={null} />);
    expect(stateOf('Parse')).toBe('done');
    expect(stateOf('Analyze')).toBe('done');
    expect(stateOf('Score')).toBe('done');
    expect(stateOf('Dedup check')).toBe('current');
    expect(stateOf('Review')).toBe('pending');
  });

  it('renders Review as "awaiting" (not a bare pending number) while diff_ready', () => {
    render(<JobLifecycleSteps mode="survey" status="diff_ready" stage="diff_ready" latestNarrationPhase={null} />);
    expect(stateOf('Review')).toBe('awaiting');
    expect(stateOf('Write')).toBe('pending');
    // awaiting must render visually distinct from pending, not the same state.
    expect(stateOf('Review')).not.toBe(stateOf('Write'));
  });

  it('marks Write "current" while writing, with everything before it done', () => {
    render(<JobLifecycleSteps mode="survey" status="writing" stage="writing" latestNarrationPhase={null} />);
    expect(stateOf('Review')).toBe('done');
    expect(stateOf('Write')).toBe('current');
  });

  it('marks every step done once succeeded', () => {
    render(<JobLifecycleSteps mode="survey" status="succeeded" stage="diff_ready" latestNarrationPhase={null} />);
    for (const label of ['Parse', 'Analyze', 'Score', 'Dedup check', 'Review', 'Write']) {
      expect(stateOf(label)).toBe('done');
    }
  });

  it('marks Review done and Write explicitly "skipped" (not pending) once rejected', () => {
    render(<JobLifecycleSteps mode="survey" status="rejected" stage="diff_ready" latestNarrationPhase={null} />);
    expect(stateOf('Review')).toBe('done');
    expect(stateOf('Write')).toBe('skipped');
  });

  it.each(['failed', 'cancelled'] as const)('freezes the reached step as "failed" on %s, everything before it done', (status) => {
    render(<JobLifecycleSteps mode="survey" status={status} stage={'dedup_check' as JobStage} latestNarrationPhase={null} />);
    expect(stateOf('Parse')).toBe('done');
    expect(stateOf('Dedup check')).toBe('failed');
    expect(stateOf('Review')).toBe('pending');
  });

  it.each(['failed', 'cancelled'] as const)(
    'on a terminal %s job loaded fresh (stage never set -- SSE only connects for a still-live job), falls back to latestNarrationPhase instead of defaulting to Analyze',
    (status) => {
      // Confirmed live: a job that reached infer_trace_links (deep into
      // Score/Dedup-check territory) before dying, then viewed as an
      // already-terminal page load (stage stays null -- JobDetail.tsx's SSE
      // effect never opens for a job that's already failed/cancelled),
      // showed "failed at Analyze" -- the terminal branch checked only
      // `stage`, never `latestNarrationPhase`, unlike the running branch
      // just above it.
      render(<JobLifecycleSteps mode="survey" status={status} stage={null} latestNarrationPhase="infer_trace_links" />);
      expect(stateOf('Score')).toBe('failed');
      expect(stateOf('Analyze')).toBe('done');
    },
  );
});
