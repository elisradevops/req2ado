// DESIGN.md §11.2.3 -- the SURVEY cost estimate is computed SERVER-SIDE
// (orchestrator's EtaService, from this deployment's own real completed-job
// history) and never re-derived here. computeEtaMinutes previously lived in
// this file as a static, hand-picked linear formula -- deleted, not
// re-tuned: it was checked against a real completed job
// (AirPro_BP_ICD_Revision_0.3.docx, 682 blocks, 39 figures, ~90 real
// minutes) and found wrong by ~4x (predicted 356 min). A second, more
// elaborate hand-picked formula (adding a figure-count term and a
// model-name-parsed speed multiplier) was ALSO found wrong, by ~5x, against
// the same document. Two falsified guesses in a row is why the technique
// changed rather than being re-tuned a third time -- see DESIGN.md §18's
// ledger. This file now only formats numbers the server already computed.

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

/**
 * Renders a lower/upper minute pair as a range ("20 min – 35 min", "1h –
 * 1h 30m") -- a range, not a false-precision single number, since the
 * server's own estimate is itself an uncertain projection (DESIGN.md
 * §11.2.3.d/§12: "an estimate is a range with 'typically', never a
 * false-precision point value").
 */
export function formatEtaRange(lowerMinutes: number, upperMinutes: number): { lower: string; upper: string } {
  return { lower: formatEtaMinutes(lowerMinutes), upper: formatEtaMinutes(upperMinutes) };
}
