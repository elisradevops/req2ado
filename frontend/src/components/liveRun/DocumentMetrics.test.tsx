import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentMetrics } from './DocumentMetrics';
import type { DocStats } from '../../api/liveTypes';

const stats = (extra: Partial<DocStats> = {}): DocStats => ({
  words: 12480, blocks: 88, headings: 49, tables: 0, tableRows: 0, figures: 0, pages: 4, ...extra,
});

describe('DocumentMetrics', () => {
  it('shows the document in numbers', () => {
    render(<DocumentMetrics stats={stats({ tables: 2, tableRows: 31, figures: 1 })} finished={0} total={0} />);
    const box = screen.getByTestId('document-metrics');
    expect(box).toHaveTextContent('12,480 words');
    expect(box).toHaveTextContent('49 headings');
    expect(box).toHaveTextContent('2 tables (31 rows)');
    expect(box).toHaveTextContent('1 figure');
    expect(box).toHaveTextContent('4 pages');
  });

  it('leaves out what the document does not have instead of showing zero, and unknown pages as absent', () => {
    render(<DocumentMetrics stats={stats({ pages: null })} finished={0} total={0} />);
    const box = screen.getByTestId('document-metrics');
    expect(box).not.toHaveTextContent('table');
    expect(box).not.toHaveTextContent('figure');
    expect(box).not.toHaveTextContent('page');
    expect(box).not.toHaveTextContent(/\b0\b/);
  });

  it('counts finished outline items, capped at the total', () => {
    const { rerender } = render(<DocumentMetrics stats={stats()} finished={12} total={48} />);
    expect(screen.getByTestId('document-metrics')).toHaveTextContent('12 of 48 outline items done');
    rerender(<DocumentMetrics stats={stats()} finished={60} total={48} />);
    expect(screen.getByTestId('document-metrics')).toHaveTextContent('48 of 48 outline items done');
  });

  it('says how many outline items the document has, not "0 of N", until the first one is done', () => {
    render(<DocumentMetrics stats={stats()} finished={0} total={15} />);
    const box = screen.getByTestId('document-metrics');
    expect(box).toHaveTextContent('15 outline items');
    expect(box).not.toHaveTextContent(/0 of 15/);
    expect(box).not.toHaveTextContent('written'); // nothing is written to Azure DevOps during a run
  });

  it('uses the singular for one outline item', () => {
    render(<DocumentMetrics stats={stats()} finished={0} total={1} />);
    expect(screen.getByTestId('document-metrics')).toHaveTextContent('1 outline item');
    expect(screen.getByTestId('document-metrics')).not.toHaveTextContent('1 outline items');
  });

  it('uses singular nouns for one', () => {
    render(<DocumentMetrics stats={stats({ words: 1, headings: 1, pages: 1 })} finished={0} total={0} />);
    const box = screen.getByTestId('document-metrics');
    expect(box).toHaveTextContent('1 word');
    expect(box).toHaveTextContent('1 heading');
    expect(box).toHaveTextContent('1 page');
    expect(box).not.toHaveTextContent('1 words');
  });
});
