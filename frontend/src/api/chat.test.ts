import { describe, expect, it, vi, beforeEach } from 'vitest';
import { httpClient } from './httpClient';
import { checkRewrite } from './chat';

vi.mock('./httpClient', () => ({ httpClient: { get: vi.fn(), post: vi.fn() } }));

describe('checkRewrite', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs the proposal to the rewrite-check sub-route and returns the comparison', async () => {
    const comparison = { before: { score: 64 }, after: { score: 71 }, delta: 7, categoryDeltas: {}, warnings: [] };
    vi.mocked(httpClient.post).mockResolvedValue({ data: comparison });
    const result = await checkRewrite('job-1', 'n0', { proposedTitle: null, proposedDescription: 'New text.' });
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/diff/n0/rewrite-check', { proposedTitle: null, proposedDescription: 'New text.' });
    expect(result).toEqual(comparison);
  });

  it('passes warningsOnly on when asked for the checks that need no model', async () => {
    vi.mocked(httpClient.post).mockResolvedValue({ data: { warnings: [] } });
    await checkRewrite('job-1', 'n0', { proposedTitle: 'T', proposedDescription: 'New text.', warningsOnly: true });
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/job-1/diff/n0/rewrite-check', { proposedTitle: 'T', proposedDescription: 'New text.', warningsOnly: true });
  });
});
