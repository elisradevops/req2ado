// "Time left in this step" for the live progress banner.
//
// The chip used to compute (time since the JOB started) / (units done) * (units remaining) on every
// tick. Two things made that wrong in a way no tuning fixes:
//   * the clock included everything before the step (upload, parsing, figure captioning,
//     enhancement), so the per-unit rate was inflated;
//   * units only move when a long, blocking model call returns, so between completions `units done`
//     stood still while the elapsed time grew -- the estimate CLIMBED every second, then dropped when
//     a batch landed (seen live: a scoring step whose estimate kept rising for 20+ minutes).
//
// This is a countdown for ONE step, built only from progress observed during that step:
//   * the rate is the throughput over the last few completions (the step's own start is the first
//     sample), so time spent before the step never enters it;
//   * a prediction is made when a unit lands, and between completions the display simply counts down
//     to it -- it cannot rise;
//   * a later prediction may lower the shown time freely, but raises it only when it is clearly
//     later (> 25% + 30 s beyond what is shown), so lumpy batches do not make it flicker;
//   * past the predicted time with nothing landed it says so instead of showing a number that grows;
//   * it shows nothing until it has seen enough of the step to mean something.

export interface StepSample {
  /** Wall-clock ms at which `done` was first observed. */
  at: number;
  done: number;
}

export interface StepEtaState {
  key: string;
  samples: StepSample[];
  /** The completion time currently being counted down to, or null while still estimating. */
  predictedAt: number | null;
}

export type StepEta = { kind: 'estimating' } | { kind: 'left'; ms: number } | { kind: 'overdue' } | { kind: 'done' };

const MAX_SAMPLES = 12;
/** The rate is taken over at most this many of the most recent completion intervals. */
const WINDOW_INTERVALS = 4;
/** Completed intervals needed before a number is shown... */
const MIN_INTERVALS = 2;
/** ...or one interval, once this much of the step has been observed. */
const MIN_OBSERVED_MS = 45_000;
const RATCHET_FACTOR = 1.25;
const RATCHET_SLACK_MS = 30_000;

/** When the step is predicted to finish, from the samples so far; null when there is not enough to say. */
function predictCompletion(samples: StepSample[], total: number): number | null {
  const intervals = samples.length - 1;
  if (intervals < 1) return null;
  const observed = samples[samples.length - 1].at - samples[0].at;
  if (intervals < MIN_INTERVALS && observed < MIN_OBSERVED_MS) return null;
  const window = samples.slice(-(WINDOW_INTERVALS + 1));
  const first = window[0];
  const last = window[window.length - 1];
  const elapsed = last.at - first.at;
  const rate = elapsed > 0 ? (last.done - first.done) / elapsed : 0; // units per ms
  if (!(rate > 0)) return null;
  return last.at + Math.max(0, total - last.done) / rate;
}

/**
 * Folds one observation of a step's progress into its state. Pure: the same inputs give the same
 * state, and an observation with no new progress returns the state unchanged, so calling it on every
 * render is safe. A different `key` (a new step) or progress that went backwards starts over.
 */
export function observeStep(prev: StepEtaState | null, key: string, done: number, total: number, now: number): StepEtaState {
  const last = prev?.samples[prev.samples.length - 1];
  if (!prev || !last || prev.key !== key || done < last.done) {
    return { key, samples: [{ at: now, done }], predictedAt: null };
  }
  if (done === last.done) return prev;

  const samples = [...prev.samples, { at: now, done }].slice(-MAX_SAMPLES);
  const fresh = predictCompletion(samples, total);
  let predictedAt = prev.predictedAt;
  if (fresh !== null) {
    if (predictedAt === null || fresh <= predictedAt) {
      predictedAt = fresh;
    } else if (fresh - now > RATCHET_FACTOR * (predictedAt - now) + RATCHET_SLACK_MS) {
      // Clearly later than what is shown (also the case once the shown time has already passed).
      predictedAt = fresh;
    }
  }
  return { key, samples, predictedAt };
}

/** What to show for the state at `now`. */
export function stepEta(state: StepEtaState | null, done: number, total: number, now: number): StepEta {
  if (total > 0 && done >= total) return { kind: 'done' };
  if (!state || state.predictedAt === null) return { kind: 'estimating' };
  const ms = state.predictedAt - now;
  return ms > 0 ? { kind: 'left', ms } : { kind: 'overdue' };
}

/** Coarse on purpose: a figure that moves every second reads as unstable. Under a minute to 10 s, under ten to 30 s, else whole minutes. */
export function formatStepRemaining(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${Math.max(10, Math.round(seconds / 10) * 10)}s`;
  if (seconds < 600) {
    const snapped = Math.round(seconds / 30) * 30;
    const minutes = Math.floor(snapped / 60);
    const rest = snapped % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
