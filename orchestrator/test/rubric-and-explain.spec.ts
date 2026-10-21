// JobsService opens a bullmq Queue (a real ioredis connection) in its constructor: inert here, as in jobs.service.spec.ts.
jest.mock('bullmq');

import { BadGatewayException, BadRequestException, GatewayTimeoutException, NotFoundException } from '@nestjs/common';
import { KbController } from '../src/modules/kb/kb.controller';
import { KbService } from '../src/modules/kb/kb.service';
import { IngestionHttpClient, IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';
import { JobsService } from '../src/modules/pipeline/jobs.service';
import type { SessionUser } from '../src/modules/auth/session.service';

const USER: SessionUser = { userId: 'user-1', displayName: 'Test' };
const rubric = { version: 'v1', source: 'kb', builtAt: null, categories: [{ name: 'Testable', passCondition: 'Can be verified', guidance: null, pinned: false, origin: 'kb', sources: ['A'], mergedFrom: ['Testable'] }], removed: [] };

describe('IngestionHttpClient: the rubric and the explanation', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  const client = () => new IngestionHttpClient('http://ingestion.internal');

  it('reads the rubric of a user', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => rubric });
    expect(await client().getRubric('user-1')).toEqual(rubric);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/kb/rubric'); // identity travels in a header, never in the URL
    expect(options.headers['X-Req2Ado-User-Id']).toBe('user-1');
  });

  it('stores the pins and removals of a user and returns the rubric that results', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => rubric });
    const result = await client().putRubric('user-1', { pinned: [{ name: 'Testable', passCondition: 'Pinned' }], removed: ['Essential'] });
    expect(result).toEqual(rubric);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/kb/rubric');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ user_id: 'user-1', pinned: [{ name: 'Testable', passCondition: 'Pinned' }], removed: ['Essential'] });
  });

  it('keeps ingestion\'s reason when it refuses a list', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ detail: 'a category name must be 1-80 characters' }), json: async () => ({ detail: 'a category name must be 1-80 characters' }) });
    await expect(client().putRubric('user-1', { pinned: [], removed: [] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('category name') });
  });

  it('asks for the explanation of an item\'s scores with its context, and returns what ingestion answers', async () => {
    const answer = { explanations: [{ category: 'Verifiable', score: 20, reason: 'No limit is stated.', passCondition: 'Measurable' }], basis: 'built_in', rubric: { source: 'default', version: 'default-rubric-1' } };
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => answer });
    const result = await client().explainScores({
      title: 'T', description: 'D', type: 'Requirement', categoryScores: { Verifiable: 20 }, categories: undefined,
      context: { parents: [] }, userId: 'user-1', model: 'claude-opus-4-8',
    });
    expect(result).toEqual(answer);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://ingestion.internal/score-explain');
    expect(JSON.parse(options.body)).toEqual({
      title: 'T', description: 'D', type: 'Requirement', category_scores: { Verifiable: 20 }, context: { parents: [] }, user_id: 'user-1', model: 'claude-opus-4-8',
    });
  });
});

describe('KbController: the rubric', () => {
  it('shows and stores the rubric of the session user, never of someone else', async () => {
    const kbService = { getRubric: jest.fn().mockResolvedValue(rubric), putRubric: jest.fn().mockResolvedValue(rubric) };
    const controller = new KbController(kbService as any);
    expect(await controller.getRubric(USER)).toBe(rubric);
    expect(kbService.getRubric).toHaveBeenCalledWith('user-1');
    await controller.putRubric(USER, { pinned: [{ name: 'Testable', passCondition: 'Pinned' }], removed: ['X'] });
    expect(kbService.putRubric).toHaveBeenCalledWith('user-1', { pinned: [{ name: 'Testable', passCondition: 'Pinned' }], removed: ['X'] });
  });

  it('refuses a malformed body without calling the service', async () => {
    const kbService = { putRubric: jest.fn() };
    const controller = new KbController(kbService as any);
    await expect(controller.putRubric(USER, { pinned: 'nope' as never, removed: [] })).rejects.toThrow(BadRequestException);
    await expect(controller.putRubric(USER, { pinned: [{ name: 'A' }] as never, removed: [] })).rejects.toThrow(BadRequestException);
    await expect(controller.putRubric(USER, { pinned: [], removed: [5] as never })).rejects.toThrow(BadRequestException);
    expect(kbService.putRubric).not.toHaveBeenCalled();
  });

  it('turns ingestion\'s refusal of a list into a 400 with its reason (and passes other failures on)', async () => {
    const refused = new KbController({ putRubric: jest.fn().mockRejectedValue(new IngestionHttpError(400, 'category \'A\' is listed twice')) } as any);
    await expect(refused.putRubric(USER, { pinned: [{ name: 'A', passCondition: 'x' }], removed: [] })).rejects.toThrow(/listed twice/);
    await expect(refused.putRubric(USER, { pinned: [{ name: 'A', passCondition: 'x' }], removed: [] })).rejects.toBeInstanceOf(BadRequestException);
    const down = new KbController({ putRubric: jest.fn().mockRejectedValue(new IngestionHttpError(502, 'down')) } as any);
    await expect(down.putRubric(USER, { pinned: [], removed: [] })).rejects.toBeInstanceOf(IngestionHttpError);
  });
});

describe('KbService: the rubric', () => {
  it('passes the user and the lists to ingestion', async () => {
    const ingestionClient = { getRubric: jest.fn().mockResolvedValue(rubric), putRubric: jest.fn().mockResolvedValue(rubric) };
    const service = new KbService({} as any, ingestionClient as any, {} as any);
    expect(await service.getRubric('user-1')).toBe(rubric);
    await service.putRubric('user-1', { pinned: [], removed: ['X'] });
    expect(ingestionClient.putRubric).toHaveBeenCalledWith('user-1', { pinned: [], removed: ['X'] });
  });
});

describe('JobsService.explainScore', () => {
  const entry = {
    localId: 'n0', parentLocalId: 'f1', type: 'Requirement', title: 'Lock time', description: 'The receiver shall lock fast.', action: 'create',
    qualityCategoryScores: { Verifiable: 20, Necessary: 90 },
  };
  const feature = { localId: 'f1', parentLocalId: null, type: 'Feature', title: 'Carrier acquisition', description: 'How lock is found.', action: 'create' };
  const job = { id: 'job-1', status: 'diff_ready', userId: 'user-1', model: 'claude-opus-4-8', filename: 'AirPro.docx', dryRunDiff: [feature, entry] };
  const answer = { explanations: [], basis: 'built_in', rubric: { source: 'default', version: 'v' } };
  const make = (explainScores: jest.Mock, jobRow: unknown = job) => new JobsService({ job: { findUnique: jest.fn().mockResolvedValue(jobRow) } } as any, {} as any, {} as any, { explainScores } as any, 'redis://unused');

  it('asks ingestion with the item, its scores, where it sits in the document, and the job\'s user and model', async () => {
    const explainScores = jest.fn().mockResolvedValue(answer);
    const result = await make(explainScores).explainScore('job-1', 'n0', {});
    expect(result).toBe(answer);
    expect(explainScores).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Lock time', description: 'The receiver shall lock fast.', type: 'Requirement', categoryScores: { Verifiable: 20, Necessary: 90 },
      userId: 'user-1', model: 'claude-opus-4-8',
      context: expect.objectContaining({ documentName: 'AirPro.docx', parents: [expect.objectContaining({ title: 'Carrier acquisition' })] }),
    }));
  });

  it('passes the categories the user asked about', async () => {
    const explainScores = jest.fn().mockResolvedValue(answer);
    await make(explainScores).explainScore('job-1', 'n0', { categories: ['Necessary'] });
    expect(explainScores).toHaveBeenCalledWith(expect.objectContaining({ categories: ['Necessary'] }));
  });

  it('refuses a missing job or entry and an entry that was never scored, and changes nothing', async () => {
    const explainScores = jest.fn();
    await expect(make(explainScores, null).explainScore('job-1', 'n0', {})).rejects.toThrow(NotFoundException);
    await expect(make(explainScores).explainScore('job-1', 'zz', {})).rejects.toThrow(NotFoundException);
    await expect(make(explainScores, { ...job, dryRunDiff: [{ ...entry, qualityCategoryScores: null }] }).explainScore('job-1', 'n0', {})).rejects.toThrow(BadRequestException);
    expect(explainScores).not.toHaveBeenCalled();
  });

  it('keeps the kind of ingestion failure: a refusal is a 400, a timeout a 504, anything else a 502, each with the reason', async () => {
    const failing = (status: number, message: string) => make(jest.fn().mockRejectedValue(new IngestionHttpError(status, message)));
    await expect(failing(400, 'the item has no category scores to explain').explainScore('job-1', 'n0', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(failing(504, 'the explanation is taking too long; try again').explainScore('job-1', 'n0', {})).rejects.toBeInstanceOf(GatewayTimeoutException);
    await expect(failing(504, 'the explanation is taking too long; try again').explainScore('job-1', 'n0', {})).rejects.toThrow(/taking too long/);
    await expect(failing(502, 'the explanation could not be made').explainScore('job-1', 'n0', {})).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('an entry whose scores are an empty object has nothing to explain either', async () => {
    const explainScores = jest.fn();
    await expect(make(explainScores, { ...job, dryRunDiff: [{ ...entry, qualityCategoryScores: {} }] }).explainScore('job-1', 'n0', {})).rejects.toThrow(BadRequestException);
    expect(explainScores).not.toHaveBeenCalled();
  });

  it('does not need the job to be reviewable: a finished job\'s scores can still be explained', async () => {
    const explainScores = jest.fn().mockResolvedValue(answer);
    await expect(make(explainScores, { ...job, status: 'completed' }).explainScore('job-1', 'n0', {})).resolves.toBe(answer);
  });
});
