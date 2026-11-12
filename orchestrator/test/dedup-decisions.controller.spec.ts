import { BadRequestException } from '@nestjs/common';
import { DedupDecisionsController } from '../src/modules/pipeline/dedup-decisions.controller';

const ROW = {
  id: '1', jobId: 'job-1', localId: 'n1', itemType: 'Requirement', areaPath: 'P\\A', scope: 'area_path', candidateTitle: 'T', candidateText: 'text', matchedAdoId: 5,
  matchedText: 'existing', similarity: 0.95, threshold: 0.9, judgeVerdict: 'redundant', decision: 'skipped', reviewerOutcome: null, reviewerAt: null, createdAt: new Date('2026-11-12T10:00:00Z'),
};

function build(rows: unknown[] = [ROW]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const controller = new DedupDecisionsController({ dedupDecisionLog: { findMany } } as any);
  const res = { type: jest.fn(), setHeader: jest.fn() };
  return { controller, findMany, res };
}

describe('GET /dedup/decisions', () => {
  it('returns the rows as JSON by default', async () => {
    const { controller, res } = build();

    await expect(controller.list({}, res as any)).resolves.toEqual([ROW]);
  });

  it('passes the filters on, parsed', async () => {
    const { controller, findMany, res } = build();

    await controller.list({ since: '2026-11-01', until: '2026-11-30T00:00:00Z', jobId: 'job-1', outcome: 'created_anyway', limit: '50' }, res as any);

    expect(findMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: new Date('2026-11-01'), lte: new Date('2026-11-30T00:00:00Z') }, jobId: 'job-1', reviewerOutcome: 'created_anyway' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('returns CSV, with its content type, when asked', async () => {
    const { controller, res } = build();

    const body = await controller.list({ format: 'csv' }, res as any);

    expect(res.type).toHaveBeenCalledWith('text/csv; charset=utf-8');
    expect(typeof body).toBe('string');
    expect(String(body).split('\r\n')[0]).toMatch(/^id,jobId,localId/);
  });

  it.each([
    [{ since: 'not a date' }],
    [{ until: '31/31/2026' }],
    [{ outcome: 'whatever' }],
    [{ format: 'xml' }],
    [{ limit: 'many' }],
  ])('refuses a bad query: %j', async (query) => {
    const { controller, findMany, res } = build();

    await expect(controller.list(query as any, res as any)).rejects.toThrow(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });
});
