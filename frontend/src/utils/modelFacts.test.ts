import { describe, it, expect } from 'vitest';
import { describeModelFacts, describeEstimateBasis } from './modelFacts';
import type { ModelDetail, EtaEstimate } from '../api/jobs';

const detail = (overrides: Partial<ModelDetail> = {}): ModelDetail => ({
  id: 'm',
  name: 'M',
  describesFigures: true,
  runs: 0,
  speedVsTypical: null,
  finishedShare: null,
  ...overrides,
});

describe('describeModelFacts', () => {
  it('says what the app does with figures, as an action and not a quality claim', () => {
    expect(describeModelFacts(detail({ describesFigures: true }))[0]).toBe('Describes figures');
    expect(describeModelFacts(detail({ describesFigures: false }))[0]).toBe('Skips figures');
  });

  it('says there is not enough history when neither speed nor finish rate is known', () => {
    expect(describeModelFacts(detail())).toEqual(['Describes figures', 'Not enough runs yet on this deployment']);
  });

  it('turns a speed ratio below 1 into a percentage faster, with the run count', () => {
    expect(describeModelFacts(detail({ runs: 12, speedVsTypical: 0.8 }))).toContain('about 20% faster than typical here (from 12 recent runs)');
  });

  it('turns a speed ratio above 1 into a percentage slower', () => {
    expect(describeModelFacts(detail({ runs: 4, speedVsTypical: 1.5 }))).toContain('about 50% slower than typical here (from 4 recent runs)');
  });

  it('calls a ratio within 10% of 1 typical, not faster or slower', () => {
    expect(describeModelFacts(detail({ runs: 5, speedVsTypical: 1.05 }))).toContain('about as fast as typical here (from 5 recent runs)');
  });

  it('shows the share of runs that finished, and omits it when unknown', () => {
    expect(describeModelFacts(detail({ runs: 5, speedVsTypical: 1, finishedShare: 0.92 }))).toContain('92% of runs finished');
    expect(describeModelFacts(detail({ runs: 5, speedVsTypical: 1 })).join(' ')).not.toContain('finished');
  });

  it('shows the finish rate alone when speed is unknown', () => {
    expect(describeModelFacts(detail({ finishedShare: 0.5 }))).toEqual(['Describes figures', '50% of runs finished']);
  });
});

const est = (overrides: Partial<EtaEstimate> = {}): EtaEstimate => ({
  mode: 'survey',
  estimateMinutes: 25,
  lowerMinutes: 20,
  upperMinutes: 30,
  basis: 'blended',
  sampleCount: 12,
  modelSampleCount: 0,
  modelAdjustment: 1,
  windowDays: 90,
  ...overrides,
});

describe('describeEstimateBasis', () => {
  it('names the number of past jobs behind a fitted estimate and the window', () => {
    expect(describeEstimateBasis(est())).toBe('Based on 12 completed jobs in the last 90 days');
  });

  it('adds how many were on the chosen model', () => {
    expect(describeEstimateBasis(est({ modelSampleCount: 3 }))).toBe('Based on 12 completed jobs in the last 90 days, 3 on this model');
  });

  it('uses the singular for one job', () => {
    expect(describeEstimateBasis(est({ sampleCount: 1 }))).toBe('Based on 1 completed job in the last 90 days');
  });

  it('admits a rough guess when there is no history', () => {
    expect(describeEstimateBasis(est({ basis: 'bootstrap', sampleCount: 0 }))).toBe('Rough guess: no completed jobs to learn from yet');
  });

  it('says nothing for BASELINE, whose minute is flat and not a projection', () => {
    expect(describeEstimateBasis(est({ mode: 'baseline', basis: 'bootstrap', sampleCount: 0 }))).toBeNull();
  });
});
