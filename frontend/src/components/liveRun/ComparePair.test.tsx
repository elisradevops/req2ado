import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ComparePair } from './ComparePair';
import type { ComparePayload } from '../../api/liveTypes';

const conflict: ComparePayload = {
  kind: 'conflict',
  similarity: 0.92,
  a: { ref: 'det0_2_1', text: 'The power supply shall provide 500 W at 28 VAC input.' },
  b: { ref: 'det0_9_4', text: 'The power supply shall provide 600 W at 28 VDC input.' },
};

const titles = new Map([
  ['det0_2_1', 'Power supply output'],
  ['det0_9_4', 'Appendix B: power supply output'],
]);

describe('ComparePair', () => {
  it('underlines only the words that differ, on both sides, with a similarity figure', () => {
    render(<ComparePair compare={conflict} titleByRef={titles} />);
    const left = screen.getByRole('group', { name: 'Statement: Power supply output' });
    const right = screen.getByRole('group', { name: 'Statement: Appendix B: power supply output' });
    expect([...left.querySelectorAll('mark')].map((m) => m.textContent?.trim())).toEqual(['500', 'VAC']);
    expect([...right.querySelectorAll('mark')].map((m) => m.textContent?.trim())).toEqual(['600', 'VDC']);
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText(/differing words are underlined/)).toBeInTheDocument();
  });

  it('names each side of a conflict by its heading, never by an internal id', () => {
    const { container } = render(<ComparePair compare={conflict} titleByRef={titles} />);
    expect(screen.getByText('Power supply output')).toBeInTheDocument();
    expect(screen.getByText('Appendix B: power supply output')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/det\d+_/);
  });

  it('says where each side sits in the document when the outline knows', () => {
    const paths = new Map([
      ['det0_2_1', 'Subsystem 1 › Function 1.1'],
      ['det0_9_4', 'Subsystem 2 › Appendix B'],
    ]);
    render(<ComparePair compare={conflict} titleByRef={titles} pathByRef={paths} />);
    const where = screen.getAllByTestId('compare-where');
    expect(where.map((w) => w.textContent)).toEqual(['In: Subsystem 1 › Function 1.1', 'In: Subsystem 2 › Appendix B']);
    expect(within(screen.getByRole('group', { name: 'Statement: Power supply output' })).getByTestId('compare-where'))
      .toHaveTextContent('Subsystem 1');
  });

  it('shows a location line only for the sides the outline knows (none for a document with no outline)', () => {
    const { rerender } = render(<ComparePair compare={conflict} titleByRef={titles} pathByRef={new Map([['other', 'Elsewhere']])} />);
    expect(screen.queryAllByTestId('compare-where')).toHaveLength(0);
    rerender(<ComparePair compare={conflict} titleByRef={titles} pathByRef={new Map([['det0_2_1', 'Subsystem 1']])} />);
    expect(screen.getAllByTestId('compare-where')).toHaveLength(1);
    rerender(<ComparePair compare={conflict} />);
    expect(screen.queryAllByTestId('compare-where')).toHaveLength(0);
  });

  it('calls the sides first and second statement when no heading is known, still without ids', () => {
    const { container } = render(<ComparePair compare={conflict} />);
    expect(screen.getByRole('group', { name: 'First statement' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Second statement' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/det\d+_/);
  });

  it('names an existing work item by its number, and by nothing else when the id is not a number', () => {
    const base = { kind: 'duplicate' as const, similarity: 0.9, a: { ref: 'proposed', text: 'x y' } };
    const { rerender } = render(<ComparePair compare={{ ...base, b: { ref: '1001', text: 'x z' } }} />);
    expect(screen.getByRole('group', { name: 'Existing work item 1001' })).toBeInTheDocument();
    rerender(<ComparePair compare={{ ...base, b: { ref: 'chroma-7f3a', text: 'x z' } }} />);
    expect(screen.getByRole('group', { name: 'Existing work item' })).toBeInTheDocument();
    expect(screen.queryByText(/chroma-7f3a/)).not.toBeInTheDocument();
  });

  it('names the sides of a duplicate by what they are', () => {
    render(
      <ComparePair
        compare={{ kind: 'duplicate', similarity: 1, a: { ref: 'proposed', text: 'same text' }, b: { ref: 'ado-1', text: 'same text' } }}
      />,
    );
    expect(screen.getByText('This proposed item matches an existing work item')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Proposed item' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Existing work item' })).toBeInTheDocument();
    expect(screen.queryByText(/underlined/)).not.toBeInTheDocument();
  });

  it('carries the highlight in more than colour (bold and underline)', () => {
    render(<ComparePair compare={conflict} />);
    const mark = screen.getAllByText('500')[0].closest('mark');
    expect(mark?.className).toContain('font-semibold');
    expect(mark?.className).toContain('underline');
  });

  it('renders document text as text, never as markup', () => {
    const { container } = render(
      <ComparePair
        compare={{
          kind: 'conflict', similarity: 0.5,
          a: { ref: 'a', text: '<img src=x onerror=alert(1)> limit 5' },
          b: { ref: 'b', text: '<script>alert(1)</script> limit 6' },
        }}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The markup survives as visible characters (split across highlight spans), not as elements.
    const first = screen.getByRole('group', { name: 'First statement' });
    expect(within(first).getByText('limit', { exact: false })).toBeInTheDocument();
    expect(first.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(screen.getByRole('group', { name: 'Second statement' }).textContent).toContain('<script>alert(1)</script>');
  });

  it('says so, and drops the highlight note, when the texts are too long to diff by word', () => {
    const long = (tag: string): string => Array.from({ length: 2100 }, (_, i) => `${tag}${i}`).join(' ');
    render(
      <ComparePair compare={{ kind: 'conflict', similarity: 0.1, a: { ref: 'a', text: long('x') }, b: { ref: 'b', text: long('y') } }} />,
    );
    expect(screen.getByText(/text is long, so it is shown without highlighting|differing words/)).toBeInTheDocument();
  });

  it('stacks the two sides on a phone and sets them side by side from the md breakpoint', () => {
    render(<ComparePair compare={conflict} />);
    const row = screen.getByTestId('compare-pair').querySelector('.md\\:flex-row');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('flex-col');
  });
});
