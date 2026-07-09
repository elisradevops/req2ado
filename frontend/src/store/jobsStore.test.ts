import { describe, it, expect, beforeEach } from 'vitest';
import { useJobsStore } from './jobsStore';

describe('jobsStore', () => {
  beforeEach(() => {
    useJobsStore.setState({ jobs: [], jobDetailCache: {} });
  });

  it('setJobs replaces the job list', () => {
    useJobsStore.getState().setJobs([{ id: 'j1', mode: 'baseline', status: 'succeeded', areaPath: 'A', itemCount: 2, createdAt: '2026-07-09T00:00:00Z' }]);
    expect(useJobsStore.getState().jobs).toHaveLength(1);
  });

  it('setJobDetail stores by id keyed lookup, not array scan', () => {
    useJobsStore.getState().setJobDetail('j1', { id: 'j1', status: 'diff_ready', dryRunDiff: [] });
    expect(useJobsStore.getState().jobDetailCache.j1).toEqual({ id: 'j1', status: 'diff_ready', dryRunDiff: [] });
  });
});
