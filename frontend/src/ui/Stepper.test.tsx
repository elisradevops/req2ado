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

  it('fills the connector segment when its step is done, and leaves it empty otherwise', () => {
    render(<Stepper steps={['A', 'B', 'C']} states={['done', 'current', 'pending']} />);
    const segs = (label: string) => Array.from(screen.getByText(label).closest('li')!.querySelectorAll('[data-segment]'));
    const [segA1, segA2] = segs('A');
    const [segB1, segB2] = segs('B');

    expect(segA1).toHaveAttribute('data-filled', 'false'); // leading edge, nothing before step A
    expect(segA2).toHaveAttribute('data-filled', 'true'); // A is done -> segment into B is filled
    expect(segB1).toHaveAttribute('data-filled', 'true'); // same segment, B's side -- must agree with segA2
    expect(segB2).toHaveAttribute('data-filled', 'false'); // B is not done -> segment into C is empty
  });

  it('sweeps the line in one 240 ms pass: the first half runs linear, the second picks up where it stops and eases out', () => {
    render(<Stepper steps={['A', 'B']} states={['done', 'pending']} />);
    const first = screen.getByText('A').closest('li')!.querySelectorAll('[data-segment]')[1].firstElementChild as HTMLElement;
    const second = screen.getByText('B').closest('li')!.querySelectorAll('[data-segment]')[0].firstElementChild as HTMLElement;
    for (const half of [first, second]) {
      expect(half.className).toContain('scale-x-100');
      expect(half.className).toContain('origin-left');
      expect(half.className).toContain('rtl:origin-right');
      expect(half.style.transitionDuration).toBe('calc(var(--duration-medium) / 2)');
    }
    expect(first.style.transitionTimingFunction).toBe('linear');
    expect(first.style.transitionDelay).toBe('');
    expect(second.style.transitionTimingFunction).toBe('var(--ease-out)');
    expect(second.style.transitionDelay).toBe('calc(var(--duration-medium) / 2)');
  });

  it('empties a segment at once rather than after a delay', () => {
    render(<Stepper steps={['A', 'B']} states={['pending', 'pending']} />);
    const left = screen.getByText('B').closest('li')!.querySelectorAll('[data-segment]')[0].firstElementChild as HTMLElement;
    expect(left.className).toContain('scale-x-0');
    expect(left.style.transitionDelay).toBe('');
    expect(left.style.transitionDuration).toBe('0s');
  });

  it('draws no pulsing ring on the current step: the spinner already says work is in flight, and a ring that replays on a remount reads as a restart', () => {
    render(<Stepper steps={['A']} states={['current']} />);
    const circle = circleFor('A') as HTMLElement;
    expect(circle.className).not.toContain('pulse-ring');
    expect(circle.className).not.toContain('infinite');
  });

  it('spins the current-step icon once a second, linear, for four turns and then rests: the status text and clock carry liveness', () => {
    render(<Stepper steps={['A']} states={['current']} />);
    const icon = circleFor('A')!.querySelector('svg') as unknown as HTMLElement;
    expect(icon.style.animation).toBe('spin var(--duration-spin) linear 4');
  });

  it('hands over to a still "in progress" glyph when the turns end, so a stopped refresh arrow never reads as a retry button', () => {
    render(<Stepper steps={['A']} states={['current']} />);
    const circle = circleFor('A') as HTMLElement;
    const spinner = circle.querySelector('svg.lucide-refresh-cw') as unknown as HTMLElement;
    const rest = circle.querySelector('svg.lucide-ellipsis') as unknown as HTMLElement;
    expect(rest).not.toBeNull();
    // the arrow fades out and the dots fade in exactly when the fourth turn ends
    expect(spinner.parentElement!.style.animation).toContain('fadeOut');
    expect(spinner.parentElement!.style.animation).toContain('calc(var(--duration-spin) * 4)');
    expect(rest.parentElement!.style.animation).toContain('fadeIn');
    expect(rest.parentElement!.style.animation).toContain('calc(var(--duration-spin) * 4)');
    expect(rest.parentElement!.style.animation).toContain('both');
  });

  it('fades in a step that is added after first paint, but not the steps already there', () => {
    const { rerender } = render(<Stepper steps={['A', 'B']} states={['done', 'current']} />);
    expect(screen.getByText('A').closest('li')!.className).not.toContain('fadeIn');

    rerender(<Stepper steps={['A', 'Review', 'B']} states={['done', 'awaiting', 'pending']} />);
    expect(screen.getByText('Review').closest('li')!.className).toContain('fadeIn');
    expect(screen.getByText('A').closest('li')!.className).not.toContain('fadeIn');
    expect(screen.getByText('B').closest('li')!.className).not.toContain('fadeIn');
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

describe('Stepper accessibility text', () => {
  it('says "skipped" to assistive technology and marks the active step as the current one', () => {
    render(<Stepper steps={['One', 'Two', 'Three']} states={['done', 'awaiting', 'skipped']} />);
    expect(screen.getByText('(skipped)')).toHaveClass('sr-only');
    expect(screen.getByText('Two').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('One').closest('li')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Three').closest('li')).not.toHaveAttribute('aria-current');
  });
});
