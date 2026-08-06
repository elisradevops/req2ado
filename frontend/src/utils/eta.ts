const SURVEY_MIN_MINUTES = 15;
const SURVEY_MINUTES_PER_BLOCK = 0.5;
const BASELINE_FLAT_MINUTES = 1;

export function computeEtaMinutes(blockCount: number, mode: 'baseline' | 'survey'): number {
  if (mode === 'baseline') {
    return BASELINE_FLAT_MINUTES;
  }
  // No upper cap -- a large document (500+ pages) genuinely can take
  // hours, not just "up to 40 minutes". A capped estimate here previously
  // told an engineer submitting a huge document to expect ~40 minutes
  // regardless of size, actively misleading them into thinking a
  // legitimately still-running multi-hour job was stuck. Underselling
  // wait time is worse than overselling it -- only the floor (so a tiny
  // document doesn't show a suspiciously small number) is clamped.
  return Math.max(SURVEY_MIN_MINUTES, SURVEY_MIN_MINUTES + blockCount * SURVEY_MINUTES_PER_BLOCK);
}

/** Renders a minute count as "42 min" under an hour, "2h 15m" at or above one -- a raw 3-digit-plus minute count is not readable for large documents. */
export function formatEtaMinutes(minutes: number): string {
  const roundedMinutes = Math.round(minutes);
  if (roundedMinutes < 60) {
    return `${roundedMinutes} min`;
  }
  const hours = Math.floor(roundedMinutes / 60);
  const remainingMinutes = roundedMinutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
