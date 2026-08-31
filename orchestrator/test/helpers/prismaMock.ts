/**
 * Shared fake-Prisma factory for the orchestrator's service specs.
 *
 * Why this exists: `jobs.service.spec.ts` hand-writes the same fake-Prisma
 * object ~145 times. The `confirm()` status-claim stub
 * (`job.updateMany` -> `{ count: 1 }`) alone is copied 95+ times to back a
 * SINGLE production call site -- when that claim landed, 93 of those copies
 * had to be patched by a mechanical `perl` pass. This factory exists so the
 * next such change is one edit here instead of ~95 there.
 *
 * Design constraints, deliberately chosen (see
 * docs/superpowers/plans/2026-08-31-sweep-shared-prisma-test-double.md):
 *
 *  - NARROW, NOT GENERAL. It declares exactly the three models the
 *    `confirm()`-family shape uses. There is no Proxy, no auto-vivified
 *    `jest.fn()`, no catch-all `$transaction`. A test that reaches for an
 *    undeclared model gets `undefined` and fails loudly -- exactly as it
 *    would today. Hiding an unexpected DB access behind a silent no-op is
 *    the specific failure mode this factory is built to avoid.
 *  - THE JOB ROW STAYS AT THE CALL SITE. `jobRow` is the first positional
 *    argument because it is the one thing each test genuinely varies, and
 *    it is what the test is really about. It must remain readable inline;
 *    it must never move into this file.
 *  - OVERRIDES ARE INSTALLED BY IDENTITY. A caller-owned `jest.fn()` passed
 *    in `overrides` is the same object the returned mock exposes, so
 *    `expect(mySpy)...` and `expect(prisma.model.method)...` are
 *    interchangeable and existing assertions convert unchanged.
 *
 * ADOPTION STATUS: partial by design. See
 * docs/handoff-sweep-prisma-mock-adoption.md for exactly which blocks are
 * converted, which are not, and why.
 *
 * Test-only. Never import this from `src/`.
 */

export type PrismaModelMock = Record<string, jest.Mock>;

export type PrismaMockOverrides = Record<string, PrismaModelMock>;

export interface ConfirmPrismaMock {
  job: PrismaModelMock;
  auditEntry: PrismaModelMock;
  createdItemMapping: PrismaModelMock;
  [model: string]: PrismaModelMock;
}

/**
 * The fake-Prisma shape the `confirm()`-family tests write by hand today.
 *
 * @param jobRow    what `job.findUnique` resolves -- the test's own fixture.
 * @param overrides per-model, per-method replacements. A known model is
 *                  shallow-merged over its defaults (siblings survive); an
 *                  unknown model is added verbatim.
 */
export function makeConfirmPrismaMock(jobRow: unknown, overrides: PrismaMockOverrides = {}): ConfirmPrismaMock {
  const defaults: Record<string, PrismaModelMock> = {
    job: {
      // Backs confirm()'s atomic status claim. `{ count: 1 }` means "this
      // caller won the claim", which is the default every existing test
      // assumes; a test exercising the lost-claim path overrides this with
      // `{ count: 0 }`.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(jobRow),
      update: jest.fn().mockResolvedValue(undefined),
    },
    auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    createdItemMapping: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };

  const result: Record<string, PrismaModelMock> = {};
  for (const [model, methods] of Object.entries(defaults)) {
    result[model] = { ...methods, ...(overrides[model] ?? {}) };
  }
  for (const [model, methods] of Object.entries(overrides)) {
    if (!(model in result)) result[model] = { ...methods };
  }
  return result as ConfirmPrismaMock;
}
