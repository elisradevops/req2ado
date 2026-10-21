import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeDetailPanel } from './NodeDetailPanel';
import { ToastProvider } from './ToastProvider';
import * as jobsApi from '../api/jobs';

vi.mock('../api/jobs');

const scored = {
  localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Lock time', description: 'The receiver shall lock fast.', action: 'create', customerId: null,
  qualityScore: 45, qualityIssues: [], qualityCategoryScores: { Verifiable: 20, Necessary: 90 }, qualityStale: false,
} as const;

function renderPanel(entry: Record<string, unknown>, withJob = true) {
  return render(
    <ToastProvider>
      <NodeDetailPanel jobId={withJob ? 'job-1' : undefined} entry={entry as never} jobMode="survey" jobStatus="diff_ready" />
    </ToastProvider>,
  );
}

describe('NodeDetailPanel: why this score', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(jobsApi.explainScore).mockResolvedValue({
      explanations: [{ category: 'Verifiable', score: 20, reason: 'No measurable limit.', passCondition: 'Measurable' }],
      basis: 'built_in', rubric: { source: 'default', version: 'v' },
    } as never);
  });

  it('offers the explanation for a scored requirement and asks the orchestrator for this item', async () => {
    renderPanel(scored);
    await userEvent.setup().click(screen.getByRole('button', { name: /why this score/i }));
    expect(await screen.findByText(/no measurable limit/i)).toBeInTheDocument();
    expect(jobsApi.explainScore).toHaveBeenCalledWith('job-1', 'n0');
  });

  it.each([
    ['an unscored requirement', { ...scored, qualityScore: null, qualityCategoryScores: null }],
    ['a score that is out of date (edited since)', { ...scored, qualityStale: true }],
    ['an Epic', { ...scored, type: 'Epic' }],
    ['a score with no categories', { ...scored, qualityCategoryScores: {} }],
  ])('does not offer it for %s', (_label, entry) => {
    renderPanel(entry);
    expect(screen.queryByRole('button', { name: /why this score/i })).not.toBeInTheDocument();
  });

  it('forgets an explanation when a rescore changes the category scores even though the overall score is the same', async () => {
    const view = renderPanel(scored);
    await userEvent.setup().click(screen.getByRole('button', { name: /why this score/i }));
    await screen.findByText(/no measurable limit/i);
    view.rerender(
      <ToastProvider>
        <NodeDetailPanel jobId="job-1" entry={{ ...scored, qualityCategoryScores: { Verifiable: 60, Necessary: 90 } } as never} jobMode="survey" jobStatus="diff_ready" />
      </ToastProvider>,
    );
    expect(screen.queryByText(/no measurable limit/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /why this score/i })).toBeInTheDocument();
  });

  it('does not offer it without a job to ask about', () => {
    renderPanel(scored, false);
    expect(screen.queryByRole('button', { name: /why this score/i })).not.toBeInTheDocument();
  });
});
