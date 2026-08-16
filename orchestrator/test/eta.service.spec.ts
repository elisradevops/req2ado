import {
  EtaService,
  bootstrapMinutes,
  fitOls3,
  fitOls2,
  blend,
  BOOTSTRAP_BASE_MINUTES,
  BOOTSTRAP_MINUTES_PER_BLOCK,
  BOOTSTRAP_MINUTES_PER_FIGURE,
  BOOTSTRAP_FIGURE_BLOCK_RATIO,
  combinedUnit,
  SURVEY_MIN_MINUTES,
  BASELINE_FLAT_MINUTES,
  ETA_SHRINKAGE_K,
  type EtaSample,
} from '../src/modules/pipeline/eta.service';

// Real AirPro_BP_ICD_Revision_0.3.docx observation (DESIGN.md §18's ledger):
// 682 blocks, 39 figures, SURVEY, ~90 real minutes -- measured BEFORE Part
// B split per-branch generation into three stages. The bootstrap is
// calibrated off that observation, but no longer equal to it: task B6
// re-derived the block coefficient for the post-Part-B pipeline (see the
// recalibration note in eta.service.ts).
const PRE_PART_B_OBSERVED_MINUTES = 90;

describe('bootstrapMinutes', () => {
  it('is exactly the documented base + per-block + per-figure formula', () => {
    const minutes = bootstrapMinutes(682, 39);
    expect(minutes).toBeCloseTo(BOOTSTRAP_BASE_MINUTES + 682 * BOOTSTRAP_MINUTES_PER_BLOCK + 39 * BOOTSTRAP_MINUTES_PER_FIGURE, 5);
  });

  it('projects the one real observation forward through Part B rather than still predicting its pre-Part-B duration', () => {
    // B6: the same document is now expected to cost meaningfully MORE than
    // the ~90 min it took under the single-call-per-branch architecture --
    // but well short of the naive 3x a raw call count would imply, because
    // decode (the dominant term) is split between stages rather than
    // repeated. This is the guard against someone silently reverting the
    // per-block coefficient to its pre-Part-B 0.10.
    const minutes = bootstrapMinutes(682, 39);
    expect(minutes).toBeGreaterThan(PRE_PART_B_OBSERVED_MINUTES * 1.3);
    expect(minutes).toBeLessThan(PRE_PART_B_OBSERVED_MINUTES * 2);
  });

  it('raises the block cost for Part B without touching the figure cost, which Part B never made more expensive', () => {
    // The mapping stage is batched per BRANCH, and vision captioning (the
    // real per-figure cost) happens during parse, untouched. Encoding this
    // asymmetry is the point: an "obvious" symmetric bump of both
    // coefficients would double-charge every figure-heavy document.
    expect(BOOTSTRAP_MINUTES_PER_BLOCK).toBeCloseTo(0.175, 5);
    expect(BOOTSTRAP_MINUTES_PER_FIGURE).toBeCloseTo(0.4, 5);
  });

  it('never returns something absurd for a tiny document', () => {
    expect(bootstrapMinutes(0, 0)).toBe(BOOTSTRAP_BASE_MINUTES);
  });
});

describe('combinedUnit / BOOTSTRAP_FIGURE_BLOCK_RATIO', () => {
  it('derives the fallback fit\'s figure weight from the bootstrap constants, never from a hardcoded literal', () => {
    // Part B moved the block coefficient and deliberately left the figure
    // one alone, so the ratio is no longer the 4:1 fitOls2 used to spell
    // out inline. Deriving it is what keeps that from becoming a silent
    // lie the next time either constant moves.
    expect(BOOTSTRAP_FIGURE_BLOCK_RATIO).toBeCloseTo(BOOTSTRAP_MINUTES_PER_FIGURE / BOOTSTRAP_MINUTES_PER_BLOCK, 10);
    expect(BOOTSTRAP_FIGURE_BLOCK_RATIO).not.toBeCloseTo(4, 1);
    expect(combinedUnit(100, 10)).toBeCloseTo(100 + BOOTSTRAP_FIGURE_BLOCK_RATIO * 10, 10);
  });
});

function sample(blockCount: number, figureCount: number, minutes: number, model = 'model-a'): EtaSample {
  return { blockCount, figureCount, minutes, model };
}

describe('fitOls3', () => {
  it('recovers a known linear relationship exactly, given noise-free samples', () => {
    // y = 5 + 0.2*b + 1.5*f, sampled at four non-collinear (b, f) points.
    const samples: EtaSample[] = [
      sample(0, 0, 5),
      sample(100, 0, 25),
      sample(0, 20, 35),
      sample(200, 10, 60),
    ];
    const fit = fitOls3(samples);
    expect(fit).not.toBeNull();
    expect(fit!.a).toBeCloseTo(5, 1);
    expect(fit!.beta).toBeCloseTo(0.2, 1);
    expect(fit!.gamma).toBeCloseTo(1.5, 1);
  });

  it('returns null on a deliberately collinear sample set (singular matrix)', () => {
    // figureCount is always exactly blockCount/10 -- the (block, figure)
    // pair carries only one real degree of freedom, so the 3x3 system is
    // singular regardless of how many such points are added.
    const samples: EtaSample[] = [
      sample(100, 10, 20),
      sample(200, 20, 35),
      sample(300, 30, 50),
      sample(400, 40, 65),
    ];
    expect(fitOls3(samples)).toBeNull();
  });

  it('returns null when a coefficient solves negative (too few/noisy samples, not a real fit)', () => {
    // Two points where the naive interpolation implies a negative
    // figure-count weight.
    const samples: EtaSample[] = [sample(100, 50, 20), sample(100, 10, 40)];
    const fit = fitOls3(samples);
    // Either genuinely null (degenerate) or, if solved, must never carry a
    // non-positive coefficient through as if it were trustworthy.
    if (fit) {
      expect(fit.beta).toBeGreaterThan(0);
      expect(fit.gamma).toBeGreaterThan(0);
    }
  });

  it('returns null for zero samples', () => {
    expect(fitOls3([])).toBeNull();
  });
});

describe('fitOls2 (fallback fit on the combined unit u = b + r*f)', () => {
  it('recovers a known linear relationship on the combined unit', () => {
    // y = 8 + 0.3*u, with u built via combinedUnit rather than a
    // spelled-out b + 4f -- the ratio is derived from the bootstrap
    // constants and Part B already moved it, so pinning a literal here
    // would only test a number this suite itself copied.
    const samples: EtaSample[] = [
      sample(0, 0, 8),
      sample(100, 0, 8 + 0.3 * combinedUnit(100, 0)),
      sample(0, 25, 8 + 0.3 * combinedUnit(0, 25)),
    ];
    const fit = fitOls2(samples);
    expect(fit).not.toBeNull();
    expect(fit!.mu).toBeCloseTo(0.3, 1);
    expect(fit!.a).toBeCloseTo(8, 1);
  });

  it('returns null when every sample collapses to the same u (fewer than 2 distinct values)', () => {
    // Both samples land on the identical u by construction -- no variance
    // to fit a slope against.
    const samples: EtaSample[] = [sample(combinedUnit(0, 25), 0, 20), sample(0, 25, 45)];
    expect(fitOls2(samples)).toBeNull();
  });

  it('returns null when the fitted slope is non-positive', () => {
    const samples: EtaSample[] = [sample(0, 0, 50), sample(100, 0, 10)];
    expect(fitOls2(samples)).toBeNull();
  });
});

describe('blend', () => {
  it('weights toward bootstrap at n=0 and toward fitted as n grows, via w = n/(n+K)', () => {
    expect(blend(100, 50, 0)).toBe(50);
    const atK = blend(100, 50, ETA_SHRINKAGE_K);
    expect(atK).toBeCloseTo(75, 5); // w=0.5 exactly when n===K
    const large = blend(100, 50, 1000);
    expect(large).toBeGreaterThan(90); // large n -> mostly fitted
  });
});

function fakePrisma(rows: any[]): any {
  return { job: { findMany: jest.fn().mockResolvedValue(rows) } };
}

function row(overrides: Partial<{ blockCount: number; figureCount: number; model: string | null; startedAt: Date; diffReadyAt: Date }>) {
  const startedAt = overrides.startedAt ?? new Date('2026-08-01T00:00:00Z');
  const diffReadyAt = overrides.diffReadyAt ?? new Date('2026-08-01T01:00:00Z'); // 60 real minutes
  return {
    blockCount: overrides.blockCount ?? 200,
    figureCount: overrides.figureCount ?? 10,
    model: overrides.model === undefined ? 'model-a' : overrides.model,
    startedAt,
    diffReadyAt,
  };
}

describe('EtaService', () => {
  it('BASELINE: flat 1 minute, no DB query, no floor applied', async () => {
    const prisma = fakePrisma([]);
    const service = new EtaService(prisma, 'model-a');

    const result = await service.estimate({ mode: 'baseline', blockCount: 999999, figureCount: 999999 });

    expect(result.estimateMinutes).toBe(BASELINE_FLAT_MINUTES);
    expect(result.lowerMinutes).toBe(BASELINE_FLAT_MINUTES);
    expect(result.upperMinutes).toBe(BASELINE_FLAT_MINUTES);
    expect(result.basis).toBe('bootstrap');
    expect(prisma.job.findMany).not.toHaveBeenCalled();
  });

  it('cold start (n=0, the literal post-account-reset state): pure bootstrap, cached', async () => {
    const prisma = fakePrisma([]);
    const service = new EtaService(prisma, 'model-a');

    const first = await service.estimate({ mode: 'survey', blockCount: 682, figureCount: 39 });
    expect(first.basis).toBe('bootstrap');
    expect(first.sampleCount).toBe(0);
    // Real (pre-Part-B) observation was ~90 min, and B6's recalibration
    // projects that same document forward to ~145 -- the cold estimate must
    // be in a believable neighborhood of that, not the old ~356-564 min the
    // two reversed hand-picked formulas produced.
    expect(first.estimateMinutes).toBeGreaterThan(PRE_PART_B_OBSERVED_MINUTES);
    expect(first.estimateMinutes).toBeLessThan(PRE_PART_B_OBSERVED_MINUTES * 2.5);

    // Second call within the cache TTL must not re-query.
    await service.estimate({ mode: 'survey', blockCount: 100, figureCount: 5 });
    expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
  });

  it('never caps the estimate for a genuinely large document -- the regression the 2026-08-05 fix protects', async () => {
    const prisma = fakePrisma([]);
    const service = new EtaService(prisma, 'model-a');

    const result = await service.estimate({ mode: 'survey', blockCount: 100000, figureCount: 5000 });
    expect(result.estimateMinutes).toBeGreaterThan(40);
  });

  it('the sample query carries NO status predicate -- rejected jobs ran the full pipeline and must count', async () => {
    const prisma = fakePrisma([row({})]);
    const service = new EtaService(prisma, 'model-a');

    await service.estimate({ mode: 'survey', blockCount: 200, figureCount: 10 });

    const whereArg = prisma.job.findMany.mock.calls[0][0].where;
    expect(whereArg).not.toHaveProperty('status');
    expect(whereArg.mode).toBe('survey');
    expect(whereArg.startedAt).toEqual({ not: null });
    expect(whereArg.diffReadyAt).toEqual(expect.objectContaining({ not: null }));
  });

  it('drops non-positive-duration samples before they reach the fit (clock skew / retry artifacts)', async () => {
    const bad = row({ startedAt: new Date('2026-08-01T02:00:00Z'), diffReadyAt: new Date('2026-08-01T01:00:00Z') }); // negative
    const prisma = fakePrisma([bad]);
    const service = new EtaService(prisma, 'model-a');

    const result = await service.estimate({ mode: 'survey', blockCount: 200, figureCount: 10 });
    // With the single sample dropped, this must fall back to pure bootstrap
    // (n=0), not attempt a fit on a poisoned/absent sample.
    expect(result.basis).toBe('bootstrap');
    expect(result.sampleCount).toBe(0);
  });

  it('resolves an empty/unspecified model to the configured default before the per-model cohort lookup', async () => {
    // Every real sample ran under the resolved default ("model-a"), never
    // under the literal empty string -- confirming "Default" (the most
    // common wizard selection) is not permanently invisible to the
    // per-model adjustment. Both inputs (blockCount/figureCount) AND the
    // duration vary together across rows with a real positive
    // relationship -- constant duration against varying inputs (or vice
    // versa) is itself a degenerate zero-slope case that correctly trips
    // fitOls3/fitOls2's "coefficient must be positive" guard, which is not
    // what this test is about (that's the singular-matrix/non-positive-
    // slope tests above); this one is purely about model-cohort resolution.
    const rows = Array.from({ length: 6 }, (_, i) =>
      row({
        model: 'model-a',
        blockCount: 100 + i * 37,
        figureCount: 5 + i * 3,
        startedAt: new Date('2026-08-01T00:00:00Z'),
        diffReadyAt: new Date(new Date('2026-08-01T00:00:00Z').getTime() + (20 + i * 5) * 60_000),
      }),
    );
    const prisma = fakePrisma(rows);
    const service = new EtaService(prisma, 'model-a');

    const withDefault = await service.estimate({ mode: 'survey', blockCount: 200, figureCount: 10, model: undefined });
    expect(withDefault.modelSampleCount).toBe(6);

    const explicit = await service.estimate({ mode: 'survey', blockCount: 200, figureCount: 10, model: 'model-a' });
    expect(explicit.modelSampleCount).toBe(6);
  });

  it('a window of pre-Part-B-speed jobs still estimates ABOVE what that old architecture predicts -- the B6 mitigation', async () => {
    // The exact scenario B6 exists for: this branch merges, the trailing
    // window is still full of jobs that ran under the OLD one-call-per-
    // branch pipeline, and the fit those jobs produce is genuinely too fast
    // for the work the next job will actually do. No version column filters
    // them out (a deliberate non-change, see loadFit's own comment); what
    // protects the estimate instead is that shrinkage keeps a large share
    // of the weight on the bootstrap, and B6 moved the bootstrap to the
    // post-Part-B cost.
    //
    // Samples are generated noise-free from the PRE-Part-B cost model
    // (y = 10 + 0.10b + 0.40f, the coefficients this file shipped before
    // Part B), so fitOls3 recovers that old model essentially exactly and
    // the test measures the mitigation, not fit error.
    const oldArchitectureMinutes = (b: number, f: number): number => 10 + 0.1 * b + 0.4 * f;
    const blocks = [200, 300, 400, 500, 600, 700, 800, 900];
    const figures = [5, 25, 10, 40, 15, 50, 20, 60];
    const startedAt = new Date('2026-08-01T00:00:00Z');
    const rows = blocks.map((b, i) =>
      row({
        model: 'model-a',
        blockCount: b,
        figureCount: figures[i],
        startedAt,
        diffReadyAt: new Date(startedAt.getTime() + oldArchitectureMinutes(b, figures[i]) * 60_000),
      }),
    );
    const service = new EtaService(fakePrisma(rows), 'model-a');

    const result = await service.estimate({ mode: 'survey', blockCount: 682, figureCount: 39 });

    expect(result.basis).toBe('blended');
    expect(result.sampleCount).toBe(blocks.length);
    // Strictly above the old architecture's own prediction, by a real
    // margin rather than a rounding wobble -- if the bootstrap were still
    // the pre-Part-B 0.10/block, blending toward it would land ON that
    // number and the estimate would undersell exactly the jobs Part B just
    // made slower.
    const oldPrediction = oldArchitectureMinutes(682, 39);
    expect(result.estimateMinutes).toBeGreaterThan(oldPrediction * 1.05);
    // ...and still below the pure post-Part-B bootstrap: real observed
    // durations, even stale ones, are allowed to pull the estimate down.
    // Shrinkage is a brake, not an override.
    expect(result.estimateMinutes).toBeLessThan(bootstrapMinutes(682, 39));
  });

  it('an unseen model gets a neutral 1.0 adjustment, never a guess', async () => {
    const rows = Array.from({ length: 10 }, () => row({ model: 'model-a' }));
    const prisma = fakePrisma(rows);
    const service = new EtaService(prisma, 'model-a');

    const result = await service.estimate({ mode: 'survey', blockCount: 200, figureCount: 10, model: 'never-seen-before' });
    expect(result.modelAdjustment).toBe(1);
    expect(result.modelSampleCount).toBe(0);
  });

  it('SURVEY floor (15 min) is applied last, after the model adjustment, and never as a ceiling', async () => {
    const prisma = fakePrisma([]);
    const service = new EtaService(prisma, 'model-a');

    const result = await service.estimate({ mode: 'survey', blockCount: 0, figureCount: 0 });
    expect(result.estimateMinutes).toBeGreaterThanOrEqual(SURVEY_MIN_MINUTES);
  });

  it('range is 0.75x/1.25x of the estimate, computed server-side', async () => {
    const prisma = fakePrisma([]);
    const service = new EtaService(prisma, 'model-a');

    const result = await service.estimate({ mode: 'survey', blockCount: 682, figureCount: 39 });
    expect(result.lowerMinutes).toBeCloseTo(result.estimateMinutes * 0.75, 5);
    expect(result.upperMinutes).toBeCloseTo(result.estimateMinutes * 1.25, 5);
  });
});
