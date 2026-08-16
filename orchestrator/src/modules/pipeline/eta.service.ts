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
// below). Originally calibrated to the ONE real observation available: a
// 682-block, 39-figure SURVEY job that actually took ~90 minutes --
// 10 + 682*0.10 + 39*0.40 = 93.8 min, ~4% high (the safe direction to be
// wrong in). That observation predates Part B's three-stage generation
// split, so the block coefficient has since been re-derived from it rather
// than read off it directly; see the recalibration note below. This is
// explicitly NOT knowledge -- one data point calibrates a formula's scale,
// not its shape. What survives from the earlier, reversed formula is that a
// figure costs MORE than a text block (each figure triggers a separate
// vision-model call) -- not the absolute scale of either coefficient, and
// no longer the specific 4:1 ratio either.
//
// PART B RECALIBRATION (task B6). SURVEY's per-branch generation used to be
// ONE LLM call producing a branch's structure AND all of its requirement
// text at once. Part B split it into three ordered stages (ingestion's
// llm_leveling.build_survey_tree): a skeleton call per branch, one
// whole-document figure/table -> node mapping pass, then a content-authoring
// call per branch. Three calls where there was one -- but NOT three times
// the wall clock, and the difference is the whole point of doing this
// arithmetic rather than multiplying by the call count:
//
//   * decode, the dominant term for a self-hosted model, barely moves. The
//     old call's output was structure + text; stage 1 now emits the
//     structure and stage 3 emits the text. Roughly the same tokens, split
//     across two calls. Stage 2 emits ids -- almost nothing.
//   * prefill is paid ~3x. Every stage re-sends the section (stage 3 also
//     sends the now-final tree), and stage 2 sends the branch's node list
//     plus its figure/table inventory.
//   * two new document-wide BARRIERS appear. Branches used to be
//     embarrassingly parallel end to end; now every branch must finish
//     stage 1 before mapping starts, and mapping must finish before any
//     branch starts stage 3. At branch_concurrency > 1 that is three
//     max-latency waits instead of one, which costs more than a
//     sum-of-work model predicts.
//
// Taking prefill at ~40% of the old call, and its structure:text decode
// split at ~20:80, puts the new per-branch cost at ~1.6x the old. Rounded
// UP to 1.75x (0.10 -> 0.175 min/block) for the barrier effect and because
// this file's stated bias is that overselling wait time beats underselling
// it (see the no-ceiling note in estimate()).
//
// BOOTSTRAP_MINUTES_PER_FIGURE deliberately does NOT move. The per-figure
// cost is the vision captioning call, which happens during parse and which
// Part B never touched; the new mapping stage is batched per BRANCH, not
// per figure ("Cost scales with branch count, not figure count" --
// _map_figures_tables_to_nodes' own docstring). Raising it too would have
// been the easy, wrong symmetry. The consequence is that the figure:block
// ratio this file asserts moves from 4:1 to ~2.3:1 -- see
// BOOTSTRAP_FIGURE_BLOCK_RATIO below, which is why that is now derived
// rather than written out as a literal in fitOls2.
//
// The one real observation above was measured PRE-Part-B. 10 + 682*0.175 +
// 39*0.40 = 145 min is what that same document is now expected to cost.
// That is a projection, not a measurement -- the self-tuning fit below is
// what replaces it with real numbers, and the whole reason this file
// exists.
export const BOOTSTRAP_BASE_MINUTES = 10;
export const BOOTSTRAP_MINUTES_PER_BLOCK = 0.175;
export const BOOTSTRAP_MINUTES_PER_FIGURE = 0.4;

// The figure:block cost ratio the bootstrap itself asserts, and the only
// source fitOls2's combined unit takes its weight from -- DERIVED, never
// re-typed as a literal, so the two cannot silently drift apart the way
// they would have when Part B moved the block coefficient and left the
// figure one alone.
export const BOOTSTRAP_FIGURE_BLOCK_RATIO = BOOTSTRAP_MINUTES_PER_FIGURE / BOOTSTRAP_MINUTES_PER_BLOCK;

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

// The single combined predictor fitOls2 falls back to -- one function, used
// by the fit itself AND by every site that evaluates that fit, so a change
// to the ratio can never land in one of the three and not the others.
export function combinedUnit(blockCount: number, figureCount: number): number {
  return blockCount + BOOTSTRAP_FIGURE_BLOCK_RATIO * figureCount;
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
// count into one combined unit using the bootstrap's own figure:block
// weight ratio (u = b + r*f, r = BOOTSTRAP_FIGURE_BLOCK_RATIO), and fit
// y ~ a + mu*u -- a simple 2x2 linear regression, not a second matrix
// solve. Returns null if THIS also degenerates (fewer than 2 distinct u
// values, or a non-positive slope) -- at that point there is nothing left
// to trust and the caller falls all the way back to the bootstrap.
export function fitOls2(samples: EtaSample[]): OlsFit2 | null {
  const points = samples.map((s) => ({ u: combinedUnit(s.blockCount, s.figureCount), y: s.minutes }));
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
      fitted = cached.fit2.a + cached.fit2.mu * combinedUnit(blockCount, figureCount);
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
    //
    // Part B task B6, a DELIBERATE non-change: there is no
    // architecture/pipeline-version discriminator on these rows, and none
    // was added. Part B made SURVEY genuinely slower per block, so for a
    // while this window can mix pre-Part-B (faster) and post-Part-B
    // (slower) durations and fit something optimistic between them. Three
    // reasons that is the right trade rather than a new column plus a
    // same-version-only filter:
    //   1. The mixing is self-limiting by construction. ETA_WINDOW_DAYS
    //      exists for exactly this ("so a GPU swap or model-lineup change
    //      fades out of the fit within a quarter"); a pipeline
    //      re-architecture is the same class of event as a model swap, not
    //      a new one, and the 50-row cap ages it out faster still on any
    //      deployment doing real volume.
    //   2. While post-Part-B samples are still few, shrinkage (blend(),
    //      ETA_SHRINKAGE_K = 8) keeps most of the weight on the bootstrap
    //      -- which B6 already moved to the post-Part-B cost. So the
    //      transient reads HIGH, not low, which is the direction this file
    //      chooses to be wrong in.
    //   3. A version column has to be bumped by hand on every future
    //      pipeline change or it starts silently lying, and on the first
    //      deployment to adopt it, "same version only" discards every real
    //      sample and lands back on the bootstrap regardless. More schema
    //      and more ceremony for the same answer the bootstrap already
    //      gives.
    // Pre-Part-B rows stay valid, readable and in the window -- nothing is
    // deleted, reset or invalidated to make this work.
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
            ? fit2.a + fit2.mu * combinedUnit(s.blockCount, s.figureCount)
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
