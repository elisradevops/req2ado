import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TokenUsagePanel } from './TokenUsagePanel';
import type { TokenUsageRow } from '../api/jobs';

const row = (over: Partial<TokenUsageRow>): TokenUsageRow => ({
  stage: 'score_requirements_for_document',
  model: 'm1',
  calls: 1,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  ...over,
});

describe('TokenUsagePanel', () => {
  it('renders nothing for a job with no recorded usage', () => {
    const { container } = render(<TokenUsagePanel rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the total and one line per stage, largest first, with readable stage names', () => {
    render(
      <TokenUsagePanel
        rows={[
          row({ stage: 'score_requirements_for_document', calls: 12, promptTokens: 20000, completionTokens: 3000 }),
          row({ stage: 'propose_acceptance_criteria', calls: 54, promptTokens: 270000, completionTokens: 60000 }),
        ]}
      />,
    );

    expect(screen.getByText('Tokens used — 353,000 across 66 calls')).toBeInTheDocument();
    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('Propose acceptance criteria')).toBeInTheDocument();
    expect(within(bodyRows[0]).getByText('270,000')).toBeInTheDocument();
    expect(within(bodyRows[1]).getByText('Score requirements for document')).toBeInTheDocument();
  });

  it('merges a stage that ran on two models into one line', () => {
    render(
      <TokenUsagePanel
        rows={[
          row({ stage: 'propose_acceptance_criteria', model: 'a', calls: 2, promptTokens: 100, completionTokens: 10 }),
          row({ stage: 'propose_acceptance_criteria', model: 'b', calls: 3, promptTokens: 200, completionTokens: 20 }),
        ]}
      />,
    );
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('300')).toBeInTheDocument();
  });

  it('shows the cached and reasoning columns only when the provider reported them', () => {
    const { rerender } = render(<TokenUsagePanel rows={[row({ promptTokens: 10, completionTokens: 5 })]} />);
    expect(screen.queryByRole('columnheader', { name: 'Cached' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Reasoning' })).not.toBeInTheDocument();

    rerender(<TokenUsagePanel rows={[row({ promptTokens: 10, completionTokens: 5, cachedTokens: 8, reasoningTokens: 3 })]} />);
    expect(screen.getByRole('columnheader', { name: 'Cached' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Reasoning' })).toBeInTheDocument();
  });
});
