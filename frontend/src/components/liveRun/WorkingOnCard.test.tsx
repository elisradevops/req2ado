import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { STALE_AFTER_MS, WorkingOnCard } from './WorkingOnCard';
import type { FinishedItem, LaneState } from '../../store/liveRunStore';

const NOW = 1_000_000;
const lane = (n: number, extra: Partial<LaneState> = {}): LaneState => ({
  lane: n, kind: 'working_on', ref: `r${n}`, title: `Title ${n}`, excerpt: `Excerpt ${n}`, itemType: null,
  page: null, pages: null, seq: n, receivedAt: NOW - 1000, ...extra,
});
const finished = (n: number): FinishedItem => ({ ref: `r${n}`, title: `Done ${n}`, itemType: null, lane: 0, seq: n });

describe('WorkingOnCard', () => {
  it('shows what the model is on and an excerpt of the document', () => {
    render(<WorkingOnCard lanes={[lane(0)]} recent={[]} now={NOW} />);
    expect(screen.getByText('Title 0')).toBeInTheDocument();
    expect(screen.getByTestId('working-on-excerpt')).toHaveTextContent('Excerpt 0');
    expect(screen.getByText('Now')).toBeInTheDocument();
  });

  it('says "an item" rather than show an internal id when nothing names the item', () => {
    const { container } = render(<WorkingOnCard lanes={[lane(0, { title: null, ref: 'det0_1_1_1' })]} recent={[]} now={NOW} />);
    expect(screen.getByText('an item')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/det\d+_/);
  });

  it('leaves out of "just finished" any item known only by its id', () => {
    const nameless: FinishedItem = { ref: 'det0_9', title: null, itemType: null, lane: 0, seq: 9 };
    const { rerender } = render(<WorkingOnCard lanes={[lane(0)]} recent={[nameless, finished(3)]} now={NOW} />);
    expect(screen.getByTestId('just-finished')).toHaveTextContent('Just finished: Done 3');
    expect(screen.getByTestId('just-finished').textContent).not.toContain('det0_9');
    rerender(<WorkingOnCard lanes={[lane(0)]} recent={[nameless]} now={NOW} />);
    expect(screen.queryByTestId('just-finished')).not.toBeInTheDocument();
  });

  it('uses the heading from the document map when a frame carries only an id', () => {
    const titles = new Map([['r0', 'Output ripple'], ['r9', 'Faults']]);
    render(<WorkingOnCard lanes={[lane(0, { title: null })]} recent={[finished(9)]} now={NOW} titleByRef={titles} />);
    expect(screen.getByText('Output ripple')).toBeInTheDocument();
    expect(screen.getByTestId('just-finished')).toHaveTextContent('Done 9');
  });

  it('is absent when there is nothing real to show, instead of a fixed sentence that never changes', () => {
    render(<WorkingOnCard lanes={[]} recent={[]} now={NOW} />);
    expect(screen.queryByTestId('working-on-card')).not.toBeInTheDocument();
  });

  it('shows the current batch of a step with no live lane: what it does, its pass, its items and how long', () => {
    render(
      <WorkingOnCard
        lanes={[]}
        recent={[]}
        now={NOW}
        current={{ line: 'Scoring requirement batch 2 of 3', pass: 'vote 2 of 2', titles: ['Input voltage', 'Transient'], elapsedLabel: '0:41' }}
      />,
    );
    const current = screen.getByTestId('working-on-current');
    expect(current).toHaveTextContent('Scoring requirement batch 2 of 3 · vote 2 of 2');
    expect(current).toHaveTextContent('Input voltage');
    expect(current).toHaveTextContent('0:41 so far');
  });

  it('hides the excerpt and says it is still waiting once a frame is older than 15 seconds', () => {
    render(<WorkingOnCard lanes={[lane(0, { receivedAt: NOW - STALE_AFTER_MS - 1 })]} recent={[]} now={NOW} />);
    expect(screen.queryByTestId('working-on-excerpt')).not.toBeInTheDocument();
    expect(screen.getByText('Still waiting on the model for this step.')).toBeInTheDocument();
    expect(screen.getByText('Title 0')).toBeInTheDocument();
  });

  it('shows parallel parts together, ordered by lane, and counts the ones it does not list', () => {
    render(<WorkingOnCard lanes={[lane(2), lane(0), lane(1), lane(3), lane(4)]} recent={[]} now={NOW} />);
    expect(screen.getByText('5 parts in parallel')).toBeInTheDocument();
    const rows = screen.getAllByTestId('working-on-lane');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Title 0'), expect.stringContaining('Title 1'), expect.stringContaining('Title 2'),
    ]);
    expect(screen.getByText('and 2 more in progress')).toBeInTheDocument();
  });

  it('shows a scanned page as "page N of M" with its excerpt', () => {
    render(<WorkingOnCard lanes={[lane(0, { kind: 'ocr_page', title: null, ref: null, page: 4, pages: 10, excerpt: 'Section 4 text' })]} recent={[]} now={NOW} />);
    expect(screen.getByText('Reading page 4 of 10')).toBeInTheDocument();
    expect(screen.getByText('Section 4 text')).toBeInTheDocument();
  });

  it('lists what just finished', () => {
    render(<WorkingOnCard lanes={[lane(0)]} recent={[finished(3), finished(2)]} now={NOW} />);
    expect(screen.getByTestId('just-finished')).toHaveTextContent('Just finished: Done 3 · Done 2');
  });

  it('has an explanation that the excerpt is not stored', () => {
    render(<WorkingOnCard lanes={[lane(0)]} recent={[]} now={NOW} />);
    expect(screen.getByRole('button', { name: 'About the excerpt' })).toBeInTheDocument();
  });
});
