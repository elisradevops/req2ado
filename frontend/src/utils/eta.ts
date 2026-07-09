const SURVEY_MIN_MINUTES = 15;
const SURVEY_MAX_MINUTES = 40;
const SURVEY_MINUTES_PER_BLOCK = 0.5;
const BASELINE_FLAT_MINUTES = 1;

export function computeEtaMinutes(blockCount: number, mode: 'baseline' | 'survey'): number {
  if (mode === 'baseline') {
    return BASELINE_FLAT_MINUTES;
  }
  const estimate = SURVEY_MIN_MINUTES + blockCount * SURVEY_MINUTES_PER_BLOCK;
  return Math.min(SURVEY_MAX_MINUTES, Math.max(SURVEY_MIN_MINUTES, estimate));
}
