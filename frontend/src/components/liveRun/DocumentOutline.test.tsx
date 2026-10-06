import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentOutline, MAX_OUTLINE_HEIGHT, ROW_HEIGHT } from './DocumentOutline';
import type { MapItem } from '../../api/liveTypes';

const item = (n: number, depth = 0): MapItem => ({ ref: `r${n}`, title: `Item ${n}`, words: n * 10, depth, type: null });

describe('DocumentOutline', () => {
  const items = [item(1), item(2, 1), item(3, 2), item(4, 2)];

  it('marks what is written, what is in progress and what is waiting, in words as well as glyphs', () => {
    render(<DocumentOutline items={items} doneRefs={{ r1: {}, r2: {} }} workingRefs={new Set(['r3'])} truncated={false} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Written: Item 1');
    expect(rows[2]).toHaveTextContent('In progress: Item 3');
    expect(rows[3]).toHaveTextContent('Waiting: Item 4');
    expect(rows[2]).toHaveAttribute('aria-current', 'step');
    expect(rows[0]).not.toHaveAttribute('aria-current');
  });

  it('gives the scrolling region an accessible name that carries the count', () => {
    render(<DocumentOutline items={items} doneRefs={{ r1: {} }} workingRefs={new Set()} truncated={false} />);
    expect(screen.getByRole('region', { name: 'Document outline, 1 of 4 written' })).toBeInTheDocument();
  });

  it('shows the word count of each item', () => {
    render(<DocumentOutline items={items} doneRefs={{}} workingRefs={new Set()} truncated={false} />);
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('is read-only: its rows take no focus, and the scrolling region is its one tab stop so the keyboard can scroll it', () => {
    const { container } = render(<DocumentOutline items={items} doneRefs={{}} workingRefs={new Set()} truncated={false} />);
    expect(container.querySelectorAll('li button, li a, li input, li select, li textarea, li [tabindex]')).toHaveLength(0);
    const stops = container.querySelectorAll('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAttribute('role', 'region');
  });

  it('renders only a window of rows for a very large outline', () => {
    const big = Array.from({ length: 5000 }, (_, i) => item(i));
    render(<DocumentOutline items={big} doneRefs={{}} workingRefs={new Set()} truncated />);
    expect(screen.getAllByRole('listitem').length).toBeLessThan(40);
    expect(screen.getByText(/Showing the first part of the outline/)).toBeInTheDocument();
  });

  it('caps its height so it never pushes the rest of the banner off screen, and shrinks for a short outline', () => {
    const { container, rerender } = render(
      <DocumentOutline items={Array.from({ length: 400 }, (_, i) => item(i))} doneRefs={{}} workingRefs={new Set()} truncated={false} />,
    );
    const list = container.querySelector('ul')?.parentElement as HTMLElement;
    expect(list.style.height).toBe(`${MAX_OUTLINE_HEIGHT}px`);
    rerender(<DocumentOutline items={[item(1)]} doneRefs={{}} workingRefs={new Set()} truncated={false} />);
    expect((container.querySelector('ul')?.parentElement as HTMLElement).style.height).toBe(`${ROW_HEIGHT}px`);
  });

  it('indents by depth but stops indenting after a few levels', () => {
    render(<DocumentOutline items={[item(1, 0), item(2, 3), item(3, 40)]} doneRefs={{}} workingRefs={new Set()} truncated={false} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0].style.paddingLeft).toBe('8px');
    expect(rows[1].style.paddingLeft).toBe('44px');
    expect(rows[2].style.paddingLeft).toBe('68px');
  });
});
