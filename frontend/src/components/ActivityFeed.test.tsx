import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityFeed, COLLAPSED_LINES, useActivityLog, type ActivityEvent } from './ActivityFeed';
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
