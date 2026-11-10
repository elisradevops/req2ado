import type { NarrationEvent } from '../api/events';

/** How many narration events the live view keeps. */
export const NARRATION_LOG_MAX = 50;

/**
 * Adds a narration event to the log the live view keeps. The whole-document overview step sends a progress line every few
 * seconds while one part of it runs; consecutive lines for the SAME part replace each other (only the newest timer is of
 * interest) so a long step does not push the rest of the history out of the capped log.
 */
export function appendNarration(current: NarrationEvent[], narration: NarrationEvent, max: number = NARRATION_LOG_MAX): NarrationEvent[] {
  const last = current[current.length - 1];
  const sameStep = last !== undefined && last.phase === 'primer' && narration.phase === 'primer' && last.primerStep === narration.primerStep;
  return [...(sameStep ? current.slice(0, -1) : current), narration].slice(-max);
}
