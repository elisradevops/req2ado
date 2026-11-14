import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { PhaseRail, type PhaseRailRow } from './PhaseRail';
import { ProgressBanner } from '../ProgressBanner';
import { lifecyclePhases } from '../JobLifecycleSteps';
import { stepSubLabelsFor } from '../../utils/liveStage';
import { FLUSH_INTERVAL_MS, useLiveRunStore } from '../../store/liveRunStore';
import { LIVE_RUN_SEQUENCE } from '../../test/fixtures/liveRunSequence';
import type { JobStage, NarrationEvent } from '../../api/events';

vi.mock('../../api/runMap', () => ({ getRunMap: vi.fn().mockResolvedValue(null), getRunDone: vi.fn().mockResolvedValue(null) }));

const ROWS: PhaseRailRow[] = [
  { key: 'parse', label: 'Parse', state: 'done', line: '12 blocks · 0 figures' },
  { key: 'analyze', label: 'Analyze', state: 'current', line: '7 of 18 sections' },
  { key: 'score', label: 'Score', state: 'pending', line: 'Judges each requirement' },
  { key: 'review', label: 'Review', state: 'pending', line: 'Your approval' },
];

function mount(selectedKey: 'parse' | 'analyze' | 'score' | 'review' = 'analyze', onSelect = vi.fn()) {
  render(<PhaseRail rows={ROWS} selectedKey={selectedKey} liveKey="analyze" onSelect={onSelect} />);
  return onSelect;
}

describe('PhaseRail', () => {
  it('is a vertical tab list with one tab per phase, and exactly one selected', () => {
    mount();
    expect(screen.getByRole('tablist', { name: 'Run phases' })).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: /Analyze/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Parse/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('says what each phase produced, is at, or is for, in words under its name', () => {
    mount();
    expect(screen.getByText('12 blocks · 0 figures')).toBeInTheDocument();
    expect(screen.getByText('7 of 18 sections')).toBeInTheDocument();
    expect(screen.getByText('Judges each requirement')).toBeInTheDocument();
  });

  it('marks only the running phase as live, in words', () => {
    mount();
    expect(screen.getAllByText('● Live')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /Analyze/ })).toHaveTextContent('Live');
  });

  it('selects a phase on click, pending ones included, because a pending phase has content', async () => {
    const onSelect = mount();
    await userEvent.click(screen.getByRole('tab', { name: /Score/ }));
    expect(onSelect).toHaveBeenCalledWith('score');
  });

  it('keeps only the selected tab in the tab order (roving tabindex)', () => {
    mount('analyze');
    expect(screen.getByRole('tab', { name: /Analyze/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /Parse/ })).toHaveAttribute('tabindex', '-1');
  });

  it('moves with the arrow keys, wrapping, and Home and End', async () => {
    const onSelect = mount('analyze');
    screen.getByRole('tab', { name: /Analyze/ }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith('score');
    await userEvent.keyboard('{ArrowUp}'); // focus followed the first key press, so Up goes back to Analyze
    expect(onSelect).toHaveBeenLastCalledWith('analyze');
    await userEvent.keyboard('{End}');
    expect(onSelect).toHaveBeenLastCalledWith('review');
    await userEvent.keyboard('{Home}');
    expect(onSelect).toHaveBeenLastCalledWith('parse');
  });

  it('wraps from the last phase to the first', async () => {
    const onSelect = mount('review');
    screen.getByRole('tab', { name: /Review/ }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith('parse');
  });

  it('also answers Left and Right, because below lg the rail is drawn as a horizontal strip', async () => {
    const onSelect = mount('analyze');
    screen.getByRole('tab', { name: /Analyze/ }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenLastCalledWith('score');
    await userEvent.keyboard('{ArrowLeft}');
    expect(onSelect).toHaveBeenLastCalledWith('analyze');
  });

  // Research #4 (DESIGN.md §8.3): when the run moves on, the finished phase's check and the new current phase cross-fade in once
  // (--motion-milestone). The page's one polite status region already says the step changed, so the rail adds no second one.
  it('fades in the glyph of a phase that changed state after first paint, and nothing on first paint', () => {
    const { container, rerender } = render(<PhaseRail rows={ROWS} selectedKey="analyze" liveKey="analyze" onSelect={vi.fn()} />);
    expect(container.querySelectorAll('[data-phase-advance]')).toHaveLength(0);
    const next: PhaseRailRow[] = ROWS.map((row) =>
      row.key === 'analyze' ? { ...row, state: 'done' } : row.key === 'score' ? { ...row, state: 'current' } : row,
    );
    rerender(<PhaseRail rows={next} selectedKey="score" liveKey="score" onSelect={vi.fn()} />);
    const advanced = Array.from(container.querySelectorAll('[data-phase-advance]'));
    expect(advanced.map((el) => el.getAttribute('data-phase-advance'))).toEqual(['analyze', 'score']);
    for (const el of advanced) expect(el.className).toContain('animate-[fadeIn_var(--motion-milestone)_var(--ease-out)_backwards]');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  // QA P2: the rail and the banner card are fed the same replayed events and must name the same stage at every step. The rows
  // are built the way JobDetail builds them (lifecyclePhases + stepSubLabelsFor, current row: its line or "In progress").
  it('names the same stage as the banner card at every step of a replayed live run', () => {
    vi.useFakeTimers();
    useLiveRunStore.getState().reset();
    useLiveRunStore.getState().begin('job-1');
    try {
      let stage: JobStage = 'parse';
      let narrations: NarrationEvent[] = [];
      const page = () => {
        const latest = narrations.at(-1) ?? null;
        const model = lifecyclePhases('survey', 'running', stage, latest?.phase ?? null);
        const lines = stepSubLabelsFor(latest);
        const rows: PhaseRailRow[] = model.phases.map((phase) => ({
          key: phase.key, label: phase.label, state: phase.state,
          line: phase.state === 'current' ? (lines[phase.key] ?? 'In progress') : phase.purpose,
        }));
        return (
          <>
            <PhaseRail rows={rows} selectedKey={model.liveKey} liveKey={model.liveKey} onSelect={vi.fn()} />
            <ProgressBanner stage={stage} status="running" startedAt="2026-11-13T09:00:00Z" mode="survey" narrations={narrations} />
          </>
        );
      };
      const view = render(page());
      for (const { step, expect: want } of LIVE_RUN_SEQUENCE) {
        if (step.kind === 'stage') stage = step.stage;
        else if (step.kind === 'narration') narrations = [...narrations, step.event];
        else {
          act(() => {
            useLiveRunStore.getState().ingestProgress(step.event);
            vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
          });
        }
        view.rerender(page());
        const live = screen.getAllByRole('tab').find((tab) => tab.textContent?.includes('Live'))!;
        const headline = document.querySelector('p.text-title')?.textContent;
        expect(headline).toBe(want.label);
        expect(live).toHaveTextContent(new RegExp(`^${want.label}`));
        if (want.line) {
          expect(live).toHaveTextContent(want.line);
          expect(screen.getByTestId('stage-line')).toHaveTextContent(want.line);
        }
      }
    } finally {
      useLiveRunStore.getState().reset();
      vi.useRealTimers();
    }
  });
});
