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

  it('labels by sequential array position, not the underlying figureIndex -- a gap looks like a numbering bug', () => {
    // Real live bug: figureIndex is this figure's real position among ALL
    // raw images, including ones never added to `items` at all (degenerate
    // 2x2 artifacts, or figures excluded as insignificant/failed -- see
    // JobDetail.tsx's figureCaptionStatus exclusion). Confirmed live: a
    // reviewer's first VISIBLE entry was labeled "Figure 13" even though it
    // was genuinely the first one shown, reading as broken numbering. Items
    // arrive pre-sorted by figureIndex (JobDetail.tsx's own useMemo), so
    // array position is the correct sequential display order regardless of
    // which real indices survived filtering.
    const items: FigureDescriptionEntry[] = [
      { figureIndex: 13, caption: 'First real figure', figureId: 'f12' },
      { figureIndex: 14, caption: 'Second real figure', figureId: 'f13' },
      { figureIndex: 26, caption: 'Third real figure', figureId: 'f25' },
    ];
    render(<FigureDescriptions jobId="job-1" items={items} />);
    expect(screen.getByText('Figure 1:')).toBeInTheDocument();
    expect(screen.getByText('Figure 2:')).toBeInTheDocument();
    expect(screen.getByText('Figure 3:')).toBeInTheDocument();
    expect(screen.queryByText('Figure 13:')).not.toBeInTheDocument();
    expect(screen.queryByText('Figure 14:')).not.toBeInTheDocument();
    expect(screen.queryByText('Figure 26:')).not.toBeInTheDocument();
    // The underlying figureId (used for the actual FigureImage lookup) must
    // stay the REAL id, not be renumbered -- only the display label changes.
    expect(screen.getByTestId('figure-f12')).toBeInTheDocument();
    expect(screen.getByTestId('figure-f25')).toBeInTheDocument();
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
    // Final whole-branch review finding: a bare `!text-ink-2` on the wrapper
    // <div> never actually overrides Markdown's own `text-ink-1` class on
    // the rendered <p> -- CSS !important only wins between declarations on
    // the SAME element, and the <p>'s own explicit class always applies
    // directly to itself regardless of what an ancestor declares. The real
    // fix is a `[&_p]:` arbitrary-variant class, which Tailwind necessarily
    // compiles onto this SAME ancestor <div> (compiled to a `... p { ...
    // !important }` descendant-selector rule -- verified directly against
    // the built CSS output, not assumed) -- so asserting the class here is
    // correct, but the class name itself now proves it targets the <p>,
    // unlike the old self-referential-looking `!text-ink-2`.
    const p = screen.getByText('italic').closest('p');
    const wrapper = p?.parentElement;
    expect(wrapper).toHaveClass('[&_p]:!text-ink-2');
    // The <p> itself keeps Markdown's own text-ink-1 class in the DOM (the
    // override happens via CSS cascade, not by removing this class) -- jsdom
    // has no CSS engine to assert the winning color directly, so this pins
    // the actual DOM shape the compiled selector depends on.
    expect(p).toHaveClass('text-ink-1');
  });

  it('keeps the "Figure N: " label and caption on the same line -- Markdown renders a block-level <p>', () => {
    // Regression (final whole-branch review finding): replacing the original
    // plain-text `<p><span>Figure N: </span>{caption}</p>` with a `<div>`
    // wrapping the label span plus a `<Markdown>`-rendered (block-level) <p>
    // pushed the caption onto its own line below the label -- an unintended
    // layout regression from the markdown-rendering fix. [&_p]:inline forces
    // Markdown's <p> back to inline flow so the label and caption render on
    // the same line, matching the original layout.
    const items: FigureDescriptionEntry[] = [{ figureIndex: 1, caption: 'A caption', figureId: 'f0' }];
    render(<FigureDescriptions jobId="job-1" items={items} />);
    const wrapper = screen.getByText('A caption').closest('p')?.parentElement;
    expect(wrapper).toHaveClass('[&_p]:inline');
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
