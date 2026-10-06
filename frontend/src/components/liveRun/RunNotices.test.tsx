import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RunNotices } from './RunNotices';
import type { Notice } from '../../api/liveTypes';

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
});
