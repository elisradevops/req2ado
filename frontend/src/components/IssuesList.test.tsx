import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssuesList } from './IssuesList';

describe('IssuesList', () => {
  it('renders nothing when there are no issues', () => {
    const { container } = render(<IssuesList issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Fix with assistant only on an askable issue, and only when the caller can open it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onAsk = vi.fn();
    const issues = [{ id: 'q', severity: 'review' as const, text: 'Quality 42 of 100.', askable: true }, { id: 'n', severity: 'review' as const, text: 'Missing value.' }];
    const { unmount } = render(<IssuesList issues={issues} onAsk={onAsk} />);
    expect(screen.getAllByRole('button', { name: 'Fix with assistant' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Fix with assistant' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    unmount();
    render(<IssuesList issues={issues} />);
    expect(screen.queryByRole('button', { name: 'Fix with assistant' })).not.toBeInTheDocument();
  });

  it('lists one row per issue, in the order given, as plain sentences in a labelled list', () => {
    render(
      <IssuesList
        issues={[
          { id: 'a', severity: 'fix', text: 'No Customer ID. Add one if the source has it.' },
          { id: 'b', severity: 'review', text: 'Quality 42 of 100.', why: 'Weakest: testability.' },
        ]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(screen.getByRole('list', { name: 'Issues' })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('No Customer ID. Add one if the source has it.');
    expect(rows[1]).toHaveTextContent('Quality 42 of 100.');
    expect(screen.getByRole('button', { name: /why/i })).toBeInTheDocument();
  });
});
