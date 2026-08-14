import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FigureDescriptions, type FigureDescriptionEntry } from './FigureDescriptions';
import * as jobsApi from '../api/jobs';

vi.mock('../api/jobs');
vi.mock('./FigureImage', () => ({
  FigureImage: ({ alt, figureId, active }: { alt: string; figureId: string; active: boolean }) => (
    <div data-testid={`figure-${figureId}`} data-active={active}>
      {alt}
    </div>
  ),
}));

describe('FigureDescriptions', () => {
  it('returns null when items is empty', () => {
    const { container } = render(<FigureDescriptions jobId="job-1" items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a collapsible header with figure count', () => {
    const items: FigureDescriptionEntry[] = [
      { figureIndex: 1, caption: 'First figure', figureId: 'f0' },
      { figureIndex: 2, caption: 'Second figure', figureId: 'f1' },
    ];
    render(<FigureDescriptions jobId="job-1" items={items} />);
    expect(screen.getByText('2 figure descriptions')).toBeInTheDocument();
  });

  it('uses singular wording for a single figure', () => {
    const items: FigureDescriptionEntry[] = [{ figureIndex: 1, caption: 'A figure', figureId: 'f0' }];
    render(<FigureDescriptions jobId="job-1" items={items} />);
    expect(screen.getByText('1 figure description')).toBeInTheDocument();
  });

  it('starts collapsed by default and expands on button click', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const items: FigureDescriptionEntry[] = [{ figureIndex: 1, caption: 'A figure', figureId: 'f0' }];
    render(<FigureDescriptions jobId="job-1" items={items} />);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles expanded state on repeated button clicks', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const items: FigureDescriptionEntry[] = [{ figureIndex: 1, caption: 'A figure', figureId: 'f0' }];
    render(<FigureDescriptions jobId="job-1" items={items} />);

    const button = screen.getByRole('button');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders caption text for each figure', () => {
    const items: FigureDescriptionEntry[] = [
      { figureIndex: 1, caption: 'First figure caption', figureId: 'f0' },
      { figureIndex: 2, caption: 'Second figure caption', figureId: 'f1' },
    ];
    render(<FigureDescriptions jobId="job-1" items={items} />);
    expect(screen.getByText('First figure caption')).toBeInTheDocument();
    expect(screen.getByText('Second figure caption')).toBeInTheDocument();
  });

  it('renders the "Figure N: " label as plain text, not markdown-processed', () => {
    const items: FigureDescriptionEntry[] = [{ figureIndex: 1, caption: 'A caption', figureId: 'f0' }];
    render(<FigureDescriptions jobId="job-1" items={items} />);
    expect(screen.getByText('Figure 1:')).toBeInTheDocument();
  });

  it('renders caption markdown as real elements -- bold and italic render as <strong> and <em>', () => {
    const items: FigureDescriptionEntry[] = [
      { figureIndex: 1, caption: 'This is **bold** and _italic_ text', figureId: 'f0' },
    ];
    render(<FigureDescriptions jobId="job-1" items={items} />);

    const strong = screen.getByText('bold');
    const em = screen.getByText('italic');
    expect(strong.tagName).toBe('STRONG');
    expect(em.tagName).toBe('EM');
  });

  it('renders markdown list items in captions as real list elements', () => {
    const items: FigureDescriptionEntry[] = [
      { figureIndex: 1, caption: 'A list:\n- item one\n- item two', figureId: 'f0' },
    ];
    render(<FigureDescriptions jobId="job-1" items={items} />);

    // There are 3 total list items: 1 for the figure itself (ul li.flex.flex-col)
    // plus 2 from the markdown list in the caption. We check that the caption's
    // list items exist (that markdown was processed).
    expect(screen.getByText('item one')).toBeInTheDocument();
    expect(screen.getByText('item two')).toBeInTheDocument();
    const listItems = screen.getAllByRole('listitem');
    // 1 main figure item + 2 caption list items = 3 total
    expect(listItems.length).toBeGreaterThanOrEqual(2);
  });

  it('passes active={false} to FigureImage while collapsed', () => {
    const items: FigureDescriptionEntry[] = [{ figureIndex: 1, caption: 'A figure', figureId: 'f0' }];
    render(<FigureDescriptions jobId="job-1" items={items} />);

    expect(screen.getByTestId('figure-f0')).toHaveAttribute('data-active', 'false');
  });

  it('passes active={true} to FigureImage once expanded at least once', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const items: FigureDescriptionEntry[] = [{ figureIndex: 1, caption: 'A figure', figureId: 'f0' }];
    render(<FigureDescriptions jobId="job-1" items={items} />);

    expect(screen.getByTestId('figure-f0')).toHaveAttribute('data-active', 'false');

    await user.click(screen.getByRole('button'));
    expect(screen.getByTestId('figure-f0')).toHaveAttribute('data-active', 'true');
  });

  it('keeps active={true} for FigureImage even after collapsing (lazy-load once, never re-fetch)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const items: FigureDescriptionEntry[] = [{ figureIndex: 1, caption: 'A figure', figureId: 'f0' }];
    render(<FigureDescriptions jobId="job-1" items={items} />);

    await user.click(screen.getByRole('button'));
    expect(screen.getByTestId('figure-f0')).toHaveAttribute('data-active', 'true');

    await user.click(screen.getByRole('button'));
    // hasExpandedOnce is still true, so active stays true even though the panel is collapsed
    expect(screen.getByTestId('figure-f0')).toHaveAttribute('data-active', 'true');
  });
});
