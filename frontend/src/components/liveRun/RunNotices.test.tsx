import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RunNotices } from './RunNotices';
import type { Notice } from '../../api/liveTypes';
import { noticeCopy } from '../../utils/liveCopy';

const make = (kind: Notice['kind'], severity: Notice['severity'], extra: Partial<Notice> = {}): Notice => ({
  type: 'notice', id: `${kind}-1`, kind, severity, count: 1, facts: {}, emittedAt: 'x', ...extra,
});

describe('RunNotices', () => {
  beforeEach(() => sessionStorage.clear());

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<RunNotices notices={[]} heading='Limits and adjustments' storageKey='j.live' />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays collapsed for informational notices only', () => {
    render(<RunNotices notices={[make('server_retry', 'info', { facts: { status: 503 } })]} heading='Limits and adjustments' storageKey='j.live' />);
    expect(screen.getByTestId('run-notices')).not.toHaveAttribute('open');
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('opens once for a warning, names the cause and the remedy, and uses a word as well as an icon', () => {
    render(
      <RunNotices
        notices={[make('output_limit_reached', 'warning', { count: 2, facts: { lastRef: 'r1' } })]}
        heading='Limits and adjustments'
        storageKey='j.live'
        titleByRef={new Map([['r1', 'Chassis size']])}
      />,
    );
    const root = screen.getByTestId('run-notices');
    expect(root).toHaveAttribute('open');
    expect(screen.getByText('1 item, 1 to check')).toBeInTheDocument();
    const row = within(screen.getByTestId('notice-output_limit_reached'));
    expect(row.getByText(/Check:/)).toBeInTheDocument();
    expect(row.getByText(/The last item it finished was "Chassis size"/)).toBeInTheDocument();
    expect(row.getByText(/This happened 2 times/)).toBeInTheDocument();
    expect(row.getByText(/run again with a model that allows longer answers/)).toBeInTheDocument();
  });

  it('does not show an internal id when the item has no readable title', () => {
    render(<RunNotices notices={[make('output_limit_reached', 'warning', { facts: { lastRef: 'det0_2_1' } })]} heading='h' storageKey='j.live' />);
    expect(screen.queryByText(/det0_2_1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/last item it finished/)).not.toBeInTheDocument();
  });

  it('does not reopen by itself once the reader has seen it for this job', () => {
    sessionStorage.setItem('req2ado.notices.opened.j.live', '1');
    render(<RunNotices notices={[make('output_limit_reached', 'warning')]} heading='h' storageKey='j.live' />);
    expect(screen.getByTestId('run-notices')).not.toHaveAttribute('open');
  });

  it('states the assumed context size with a thousands separator and no document text', () => {
    render(<RunNotices notices={[make('context_assumed', 'info', { facts: { tokens: 28000 } })]} heading='h' storageKey='j.live' />);
    expect(screen.getByText(/window of 28,000 tokens/)).toBeInTheDocument();
  });
  describe('document study', () => {
    const study = (facts: Notice['facts'], severity: Notice['severity'] = 'info') =>
      noticeCopy(make('document_study', severity, { count: 3, facts }));

    it('says the whole document is being read, and how much was read in an earlier run', () => {
      const copy = study({ state: 'reading', windows: 12, cached: 4 });
      expect(copy.title).toBe('Reading the document');
      expect(copy.detail).toBe(
        'Reading the whole document before proposing acceptance criteria: 12 parts. 4 were already read in an earlier run.',
      );
      expect(study({ state: 'reading', windows: 12, cached: 0 }).detail).toBe(
        'Reading the whole document before proposing acceptance criteria: 12 parts.',
      );
    });

    it('reports the parts read so far', () => {
      expect(study({ state: 'reading', done: 6, windows: 12 })).toEqual({
        title: 'Reading the document',
        detail: 'Read 6 of 12 parts so far.',
      });
    });

    it('says the document was read, and mentions split parts only when there were some', () => {
      const copy = study({ state: 'done', studied: 12, windows: 12, cached: 0, split: 0, failed: 0 });
      expect(copy.title).toBe('Document read');
      expect(copy.detail).toBe(
        "All 12 parts were read, so proposed acceptance criteria can use the document's own definitions, markers and standards.",
      );
      expect(study({ state: 'done', studied: 12, windows: 12, split: 2 }).detail).toContain(
        '2 of them had to be read in smaller pieces.',
      );
      expect(study({ state: 'done', studied: 12, windows: 12, split: 1 }).detail).toContain(
        'One part had to be read in smaller pieces.',
      );
      // singular: no "All 1 part were read"; a zero or unknown total never prints "All 0 parts"
      expect(study({ state: 'done', studied: 1, windows: 1 }).detail).toMatch(/^The 1 part was read,/);
      expect(study({ state: 'done', studied: 0, windows: 0 }).detail).toMatch(/^The whole document was read,/);
    });

    it('says what a partly read document means for the reader', () => {
      expect(study({ state: 'partial', studied: 9, windows: 12 }, 'warning')).toEqual({
        title: 'Document only partly read',
        detail:
          "Read 9 of 12 parts, so proposed acceptance criteria used less of the document's context. " +
          'Check items marked as needing author input. Running the same document again retries the unread parts and reuses the ones already read, for a limited time.',
      });
      expect(study({ state: 'partial', studied: 9, windows: 12, failed: 3 }, 'warning').detail).toContain('3 could not be read.');
      expect(study({ state: 'partial', studied: 9, windows: 12, failed: 0 }, 'warning').detail).not.toContain('could not be read');
    });

    it('says a stop that was asked for is not a failure, and what was read is kept', () => {
      expect(study({ state: 'stopped', studied: 1, windows: 4, cached: 0 })).toEqual({
        title: 'Document reading stopped early',
        detail:
          'Nothing needed acceptance criteria, so the rest of the document was not read. Read 1 of 4 parts. ' +
          'What was read is kept for a limited time, so running the same document again reuses it.',
      });
      expect(study({ state: 'stopped' }).detail).toBe(
        'Nothing needed acceptance criteria, so the rest of the document was not read. ' +
          'What was read is kept for a limited time, so running the same document again reuses it.',
      );
    });

    it('never prints more parts read than the document has, or more cached than parts', () => {
      expect(study({ state: 'reading', done: 13, windows: 12 }).detail).toBe('Read 12 of 12 parts so far.');
      expect(study({ state: 'reading', windows: 4, cached: 5 }).detail).toContain('4 were already read');
      expect(study({ state: 'partial', studied: 13, windows: 12 }, 'warning').detail).toMatch(/^Read 12 of 12 parts,/);
    });

    it('rejects negative, fractional and non-numeric facts instead of printing them', () => {
      for (const bad of [-1, 2.5, '3', null]) {
        const copy = study({ state: 'reading', done: bad as never, windows: bad as never, cached: bad as never });
        expect(`${copy.title} ${copy.detail}`).not.toMatch(/-1|2\.5|undefined|NaN|null/);
      }
    });

    it('says a run that read nothing is only partly read without printing a zero-part total', () => {
      expect(study({ state: 'partial', studied: 0, windows: 4, cached: 0, split: 0, failed: 0 }, 'warning').detail).toMatch(/^Read 0 of 4 parts,/);
      expect(study({ state: 'partial', studied: 0, windows: 0 }, 'warning').detail).toMatch(/^Only part of the document was read,/);
    });

    it('never throws or prints undefined for missing or odd facts, and does not repeat a count', () => {
      for (const facts of [{}, { state: 'reading' }, { state: 'done' }, { state: 'partial' }, { state: 'stopped' }, { state: 'stopped', studied: 'x', windows: NaN }, { state: 7 }, { windows: 'x', done: null, studied: 'y' }]) {
        const copy = study(facts as Notice['facts']);
        expect(`${copy.title} ${copy.detail}`).not.toMatch(/undefined|NaN|null|times/);
        expect(copy.title.length).toBeGreaterThan(3);
      }
    });

    it('renders as one row that is replaced by its newest state', () => {
      render(<RunNotices notices={[make('document_study', 'warning', { facts: { state: 'partial', studied: 9, windows: 12 } })]} heading='h' storageKey='j.live' />);
      const row = within(screen.getByTestId('notice-document_study'));
      expect(row.getByText(/Check:/)).toBeInTheDocument();
      expect(row.getByText('Read 9 of 12 parts, so proposed acceptance criteria used less of the document\'s context. Check items marked as needing author input. Running the same document again retries the unread parts and reuses the ones already read, for a limited time.')).toBeInTheDocument();
    });
  });
});
