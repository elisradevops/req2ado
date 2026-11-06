import type { EtaEstimate, ModelDetail } from '../api/jobs';

// What the model picker and the cost card say about where their numbers come from. Every phrase here is something
// the app did or measured on this deployment (figures described or skipped, observed speed and finish rate, the
// number of past jobs behind an estimate) -- never a claim about how good a model is, which nothing here measures.

const TYPICAL_BAND = 0.1;

export function describeModelFacts(detail: ModelDetail): string[] {
  const facts = [detail.describesFigures ? 'Describes figures' : 'Skips figures'];
  const { speedVsTypical, finishedShare, runs } = detail;
  if (speedVsTypical !== null) {
    const delta = Math.round(Math.abs(1 - speedVsTypical) * 100);
    const phrase =
      Math.abs(1 - speedVsTypical) < TYPICAL_BAND
        ? 'about as fast as typical here'
        : speedVsTypical < 1
          ? `about ${delta}% faster than typical here`
          : `about ${delta}% slower than typical here`;
    // `runs` counts the estimator's recent fit samples, a smaller population than the finish rate below, so it is named as such.
    facts.push(`${phrase} (from ${runs} recent ${runs === 1 ? 'run' : 'runs'})`);
  }
  if (finishedShare !== null) facts.push(`${Math.round(finishedShare * 100)}% of runs finished`);
  if (speedVsTypical === null && finishedShare === null) facts.push('Not enough runs yet on this deployment');
  return facts;
}

/** One line on what a SURVEY estimate is based on, or null for BASELINE (a flat minute, not a projection). */
export function describeEstimateBasis(estimate: EtaEstimate): string | null {
  if (estimate.mode !== 'survey') return null;
  if (estimate.sampleCount === 0) return 'Rough guess: no completed jobs to learn from yet';
  const jobs = `${estimate.sampleCount} completed ${estimate.sampleCount === 1 ? 'job' : 'jobs'}`;
  const onModel = estimate.modelSampleCount > 0 ? `, ${estimate.modelSampleCount} on this model` : '';
  return `Based on ${jobs} in the last ${estimate.windowDays} days${onModel}`;
}
