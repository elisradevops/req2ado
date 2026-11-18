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
import type { TokenForecast } from '../api/jobs';

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

/**
 * The estimate line beside Start: the server range with "typically", or, when a SURVEY job of this very file would be served from the
 * result cache (P5), "A few seconds: this file was already processed". Null while there is neither.
 */
export function estimateLine(
  estimate: { lowerMinutes: number; upperMinutes: number } | undefined,
  cachedResult: boolean,
): { value: string; note: string } | null {
  if (cachedResult) return { value: 'A few seconds', note: 'this file was already processed' };
  if (!estimate) return null;
  const { lower, upper } = formatEtaRange(estimate.lowerMinutes, estimate.upperMinutes);
  return { value: lower === upper ? lower : `${lower} – ${upper}`, note: 'typically, once it starts' };
}

/** 1,200,000 -> "1.2M", 45,000 -> "45k": a forecast is read at a glance, not to the digit. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

const formatUsd = (usd: number): string => `$${usd >= 10 ? Math.round(usd).toLocaleString('en-US') : usd.toFixed(2)}`;

/** "$4.20 – $18". */
export function formatUsdRange(cost: { low: number; high: number }): string {
  return `${formatUsd(cost.low)} – ${formatUsd(cost.high)}`;
}

/**
 * The forecast line under the time estimate: the range of tokens a SURVEY run is expected to use, and, only when the deployment has a price for the
 * model, the range of its cost. Null when there is no forecast (BASELINE, an older server, or a result served from the cache).
 */
export function tokenForecastLine(tokens: TokenForecast | undefined): { value: string; note: string } | null {
  if (!tokens) return null;
  const low = tokens.inputTokens.low + tokens.outputTokens.low;
  const high = tokens.inputTokens.high + tokens.outputTokens.high;
  const range = `${formatTokenCount(low)} – ${formatTokenCount(high)} tokens`;
  if (!tokens.costUsd) return { value: range, note: 'rough forecast of model use' };
  return { value: `${range} · ${formatUsdRange(tokens.costUsd)}`, note: 'rough forecast of model use and cost' };
}
