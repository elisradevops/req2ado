import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stepper, type StepState } from './Stepper';

function circleFor(label: string): Element | null | undefined {
  return screen.getByText(label).closest('li')?.querySelector('[data-state]');
}

describe('Stepper states prop', () => {
  const cases: { state: StepState; expectIconClass: string | null }[] = [
    { state: 'done', expectIconClass: 'lucide-check' },
    { state: 'current', expectIconClass: 'lucide-refresh-cw' },
    { state: 'awaiting', expectIconClass: null },
    { state: 'pending', expectIconClass: null },
    { state: 'failed', expectIconClass: 'lucide-x' },
    { state: 'skipped', expectIconClass: null },
  ];

  it.each(cases)('renders the $state icon/data-state on its own circle', ({ state, expectIconClass }) => {
    render(<Stepper steps={['Only step']} states={[state]} />);
    const circle = circleFor('Only step');
    expect(circle).toHaveAttribute('data-state', state);
    if (expectIconClass) {
      expect(circle?.querySelector('svg')).toHaveClass(expectIconClass);
    } else {
      // awaiting/pending/skipped show the 1-based step number, not an icon.
      expect(circle?.querySelector('svg')).toBeNull();
      expect(circle?.textContent).toBe('1');
    }
  });

  it('renders a sub-label chip under a step when one is given, and nothing when omitted', () => {
    render(<Stepper steps={['A', 'B']} states={['current', 'pending']} subLabels={['pass 1 of 2 · synthesizing text', null]} />);
    expect(screen.getByText('pass 1 of 2 · synthesizing text')).toBeInTheDocument();
    expect(screen.getByText('A').closest('li')?.textContent).toContain('pass 1 of 2 · synthesizing text');
    expect(screen.getByText('B').closest('li')?.querySelector('.text-accent-ink')).toBeNull();
  });

  it('gives skipped steps a struck-through label, unlike pending', () => {
    render(<Stepper steps={['A', 'B']} states={['skipped', 'pending']} />);
    expect(screen.getByText('A').className).toContain('line-through');
    expect(screen.getByText('B').className).not.toContain('line-through');
  });

  it('colors the connector segment ok when its step is done, hairline otherwise', () => {
    render(<Stepper steps={['A', 'B', 'C']} states={['done', 'current', 'pending']} />);
    const [segA1, segA2] = Array.from(screen.getByText('A').closest('li')!.querySelectorAll('span.h-px'));
    const [segB1, segB2] = Array.from(screen.getByText('B').closest('li')!.querySelectorAll('span.h-px'));

    expect(segA1.className).toContain('bg-transparent'); // leading edge, nothing before step A
    expect(segA2.className).toContain('bg-ok'); // A is done -> segment into B is ok
    expect(segB1.className).toContain('bg-ok'); // same segment, B's side -- must agree with segA2
    expect(segB2.className).toContain('bg-hairline-strong'); // B is not done -> segment into C is not ok
  });
});

describe('Stepper legacy activeIndex API', () => {
  it('still renders done/current/pending from a bare activeIndex, with no states prop', () => {
    render(<Stepper steps={['Parse', 'Analyze', 'Score']} activeIndex={1} activeSpinner />);
    expect(circleFor('Parse')).toHaveAttribute('data-state', 'done');
    expect(circleFor('Analyze')).toHaveAttribute('data-state', 'current');
    expect(circleFor('Score')).toHaveAttribute('data-state', 'pending');
  });

  it('renders the active step as "awaiting" (not "current") when activeSpinner is false', () => {
    render(<Stepper steps={['Upload', 'Configure']} activeIndex={1} />);
    expect(circleFor('Upload')).toHaveAttribute('data-state', 'done');
    expect(circleFor('Configure')).toHaveAttribute('data-state', 'awaiting');
  });

  it('applies a per-step color override from `colors` on done/current/awaiting steps', () => {
    render(<Stepper steps={['A', 'B']} activeIndex={0} colors={['#123456', '#abcdef']} />);
    const circle = circleFor('A');
    expect(circle).toHaveStyle({ backgroundColor: '#123456', borderColor: '#123456' });
  });
});
