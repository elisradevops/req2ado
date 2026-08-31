import { makeConfirmPrismaMock } from './prismaMock';

describe('makeConfirmPrismaMock', () => {
  it('reproduces the canonical confirm() fake-Prisma shape', async () => {
    const jobRow = { id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'P\\A', dryRunDiff: [] };
    const prisma = makeConfirmPrismaMock(jobRow);

    await expect(prisma.job.updateMany({})).resolves.toEqual({ count: 1 });
    await expect(prisma.job.findUnique({})).resolves.toBe(jobRow);
    await expect(prisma.job.update({})).resolves.toBeUndefined();
    await expect(prisma.auditEntry.create({})).resolves.toBeUndefined();
    await expect(prisma.createdItemMapping.findMany({})).resolves.toEqual([]);
    await expect(prisma.createdItemMapping.upsert({})).resolves.toBeUndefined();
    await expect(prisma.createdItemMapping.update({})).resolves.toBeUndefined();
  });

  it('exposes every stub as an assertable jest.Mock', () => {
    const prisma = makeConfirmPrismaMock(null);
    for (const model of ['job', 'auditEntry', 'createdItemMapping'] as const) {
      for (const method of Object.keys(prisma[model])) {
        expect(jest.isMockFunction(prisma[model][method])).toBe(true);
      }
    }
  });

  it('declares exactly the three canonical models and no more', () => {
    const prisma = makeConfirmPrismaMock(null);
    expect(Object.keys(prisma).sort()).toEqual(['auditEntry', 'createdItemMapping', 'job']);
  });

  it('does not auto-vivify an undeclared model -- an unexpected access must fail loudly', () => {
    const prisma = makeConfirmPrismaMock(null);
    expect(prisma.jobFigureFile).toBeUndefined();
    expect(prisma.$transaction).toBeUndefined();
  });

  it('merges a per-method override without disturbing its siblings', async () => {
    const prisma = makeConfirmPrismaMock(null, {
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([{ localId: 'n0', adoWorkItemId: 500, linked: false }]) },
    });

    await expect(prisma.createdItemMapping.findMany({})).resolves.toEqual([{ localId: 'n0', adoWorkItemId: 500, linked: false }]);
    // siblings survive at their defaults
    await expect(prisma.createdItemMapping.upsert({})).resolves.toBeUndefined();
    await expect(prisma.createdItemMapping.update({})).resolves.toBeUndefined();
    // other models untouched
    await expect(prisma.job.updateMany({})).resolves.toEqual({ count: 1 });
  });

  it('installs a caller-owned spy by identity, so the caller and the mock are the same object', () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const prisma = makeConfirmPrismaMock(null, { createdItemMapping: { upsert } });

    expect(prisma.createdItemMapping.upsert).toBe(upsert);
  });

  it('adds an extra model verbatim when a test genuinely needs one', async () => {
    const deleteMany = jest.fn().mockResolvedValue(undefined);
    const prisma = makeConfirmPrismaMock(null, { jobFigureFile: { deleteMany } });

    expect(prisma.jobFigureFile.deleteMany).toBe(deleteMany);
    await expect(prisma.job.updateMany({})).resolves.toEqual({ count: 1 });
  });

  it('returns an independent mock graph per call, so call counts never leak between tests', async () => {
    const a = makeConfirmPrismaMock(null);
    const b = makeConfirmPrismaMock(null);

    expect(a.job.update).not.toBe(b.job.update);
    await a.job.update({});
    expect(a.job.update).toHaveBeenCalledTimes(1);
    expect(b.job.update).not.toHaveBeenCalled();
  });

  it('resolves the exact jobRow instance passed in, including null', async () => {
    const jobRow = { id: 'job-9' };
    await expect(makeConfirmPrismaMock(jobRow).job.findUnique({})).resolves.toBe(jobRow);
    await expect(makeConfirmPrismaMock(null).job.findUnique({})).resolves.toBeNull();
  });
});
