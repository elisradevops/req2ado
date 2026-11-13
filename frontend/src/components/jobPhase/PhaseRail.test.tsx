import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhaseRail, type PhaseRailRow } from './PhaseRail';

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
});

