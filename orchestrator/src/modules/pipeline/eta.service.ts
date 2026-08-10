import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

// DESIGN.md §11.2.3 -- the SURVEY cost estimate, computed from this
// deployment's own real completed-job durations instead of a hand-picked
// constant. Two hand-picked formulas were tried and both fell wrong by
// ~4-5x against a real ~90-minute job (AirPro_BP_ICD_Revision_0.3.docx,
// 682 blocks, 39 figures) -- see DESIGN.md §18's ledger. This is not a
// better guess; it is a different technique.

export const SURVEY_MIN_MINUTES = 15;
export const BASELINE_FLAT_MINUTES = 1;

// Bootstrap default -- used when there is no real history to fit against
// (today's literal state: a prior account reset wiped all job history to
// zero) or when the real fit degenerates (see the guards in fitOls3/fitOls2
// below). Calibrated to the ONE real observation available: a 682-block,
// 39-figure SURVEY job that actually took ~90 minutes --
// 10 + 682*0.10 + 39*0.40 = 93.8 min, ~4% high (the safe direction to be
// wrong in). This is explicitly NOT knowledge -- one data point calibrates
// a formula's scale, not its shape. The 4:1 figure:block weight ratio is
// the one thing that survives from the earlier, reversed formula (each
// figure triggers a separate vision-model call, genuinely more expensive
// than a text block) -- the absolute scale of both coefficients does not.
export const BOOTSTRAP_BASE_MINUTES = 10;
export const BOOTSTRAP_MINUTES_PER_BLOCK = 0.1;
export const BOOTSTRAP_MINUTES_PER_FIGURE = 0.4;

// Shrinkage toward the bootstrap while real sample count (n) is low --
// w = n / (n + K). At n=K exactly, real data and bootstrap are weighted
// equally; K=8 means a 3-parameter fit (which needs > 3 points to mean
// anything at all -- 5 residual degrees of freedom at n=8) doesn't start
// meaningfully outweighing the bootstrap until there's a real base of
// samples behind it. At n=2 the bootstrap still holds 80% of the blend.
export const ETA_SHRINKAGE_K = 8;
// Same shrinkage shape for the per-model ratio adjustment, but a lower K --
// a single scalar (how much slower/faster THIS model ran vs. the blended
// estimate) earns trust faster than three regression coefficients, but one
// lucky/unlucky run still only moves the adjustment by 1/6 (n_m=1 -> w=1/6).
export const ETA_MODEL_SHRINKAGE_K = 5;
export const ETA_MODEL_ADJUSTMENT_MIN = 0.5;
export const ETA_MODEL_ADJUSTMENT_MAX = 2.0;

// Trailing window for the sample query -- whichever is smaller. 90 days so
// a GPU swap or model-lineup change fades out of the fit within a quarter,
// not permanently; the 50-row cap so one unusually busy week can't outvote
// three quiet months.
export const ETA_WINDOW_DAYS = 90;
export const ETA_WINDOW_MAX_SAMPLES = 50;

export const ETA_RANGE_LOWER = 0.75;
export const ETA_RANGE_UPPER = 1.25;

const ETA_FIT_CACHE_TTL_MS = 60_000;

export interface EtaSample {
  blockCount: number;
  figureCount: number;
  model: string;
  minutes: number;
}

export interface OlsFit3 {
  a: number;
  beta: number;
  gamma: number;
}

export interface OlsFit2 {
  a: number;
  mu: number;
}

export function bootstrapMinutes(blockCount: number, figureCount: number): number {
  return BOOTSTRAP_BASE_MINUTES + blockCount * BOOTSTRAP_MINUTES_PER_BLOCK + figureCount * BOOTSTRAP_MINUTES_PER_FIGURE;
}

// Solves a 3x3 linear system via Cramer's rule -- no matrix library, no
// iterative solver, just six sums and three cross-sums accumulated in one
// pass over the samples (see fitOls3) and nine determinant evaluations
// here. Returns null when the system is singular/near-singular (a relative
// epsilon, not absolute -- Σb² scales to ~10^7 for a 682-block document, so
// an absolute threshold would misjudge small and large documents in
// opposite directions).
export function solve3x3(m: number[][], rhs: number[]): number[] | null {
  const det3 = (r: number[][]): number =>
    r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
    r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
    r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);

  const d = det3(m);
  const maxAbsElement = Math.max(...m.flat().map(Math.abs), ...rhs.map(Math.abs), 1);
  const relativeEpsilon = 1e-9 * maxAbsElement ** 3;
  if (Math.abs(d) <= relativeEpsilon) return null;

  const withCol = (col: number): number[][] => m.map((row, i) => row.map((v, j) => (j === col ? rhs[i] : v)));
  return [det3(withCol(0)) / d, det3(withCol(1)) / d, det3(withCol(2)) / d];
}

// y ~ a + beta*blockCount + gamma*figureCount via ordinary least squares
// (normal equations). Returns null if the system is degenerate (solve3x3)
// or if any coefficient is non-positive -- a negative/zero weight on
// document size is not a real fit, it's noise from too few or too
// collinear samples (block and figure counts correlate strongly in any
// realistic document set), and must fall through to fitOls2, not be
// trusted as-is.
export function fitOls3(samples: EtaSample[]): OlsFit3 | null {
  let n = 0;
  let sumB = 0,
    sumF = 0,
    sumY = 0,
    sumBB = 0,
    sumFF = 0,
    sumBF = 0,
    sumBY = 0,
    sumFY = 0;
  for (const s of samples) {
    n += 1;
    sumB += s.blockCount;
    sumF += s.figureCount;
    sumY += s.minutes;
    sumBB += s.blockCount * s.blockCount;
    sumFF += s.figureCount * s.figureCount;
    sumBF += s.blockCount * s.figureCount;
    sumBY += s.blockCount * s.minutes;
    sumFY += s.figureCount * s.minutes;
  }
  if (n === 0) return null;

  const matrix = [
    [n, sumB, sumF],
    [sumB, sumBB, sumBF],
    [sumF, sumBF, sumFF],
  ];
  const rhs = [sumY, sumBY, sumFY];
  const solved = solve3x3(matrix, rhs);
  if (!solved) return null;

  const [a, beta, gamma] = solved;
  if (a < 0 || beta <= 0 || gamma <= 0) return null;
  return { a, beta, gamma };
}

// Fallback when the 3-parameter fit degenerates: collapse block/figure
// count into one combined unit using the bootstrap's own 4:1 weight ratio
// (u = b + 4f), and fit y ~ a + mu*u -- a simple 2x2 linear regression, not
// a second matrix solve. Returns null if THIS also degenerates (fewer than
// 2 distinct u values, or a non-positive slope) -- at that point there is
// nothing left to trust and the caller falls all the way back to the
// bootstrap.
export function fitOls2(samples: EtaSample[]): OlsFit2 | null {
  const points = samples.map((s) => ({ u: s.blockCount + 4 * s.figureCount, y: s.minutes }));
  const distinctU = new Set(points.map((p) => p.u));
  if (distinctU.size < 2) return null;

  const n = points.length;
  const sumU = points.reduce((acc, p) => acc + p.u, 0);
  const sumY = points.reduce((acc, p) => acc + p.y, 0);
  const sumUU = points.reduce((acc, p) => acc + p.u * p.u, 0);
  const sumUY = points.reduce((acc, p) => acc + p.u * p.y, 0);

  const denominator = n * sumUU - sumU * sumU;
  if (denominator === 0) return null;

  const mu = (n * sumUY - sumU * sumY) / denominator;
  const a = (sumY - mu * sumU) / n;
  if (mu <= 0) return null;
  return { a, mu };
}

export function blend(fitted: number, bootstrap: number, n: number): number {
  const w = n / (n + ETA_SHRINKAGE_K);
  return w * fitted + (1 - w) * bootstrap;
}

export interface EtaEstimate {
  mode: 'baseline' | 'survey';
  estimateMinutes: number;
  lowerMinutes: number;
  upperMinutes: number;
  basis: 'bootstrap' | 'blended';
  sampleCount: number;
  modelSampleCount: number;
  modelAdjustment: number;
  windowDays: number;
}

interface CachedFit {
  expiresAt: number;
  fit3: OlsFit3 | null;
  fit2: OlsFit2 | null;
  sampleCount: number;
  // model -> { ratio (observed/estimated, averaged), count }
  perModel: Map<string, { ratio: number; count: number }>;
}

@Injectable()
export class EtaService {
  private cachedFit: CachedFit | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly defaultModel: string,
  ) {}

  async estimate(params: { mode: 'baseline' | 'survey'; blockCount: number; figureCount: number; model?: string }): Promise<EtaEstimate> {
    if (params.mode === 'baseline') {
      // BASELINE never calls a model at all -- no query, no floor (the
      // floor exists to keep a SURVEY estimate from reading as
      // suspiciously fast; BASELINE's flat 1 minute is already as fast as
      // this system gets, and max(15, 1) would be a lie).
      return {
        mode: 'baseline',
        estimateMinutes: BASELINE_FLAT_MINUTES,
        lowerMinutes: BASELINE_FLAT_MINUTES,
        upperMinutes: BASELINE_FLAT_MINUTES,
        basis: 'bootstrap',
        sampleCount: 0,
        modelSampleCount: 0,
        modelAdjustment: 1,
        windowDays: ETA_WINDOW_DAYS,
      };
    }

    const { blockCount, figureCount } = params;
    // Empty/unspecified model resolves to the configured default BEFORE the
    // per-model cohort lookup -- otherwise "Default", the single most
    // common wizard selection, would permanently read as zero history even
    // once real data exists, because every one of those jobs is actually
    // stored under the resolved default model name, never under ''.
    const model = params.model && params.model.length > 0 ? params.model : this.defaultModel;

    const cached = await this.loadFit();
    const bootstrap = bootstrapMinutes(blockCount, figureCount);

    let fitted: number;
    let n: number;
    if (cached.fit3) {
      fitted = cached.fit3.a + cached.fit3.beta * blockCount + cached.fit3.gamma * figureCount;
      n = cached.sampleCount;
    } else if (cached.fit2) {
      const u = blockCount + 4 * figureCount;
      fitted = cached.fit2.a + cached.fit2.mu * u;
      n = cached.sampleCount;
    } else {
      // Cold start, or every guard degenerated -- pure bootstrap, n=0. This
      // is today's actual state (job history was wiped to zero by an
      // account reset), not a rare edge case, and is exercised on every
      // request until real SURVEY jobs complete.
      fitted = bootstrap;
      n = 0;
    }

    const blended = n > 0 ? blend(fitted, bootstrap, n) : bootstrap;

    const modelStats = cached.perModel.get(model);
    const modelAdjustment = modelStats
      ? clamp(
          weightedBlend(modelStats.ratio, 1, modelStats.count, ETA_MODEL_SHRINKAGE_K),
          ETA_MODEL_ADJUSTMENT_MIN,
          ETA_MODEL_ADJUSTMENT_MAX,
        )
      : 1;

    // Floor applied LAST, after the model adjustment -- and only for
    // SURVEY. No ceiling exists anywhere in this function, at any layer
    // (DESIGN.md §16.21): the whole point of this rewrite was that
    // underselling wait time is worse than overselling it.
    const estimateMinutes = Math.max(SURVEY_MIN_MINUTES, blended * modelAdjustment);

    return {
      mode: 'survey',
      estimateMinutes,
      lowerMinutes: estimateMinutes * ETA_RANGE_LOWER,
      upperMinutes: estimateMinutes * ETA_RANGE_UPPER,
      basis: n > 0 ? 'blended' : 'bootstrap',
      sampleCount: n,
      modelSampleCount: modelStats?.count ?? 0,
      modelAdjustment,
      windowDays: ETA_WINDOW_DAYS,
    };
  }

  private async loadFit(): Promise<CachedFit> {
    if (this.cachedFit && this.cachedFit.expiresAt > Date.now()) {
      return this.cachedFit;
    }

    const windowStart = new Date(Date.now() - ETA_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // No `status` predicate -- a rejected job ran the full pipeline and
    // produced a valid duration; rejection judges the output, not the
    // clock. Filtering on status='succeeded' (only reachable via
    // confirm()) was the mistake in an earlier draft of this design: it
    // would silently discard every rejected job's real timing data.
    // startedAt AND diffReadyAt both required, not diffReadyAt alone -- a
    // job already past the running transition when this migration lands
    // would get diffReadyAt but never a retroactive startedAt; including
    // it alone computes a NaN duration that poisons the entire fit, not
    // just that one row.
    const rows = await this.prisma.job.findMany({
      where: {
        mode: 'survey',
        startedAt: { not: null },
        diffReadyAt: { not: null, gte: windowStart },
        blockCount: { not: null },
        figureCount: { not: null },
      },
      orderBy: { diffReadyAt: 'desc' },
      take: ETA_WINDOW_MAX_SAMPLES,
      select: { blockCount: true, figureCount: true, model: true, startedAt: true, diffReadyAt: true },
    });

    const samples: EtaSample[] = [];
    for (const row of rows) {
      // startedAt/diffReadyAt are guaranteed non-null by the where clause;
      // blockCount/figureCount likewise. Non-null assertions here reflect
      // the query, not an assumption.
      const minutes = (row.diffReadyAt!.getTime() - row.startedAt!.getTime()) / 60_000;
      // Clock skew or a retried transition can produce a non-positive
      // duration -- drop it before it reaches the sums, not after; one bad
      // sample must not be able to poison every coefficient.
      if (minutes <= 0) continue;
      samples.push({
        blockCount: row.blockCount!,
        figureCount: row.figureCount!,
        model: row.model ?? this.defaultModel,
        minutes,
      });
    }

    const fit3 = fitOls3(samples);
    const fit2 = fit3 ? null : fitOls2(samples);
    const sampleCount = fit3 || fit2 ? samples.length : 0;

    // Per-model ratio: for each model with at least one sample, the mean of
    // (observed minutes / the blended-estimate-at-that-sample's own
    // blockCount+figureCount) -- computed in this SAME cached pass, not
    // per estimate() call, or every dropdown change would re-run the
    // sample query and defeat the point of caching the fit at all.
    const perModel = new Map<string, { ratio: number; count: number }>();
    if (sampleCount > 0) {
      const byModel = new Map<string, number[]>();
      for (const s of samples) {
        const baseline = fit3
          ? fit3.a + fit3.beta * s.blockCount + fit3.gamma * s.figureCount
          : fit2
            ? fit2.a + fit2.mu * (s.blockCount + 4 * s.figureCount)
            : bootstrapMinutes(s.blockCount, s.figureCount);
        const blended = blend(baseline, bootstrapMinutes(s.blockCount, s.figureCount), sampleCount);
        if (blended > 0) {
          const list = byModel.get(s.model) ?? [];
          list.push(s.minutes / blended);
          byModel.set(s.model, list);
        }
      }
      for (const [model, ratios] of byModel) {
        perModel.set(model, { ratio: ratios.reduce((a, b) => a + b, 0) / ratios.length, count: ratios.length });
      }
    }

    this.cachedFit = { expiresAt: Date.now() + ETA_FIT_CACHE_TTL_MS, fit3, fit2, sampleCount, perModel };
    return this.cachedFit;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Shared shrinkage shape for the per-model ratio: weight toward `value`
// grows with `count`, same w = n/(n+K) curve as blend() above but against
// a neutral prior (1.0, "no observed effect") instead of the bootstrap.
function weightedBlend(value: number, prior: number, count: number, k: number): number {
  const w = count / (count + k);
  return w * value + (1 - w) * prior;
}
