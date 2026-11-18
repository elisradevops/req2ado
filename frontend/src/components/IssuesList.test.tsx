import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssuesList } from './IssuesList';

describe('IssuesList', () => {
  it('renders nothing when there are no issues', () => {
    const { container } = render(<IssuesList issues={[]} />);
    expect(container).toBeEmptyDOMElement();
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
