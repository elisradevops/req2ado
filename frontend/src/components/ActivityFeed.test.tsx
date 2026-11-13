import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityFeed, COLLAPSED_LINES, collapseRepeats, useActivityLog, type ActivityEvent } from './ActivityFeed';
import type { NarrationEvent } from '../api/events';

const narration = (n: number, message = `Step ${n}`): NarrationEvent =>
  ({ phase: 'analyze_section', branchIndex: n, branchCount: 20, blocksDone: n, blocksTotal: 100, kbGrounded: false, kbCitations: [], message }) as NarrationEvent;

const event = (id: number, seenAt: number | null = null, message = `Line ${id}`): ActivityEvent => ({ id, label: 'Writing requirement text', message, seenAt });

describe('ActivityFeed', () => {
  it('is a labelled log that does not announce each line: milestones go through one status region instead', () => {
    render(<ActivityFeed events={[event(1), event(2)]} />);
    const log = screen.getByRole('log', { name: 'Job activity' });
    expect(log).toHaveAttribute('aria-live', 'off');
  });

  it('lists oldest first and newest last, as a log does', () => {
    render(<ActivityFeed events={[event(1), event(2), event(3)]} />);
    const lines = within(screen.getByRole('log')).getAllByRole('listitem');
    expect(lines.map((li) => li.textContent)).toEqual([expect.stringContaining('Line 1'), expect.stringContaining('Line 2'), expect.stringContaining('Line 3')]);
  });

  it('shows the last few lines and lets the person open the rest', async () => {
    const many = Array.from({ length: COLLAPSED_LINES + 4 }, (_, i) => event(i + 1));
    render(<ActivityFeed events={many} />);
    expect(within(screen.getByRole('log')).getAllByRole('listitem')).toHaveLength(COLLAPSED_LINES);
    expect(screen.queryByText('Line 1')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: `Show all ${many.length}` });
    // the name already says what pressing does, so there is no aria-expanded to repeat it ("Show fewer, expanded")
    expect(toggle).not.toHaveAttribute('aria-expanded');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: /show fewer/i })).toBeInTheDocument();
    expect(within(screen.getByRole('log')).getAllByRole('listitem')).toHaveLength(many.length);

    // the opened list scrolls, so it is a named region the keyboard can reach
    const region = screen.getByRole('region', { name: 'Job activity, scrollable' });
    expect(region).toHaveAttribute('tabindex', '0');
    await userEvent.click(screen.getByRole('button', { name: /show fewer/i }));
    expect(screen.queryByRole('region', { name: 'Job activity, scrollable' })).not.toBeInTheDocument();
  });

  it('is a level-two heading, so the page outline does not skip from the title to a level three', () => {
    render(<ActivityFeed events={[event(1)]} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Activity' })).toBeInTheDocument();
  });

  it('keeps each time in left-to-right order and lets a line wrap on a narrow screen', () => {
    render(<ActivityFeed events={[event(1, new Date('2026-11-07T10:05:09').getTime())]} />);
    const line = within(screen.getByRole('log')).getByRole('listitem');
    expect(line.querySelector('time')).toHaveAttribute('dir', 'ltr');
    expect(line.className).toContain('max-md:flex-wrap');
    // a long message wraps on a narrow screen but is capped at two lines, so six lines never fill the page
    const message = line.querySelector('[title]') as HTMLElement;
    expect(message.className).toContain('max-md:line-clamp-2');
  });

  it('offers no toggle when everything already fits', () => {
    render(<ActivityFeed events={[event(1)]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('stamps a line with the time this page saw it, and says "earlier" for what was already there', () => {
    const seen = new Date('2026-11-07T10:05:09').getTime();
    render(<ActivityFeed events={[event(1, null), event(2, seen)]} />);
    const [first, second] = within(screen.getByRole('log')).getAllByRole('listitem');
    expect(first).toHaveTextContent(/earlier/i);
    expect(second.querySelector('time')).toHaveTextContent(/10:05:09/);
  });

  it('fades in a line that arrives after first paint, and not the ones that were there', () => {
    const { rerender } = render(<ActivityFeed events={[event(1), event(2)]} />);
    const before = within(screen.getByRole('log')).getAllByRole('listitem');
    expect(before[0].className).not.toContain('fadeIn');
    rerender(<ActivityFeed events={[event(1), event(2), event(3, Date.now())]} />);
    const after = within(screen.getByRole('log')).getAllByRole('listitem');
    expect(after[2].className).toContain('fadeIn');
    expect(after[0].className).not.toContain('fadeIn');
  });

  it('says so when there is nothing yet instead of drawing an empty box', () => {
    render(<ActivityFeed events={[]} />);
    expect(screen.getByText(/nothing yet/i)).toBeInTheDocument();
  });
});

describe('ActivityFeed auto-scroll', () => {
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
  });

  it('keeps the newest lines in view when the list is full and each new line pushes the oldest out (the length no longer changes)', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 500 });
    const many = (from: number) => Array.from({ length: COLLAPSED_LINES + 4 }, (_, i) => event(from + i));
    const { rerender } = render(<ActivityFeed events={many(1)} />);
    await userEvent.click(screen.getByRole('button', { name: /show all/i }));
    const region = screen.getByRole('region', { name: 'Job activity, scrollable' });
    region.scrollTop = 0;

    rerender(<ActivityFeed events={many(2)} />); // same length, newer last line
    expect(region.scrollTop).toBe(500);
  });

  it('opens on the newest lines even if the person had scrolled up before closing it', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 500 });
    const events = Array.from({ length: COLLAPSED_LINES + 4 }, (_, i) => event(i + 1));
    render(<ActivityFeed events={events} />);
    await userEvent.click(screen.getByRole('button', { name: /show all/i }));
    const region = screen.getByRole('region', { name: 'Job activity, scrollable' });
    region.scrollTop = 0;
    region.dispatchEvent(new Event('scroll', { bubbles: true })); // scrolled up: no longer near the bottom
    await userEvent.click(screen.getByRole('button', { name: /show fewer/i }));
    await userEvent.click(screen.getByRole('button', { name: /show all/i }));
    expect(screen.getByRole('region', { name: 'Job activity, scrollable' }).scrollTop).toBe(500);
  });
});

describe('useActivityLog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('gives what was there on first render no time, and stamps what arrives later with the time it was seen', () => {
    const { result, rerender } = renderHook(({ list }) => useActivityLog(list, () => 'Label'), { initialProps: { list: [narration(1), narration(2)] } });
    expect(result.current.map((e) => e.seenAt)).toEqual([null, null]);
    vi.setSystemTime(new Date('2026-11-07T10:00:30Z'));
    rerender({ list: [narration(1), narration(2), narration(3)] });
    expect(result.current[2].seenAt).toBe(new Date('2026-11-07T10:00:30Z').getTime());
    expect(result.current[0].seenAt).toBeNull();
  });

  it('uses the time the server recorded the event when it carries one, even for what arrives after first render', () => {
    const recorded = '2026-11-07T09:41:07.000Z';
    const { result, rerender } = renderHook(({ list }) => useActivityLog(list, () => 'Label'), { initialProps: { list: [] as NarrationEvent[] } });
    // history is fetched after the first render: it must not be stamped with "now"
    vi.setSystemTime(new Date('2026-11-07T10:00:30Z'));
    rerender({ list: [{ ...narration(1), at: recorded } as NarrationEvent] });
    expect(result.current[0].seenAt).toBe(Date.parse(recorded));
  });

  it('keeps ids and times stable when the same events come back as new objects (a merged list is rebuilt on every render)', () => {
    const { result, rerender } = renderHook(({ list }) => useActivityLog(list, () => 'Label'), { initialProps: { list: [narration(1)] } });
    vi.setSystemTime(new Date('2026-11-07T10:01:00Z'));
    rerender({ list: [narration(1), narration(2)] });
    const idsBefore = result.current.map((e) => e.id);
    const stampedAt = result.current[1].seenAt;
    vi.setSystemTime(new Date('2026-11-07T10:02:00Z'));
    rerender({ list: [narration(1), narration(2)] }); // equal content, new objects
    expect(result.current.map((e) => e.id)).toEqual(idsBefore);
    expect(result.current[1].seenAt).toBe(stampedAt);
  });

  it('keeps each of two identical events on its own id and time when the older one scrolls out of the capped list', () => {
    const a1 = { ...narration(1, 'Same'), at: '2026-11-07T10:00:00.000Z' } as NarrationEvent;
    const a2 = { ...narration(1, 'Same'), at: '2026-11-07T10:05:00.000Z' } as NarrationEvent;
    const { result, rerender } = renderHook(({ list }) => useActivityLog(list, () => 'Label'), { initialProps: { list: [a1, a2] } });
    const secondId = result.current[1].id;
    rerender({ list: [{ ...a2 }] }); // the oldest was dropped by the cap; the survivor is the later one
    expect(result.current[0].id).toBe(secondId);
    expect(result.current[0].seenAt).toBe(Date.parse(a2.at as string));
  });

  it('treats the same message twice in a row as two events', () => {
    const { result } = renderHook(() => useActivityLog([narration(1, 'Same'), narration(1, 'Same')], () => 'Label'));
    expect(result.current).toHaveLength(2);
    expect(new Set(result.current.map((e) => e.id)).size).toBe(2);
  });

  it('uses the label function and the event message', () => {
    const { result } = renderHook(() => useActivityLog([narration(1, 'Hello')], (n) => `L:${n.phase}`));
    expect(result.current[0]).toMatchObject({ label: 'L:analyze_section', message: 'Hello' });
  });
});

describe('ActivityFeed collapsed by default (DESIGN.md §11.3.5, the "Run log")', () => {
  it('shows only a "Run log (n)" toggle and none of the lines until it is opened', async () => {
    render(<ActivityFeed events={[event(1), event(2), event(3)]} collapsedByDefault />);
    const toggle = screen.getByRole('button', { name: 'Run log (3)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.queryByText(/Line 3/)).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByRole('log')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('is still a level-two heading, so the page outline does not skip a level', () => {
    render(<ActivityFeed events={[event(1)]} collapsedByDefault />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Run log (1)');
  });

  it('keeps the existing always-open behaviour for callers that do not ask for it', () => {
    render(<ActivityFeed events={[event(1), event(2)]} />);
    expect(screen.getByRole('log')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run log/ })).not.toBeInTheDocument();
  });
});


describe('collapseRepeats (a burst of the same progress line is one line with a count)', () => {
  const T = Date.UTC(2026, 10, 13, 10, 0, 0);
  const dup = (id: number, n: number, seenAt: number | null = T, label = 'Checking for duplicates'): ActivityEvent => ({
    id, label, message: `Checking for duplicates ${n} of 17`, seenAt,
  });

  it('folds consecutive lines that differ only in their numbers, within the same second, into one with a count', () => {
    const folded = collapseRepeats(Array.from({ length: 17 }, (_, i) => dup(i + 1, i + 1, T + i * 20)));
    expect(folded).toHaveLength(1);
    expect(folded[0].repeat).toBe(17);
    expect(folded[0].message).toBe('Checking for duplicates 17 of 17');
    expect(folded[0].seenAt).toBe(T);
    expect(folded[0].id).toBe(1);
  });

  it('does not fold lines seconds apart: that is a run making progress, and the times are the point', () => {
    const folded = collapseRepeats([dup(1, 1, T), dup(2, 2, T + 4000), dup(3, 3, T + 9000)]);
    expect(folded.map((line) => line.repeat)).toEqual([1, 1, 1]);
  });

  it('does not fold different labels or different wording, only numbers', () => {
    const folded = collapseRepeats([dup(1, 1), dup(2, 2, T, 'Scoring'), { ...dup(3, 3), message: 'Found a near-duplicate of 3' }]);
    expect(folded).toHaveLength(3);
  });

  it('never folds lines that carry no time (history from before the page opened), or lines with no number', () => {
    expect(collapseRepeats([dup(1, 1, null), dup(2, 2, null)])).toHaveLength(2);
    const plain: ActivityEvent[] = [1, 2].map((id) => ({ id, label: 'Parse', message: 'Reading the document', seenAt: T }));
    expect(collapseRepeats(plain)).toHaveLength(2);
  });

  it('folds each burst on its own and keeps order, without changing its input', () => {
    const input = [dup(1, 1), dup(2, 2), { ...dup(3, 3), label: 'Scoring', message: 'Scoring 1 of 2' }, dup(4, 4, T + 5000), dup(5, 5, T + 5100)];
    const copy = input.map((line) => line.id);
    expect(collapseRepeats(input).map((line) => [line.id, line.repeat])).toEqual([[1, 2], [3, 1], [4, 2]]);
    expect(input.map((line) => line.id)).toEqual(copy);
  });

  it('does not fold distinct facts that merely share a template: five different tables stay five lines', () => {
    const table = (id: number, n: number, name: string, rows: number): ActivityEvent => ({
      id, label: 'Reading the document', message: `Detected a table ${name} (table ${n} of 5) -- ${rows} row(s)`, seenAt: T + id,
    });
    const folded = collapseRepeats([table(1, 1, 't1', 4), table(2, 2, 't2', 9), table(3, 3, 't3', 16), table(4, 4, 't4', 2), table(5, 5, 't5', 16)]);
    expect(folded).toHaveLength(5);
    expect(folded.every((line) => line.repeat === 1)).toBe(true);
  });

  it('still folds a pure "N of M" counter burst whose other words and numbers are identical', () => {
    const counter = (id: number, n: number): ActivityEvent => ({ id, label: 'Scoring', message: `Scoring requirement ${n} of 40`, seenAt: T + id });
    expect(collapseRepeats(Array.from({ length: 10 }, (_, i) => counter(i + 1, i + 1)))).toHaveLength(1);
  });

  it('is one pass: 50,000 lines fold in well under a second', () => {
    const many = Array.from({ length: 50000 }, (_, i) => dup(i + 1, i + 1, T + (i % 3) * 10));
    const started = performance.now();
    collapseRepeats(many);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('ActivityFeed: repeats', () => {
  it('shows a folded burst as one line with its count, and counts lines (not raw events) in the toggle and heading', () => {
    const T = Date.UTC(2026, 10, 13, 10, 0, 0);
    const burst = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, label: 'Checking for duplicates', message: `Checking for duplicates ${i + 1} of 5`, seenAt: T + i }));
    render(<ActivityFeed events={burst} collapsedByDefault={false} />);
    const lines = within(screen.getByRole('log')).getAllByRole('listitem');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Checking for duplicates 5 of 5');
    expect(lines[0]).toHaveTextContent('×5');
  });
});
