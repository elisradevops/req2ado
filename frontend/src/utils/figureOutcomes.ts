import { isValidNarrationEvent, type NarrationEvent } from '../api/events';

/** What became of a figure that ended up WITHOUT a description. */
export type FigureOutcome = 'insignificant' | 'vision_failed';

/** The plain-language reason shown next to such a figure. */
export const FIGURE_OUTCOME_TEXT: Record<FigureOutcome, string> = {
  insignificant: 'not significant, no description needed',
  vision_failed: 'no usable reply from the model, left without a description',
};

/**
 * [figure index, outcome] when this event reports a figure that got no description, else null. The first event of a figure
 * (work started, no verdict yet) and the event of a described figure are both null.
 */
export function outcomeOf(narration: NarrationEvent): [number, FigureOutcome] | null {
  if (narration.phase !== 'describe_figure' || narration.figureIndex == null) return null;
  const status = narration.figureCaptionStatus;
  return status === 'insignificant' || status === 'vision_failed' ? [narration.figureIndex, status] : null;
}

/** [figure index, reason] when the model gave a reason for judging this figure not significant, else null. */
export function reasonOf(narration: NarrationEvent): [number, string] | null {
  const outcome = outcomeOf(narration);
  const reason = narration.figureCaptionReason?.trim();
  return outcome && outcome[1] === 'insignificant' && reason ? [outcome[0], reason] : null;
}

/** Every reason in the stored event history, for a reloaded page. */
export function reasonsFromHistory(history: { detail?: unknown }[]): Record<number, string> {
  const reasons: Record<number, string> = {};
  for (const entry of history) {
    if (!isValidNarrationEvent(entry.detail)) continue;
    const found = reasonOf(entry.detail);
    if (found) reasons[found[0]] = found[1];
  }
  return reasons;
}

/** One short line under a figure's outcome that says who judged it and why; null for an outcome that is not a judgement (a failure). */
export function outcomeLine(outcome: FigureOutcome, reason: string | undefined): string | null {
  if (outcome !== 'insignificant') return null;
  return reason ? `Judged by the vision model: ${reason}` : 'Judged by the vision model; it gave no reason.';
}

/** Every outcome in the stored event history, so a reloaded or reopened job page shows them as well. */
export function outcomesFromHistory(history: { detail?: unknown }[]): Record<number, FigureOutcome> {
  const outcomes: Record<number, FigureOutcome> = {};
  for (const entry of history) {
    if (!isValidNarrationEvent(entry.detail)) continue;
    const outcome = outcomeOf(entry.detail);
    if (outcome) outcomes[outcome[0]] = outcome[1];
  }
  return outcomes;
}

/** "3 described · 1 not significant · 2 failed", leaving out the zeros; empty when there is nothing to say. */
export function figureTally(described: number, outcomes: Record<number, FigureOutcome>): string {
  const values = Object.values(outcomes);
  const notSignificant = values.filter((v) => v === 'insignificant').length;
  const failed = values.filter((v) => v === 'vision_failed').length;
  return [
    described > 0 ? `${described} described` : '',
    notSignificant > 0 ? `${notSignificant} not significant` : '',
    failed > 0 ? `${failed} failed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
