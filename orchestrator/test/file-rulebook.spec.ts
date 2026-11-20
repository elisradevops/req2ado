import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { FileRulebookService, RulebookRejected, fileShaOf } from '../src/modules/pipeline/file-rulebook.service';
import { IngestionHttpError, type PrestudyResult } from '../src/modules/pipeline/ingestion-http.client';
import { JobsController } from '../src/modules/pipeline/jobs.controller';
import { JobResultCache } from '../src/modules/pipeline/result-cache';

const FILE = Buffer.from('a spreadsheet');
const SHA = createHash('sha256').update(FILE).digest('hex');

const learned = (over: Partial<PrestudyResult> = {}): PrestudyResult => ({
  rulebook: { version: 1, hash: 'h1', tables: { t0: { nesting: 'order' } }, document: null },
  hash: 'h1',
  version: 'v1',
  source: 'model',
  rules: ['Sheet: Types are stated in column סוג פריט'],
  warnings: [{ kind: 'prestudy_applied' }],
  ...over,
});

/** The few Prisma calls the service makes, over an array. */
function fakePrisma() {
  const rows: Record<string, any>[] = [];
  const matches = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) => (value && typeof value === 'object' && 'in' in value ? value.in.includes(row[key]) : row[key] === value));
  return {
    rows,
    fileRulebook: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `rb${rows.length + 1}`, createdAt: new Date(rows.length), ...data };
        rows.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => [...rows].reverse().find((r) => matches(r, where)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
    },
  };
}

const TEXT_DOC = { blocks: [{ id: 'b0', kind: 'heading', text: 'Requirements' }], tables: [], figures: [] };
const SHEET_DOC = { blocks: [{ id: 'b0', kind: 'note', text: '[UNSUPPORTED: chart]' }], tables: [{ id: 't0' }], figures: [] };

function setup(over: { prestudy?: jest.Mock; upload?: jest.Mock; poll?: jest.Mock; version?: string | null; doc?: object; attachFileForTables?: boolean; ocrLanguages?: string } = {}) {
  const prisma = fakePrisma();
  const doc = over.doc ?? TEXT_DOC;
  const client = {
    uploadFile: over.upload ?? jest.fn().mockResolvedValue('file-1'),
    pollFileProcessed: over.poll ?? jest.fn().mockResolvedValue(true),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const ingestion = {
    ingest: jest.fn().mockResolvedValue(doc),
    prestudy: over.prestudy ?? jest.fn().mockResolvedValue(learned()),
    prestudyVersion: jest.fn().mockResolvedValue(over.version === undefined ? 'v1' : over.version),
  };
  const clients = { getClientFor: jest.fn().mockResolvedValue(client) };
  const options = { ...(over.attachFileForTables ? { attachFileForTables: true } : {}), ...(over.ocrLanguages !== undefined ? { ocrLanguages: over.ocrLanguages } : {}) };
  const service = new FileRulebookService(prisma as any, ingestion as any, clients as any, Object.keys(options).length ? options : undefined);
  return { service, prisma, ingestion, client, doc };
}

const input = { userId: 'u1', file: FILE, filename: 'sheet.xlsx', model: 'gpt-x' };

describe('FileRulebookService.learn', () => {
  it('parses the file with the OCR languages the job parses with, so the study sees the same document (learn and edit)', async () => {
    const { service, ingestion } = setup({ ocrLanguages: 'heb+eng' });
    await service.learn(input);
    await service.edit({ ...input, rulebook: { tables: {} } });
    expect(ingestion.ingest).toHaveBeenCalledTimes(2);
    for (const call of ingestion.ingest.mock.calls) expect(call[6]).toBe('heb+eng');
  });

  it('sends no OCR languages when none are configured (ingestion keeps its own default)', async () => {
    const { service, ingestion } = setup({ ocrLanguages: '' });
    await service.learn(input);
    expect(ingestion.ingest.mock.calls[0][6]).toBeUndefined();
  });

  it('asks the model with the uploaded file attached, stores the rulebook and deletes the upload', async () => {
    const { service, ingestion, client, prisma } = setup();
    const view = await service.learn(input);
    expect(ingestion.prestudy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'u1', model: 'gpt-x', fileId: 'file-1' }));
    expect(client.deleteFile).toHaveBeenCalledWith('file-1');
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({ userId: 'u1', fileSha256: SHA, source: 'model', hash: 'h1', prestudyVersion: 'v1', model: 'gpt-x' });
    expect(view).toMatchObject({ id: 'rb1', source: 'model', reused: false, hash: 'h1' });
  });

  it('returns the stored rulebook for the same file without asking the model again', async () => {
    const { service, ingestion } = setup();
    await service.learn(input);
    const again = await service.learn(input);
    expect(again).toMatchObject({ id: 'rb1', reused: true });
    expect(ingestion.prestudy).toHaveBeenCalledTimes(1);
  });

  it('asks again on request, and when the study itself has changed', async () => {
    const { service, ingestion } = setup();
    await service.learn(input);
    await service.learn({ ...input, relearn: true });
    expect(ingestion.prestudy).toHaveBeenCalledTimes(2);
    ingestion.prestudyVersion.mockResolvedValue('v2');
    await service.learn(input);
    expect(ingestion.prestudy).toHaveBeenCalledTimes(3);
  });

  it('does not reuse a learned rulebook when the study version cannot be read, but a user\'s edit is always reused', async () => {
    const { service, ingestion } = setup({ version: null });
    await service.learn(input);
    await service.learn(input);
    expect(ingestion.prestudy).toHaveBeenCalledTimes(2);
    ingestion.prestudy.mockResolvedValue(learned({ source: 'user', hash: 'h-user' }));
    await service.edit({ ...input, rulebook: { tables: {} } });
    expect((await service.learn(input)).hash).toBe('h-user');
  });

  it('is scoped to the user: another user\'s rulebook for the same file is not returned', async () => {
    const { service, ingestion } = setup();
    await service.learn(input);
    await service.learn({ ...input, userId: 'u2' });
    expect(ingestion.prestudy).toHaveBeenCalledTimes(2);
  });

  it('stores nothing for a study that learned nothing, and says so', async () => {
    const { service, prisma } = setup({ prestudy: jest.fn().mockResolvedValue(learned({ source: 'none', rules: [], warnings: [{ kind: 'prestudy_rejected' }] })) });
    const view = await service.learn(input);
    expect(view).toMatchObject({ id: null, source: 'none' });
    expect(prisma.rows).toHaveLength(0);
  });

  it('studies from the profile alone when the upload fails, and still stores the answer', async () => {
    const { service, ingestion, client } = setup({ upload: jest.fn().mockRejectedValue(new Error('open webui down')) });
    const view = await service.learn(input);
    expect(ingestion.prestudy.mock.calls[0][1].fileId).toBeUndefined();
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(view.id).toBe('rb1');
  });

  it('drops the upload and studies from the profile alone when Open WebUI does not finish processing it', async () => {
    const { service, ingestion, client } = setup({ poll: jest.fn().mockResolvedValue(false) });
    await service.learn(input);
    expect(client.deleteFile).toHaveBeenCalledWith('file-1');
    expect(ingestion.prestudy.mock.calls[0][1].fileId).toBeUndefined();
  });

  it('does not upload a table study\'s file (its profile covers every row) unless configured to', async () => {
    const sheet = setup({ doc: SHEET_DOC });
    await sheet.service.learn(input);
    expect(sheet.client.uploadFile).not.toHaveBeenCalled();
    expect(sheet.client.deleteFile).not.toHaveBeenCalled();
    expect(sheet.ingestion.prestudy.mock.calls[0][1].fileId).toBeUndefined();
    const attached = setup({ doc: SHEET_DOC, attachFileForTables: true });
    await attached.service.learn(input);
    expect(attached.ingestion.prestudy.mock.calls[0][1].fileId).toBe('file-1');
    expect(attached.client.deleteFile).toHaveBeenCalledWith('file-1');
  });

  it('asks afresh on "Read again", and reuses cached answers otherwise', async () => {
    const { service, ingestion } = setup();
    await service.learn(input);
    await service.learn({ ...input, relearn: true });
    expect(ingestion.prestudy.mock.calls[0][1].fresh).toBeUndefined();
    expect(ingestion.prestudy.mock.calls[1][1].fresh).toBe(true);
  });

  it('deletes the upload even when the study throws', async () => {
    const { service, client } = setup({ prestudy: jest.fn().mockRejectedValue(new Error('ingestion down')) });
    await expect(service.learn(input)).rejects.toThrow('ingestion down');
    expect(client.deleteFile).toHaveBeenCalledWith('file-1');
  });

  // An ingest that honours its signal like fetch does: an aborted caller rejects it at once or as soon as it aborts.
  const abortableIngest = (doc: object) =>
    jest.fn((_file: Buffer, _name: string, ..._rest: unknown[]) => {
      const signal = _rest[8] as AbortSignal | undefined;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason));
        setTimeout(() => resolve(doc), 50);
      });
    });

  it('passes the caller\'s signal to the parse, so giving up during it rejects and stores nothing', async () => {
    const { service, ingestion, prisma } = setup();
    ingestion.ingest = abortableIngest(TEXT_DOC);
    const controller = new AbortController();
    const learning = service.learn({ ...input, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(learning).rejects.toBeDefined();
    expect(ingestion.ingest.mock.calls[0][10]).toBe(controller.signal);
    expect(ingestion.prestudy).not.toHaveBeenCalled();
    expect(prisma.fileRulebook.create).not.toHaveBeenCalled();
  });

  it('asks nothing and stores nothing for a caller that has already gone', async () => {
    const { service, ingestion, prisma } = setup();
    ingestion.ingest = abortableIngest(TEXT_DOC);
    const controller = new AbortController();
    controller.abort();
    await expect(service.learn({ ...input, signal: controller.signal })).rejects.toBeDefined();
    expect(ingestion.prestudy).not.toHaveBeenCalled();
    expect(prisma.fileRulebook.create).not.toHaveBeenCalled();
  });
});

describe('FileRulebookService with no Open WebUI connection, and forJob', () => {
  it('skips the study (no ingest, no model call, nothing stored) and says why, instead of failing', async () => {
    const { service, ingestion, prisma } = setup();
    (service as any).clients.getClientFor = jest.fn().mockRejectedValue(new Error('no connection'));
    const view = await service.learn(input);
    expect(view).toMatchObject({ id: null, source: 'none', skipped: expect.stringMatching(/no model connection/i) });
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(ingestion.prestudy).not.toHaveBeenCalled();
    expect(prisma.rows).toHaveLength(0);
  });

  it('still returns a rulebook stored earlier when the connection is gone', async () => {
    const { service } = setup();
    await service.learn(input);
    (service as any).clients.getClientFor = jest.fn().mockRejectedValue(new Error('no connection'));
    expect(await service.learn(input)).toMatchObject({ id: 'rb1', reused: true, skipped: null });
  });

  it('forJob gives the rulebook and its hash, {} when nothing was learned, and null when the study was skipped', async () => {
    const learnedOne = setup();
    expect(await learnedOne.service.forJob(input)).toEqual({ rulebook: learned().rulebook, hash: 'h1' });
    const nothing = setup({ prestudy: jest.fn().mockResolvedValue(learned({ source: 'none', rules: [] })) });
    expect(await nothing.service.forJob(input)).toEqual({ rulebook: {}, hash: null });
    const skipped = setup();
    (skipped.service as any).clients.getClientFor = jest.fn().mockRejectedValue(new Error('no connection'));
    expect(await skipped.service.forJob(input)).toEqual({ rulebook: null, hash: null });
  });

  it('forJob lets a failed study throw, for the caller to carry on without it', async () => {
    const { service } = setup({ prestudy: jest.fn().mockRejectedValue(new Error('ingestion down')) });
    await expect(service.forJob(input)).rejects.toThrow('ingestion down');
  });
});

describe('FileRulebookService.edit and getFor', () => {
  it('stores a user\'s edit that fits the file as the user\'s, and returns it from learn from then on', async () => {
    const { service, prisma } = setup();
    await service.learn(input);
    const prestudy = jest.fn().mockResolvedValue(learned({ source: 'user', hash: 'h-user' }));
    (service as any).ingestion.prestudy = prestudy;
    const edited = await service.edit({ ...input, rulebook: { tables: { t0: {} } } });
    expect(prestudy).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', rulebook: { tables: { t0: {} } } }); // no model, no file
    expect(edited).toMatchObject({ source: 'user', hash: 'h-user' });
    expect(prisma.rows.map((r) => r.source)).toEqual(['model', 'user']);
    expect(await service.learn(input)).toMatchObject({ source: 'user', reused: true });
  });

  it('turns ingestion\'s refusal into a RulebookRejected carrying the reason', async () => {
    const { service } = setup({ prestudy: jest.fn().mockRejectedValue(new IngestionHttpError(422, 'Ingestion /prestudy request failed: the title is empty on too many rows')) });
    await expect(service.edit({ ...input, rulebook: {} })).rejects.toEqual(new RulebookRejected('the title is empty on too many rows'));
  });

  it('getFor returns a rulebook only to its own user and only for the file it was made for', async () => {
    const { service } = setup();
    await service.learn(input);
    expect((await service.getFor('u1', 'rb1', SHA))?.id).toBe('rb1');
    expect(await service.getFor('u2', 'rb1', SHA)).toBeNull();
    expect(await service.getFor('u1', 'rb1', 'f'.repeat(64))).toBeNull();
    expect(await service.getFor('u1', 'nope', SHA)).toBeNull();
    expect(fileShaOf(FILE)).toBe(SHA);
  });
});

describe('the rulebook in a job', () => {
  const user = { userId: 'u1' } as any;
  const file = { buffer: FILE, originalname: 'sheet.xlsx', size: 4 } as Express.Multer.File;
  const make = (fileRulebooks: any) => {
    const jobsService = { submit: jest.fn().mockResolvedValue({ jobId: 'j1' }) };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024, undefined, undefined, undefined, undefined, undefined, fileRulebooks);
    return { controller, jobsService };
  };

  it('submit passes the stored rulebook and its hash to the job', async () => {
    const getFor = jest.fn().mockResolvedValue({ rulebook: { version: 1 }, hash: 'h1' });
    const { controller, jobsService } = make({ getFor });
    await controller.submit(file, user, 'P\\A', undefined, 'baseline', undefined, undefined, undefined, undefined, undefined, 'rb1');
    expect(getFor).toHaveBeenCalledWith('u1', 'rb1', SHA);
    expect(jobsService.submit).toHaveBeenCalledWith(expect.objectContaining({ fileRulebook: { version: 1 }, fileRulebookHash: 'h1' }));
  });

  it('submit refuses a rulebook id that is not this user\'s or not this file\'s', async () => {
    const { controller, jobsService } = make({ getFor: jest.fn().mockResolvedValue(null) });
    await expect(controller.submit(file, user, 'P\\A', undefined, 'baseline', undefined, undefined, undefined, undefined, undefined, 'rb-other')).rejects.toBeInstanceOf(BadRequestException);
    expect(jobsService.submit).not.toHaveBeenCalled();
  });

  it('submit without a rulebook id gives the job none', async () => {
    const { controller, jobsService } = make({ getFor: jest.fn() });
    await controller.submit(file, user, 'P\\A', undefined, 'baseline', undefined, undefined, undefined, undefined, undefined, undefined);
    expect(jobsService.submit.mock.calls[0][0].fileRulebook).toBeUndefined();
  });

  it('editRules answers 400 with the reason when the edit does not fit the file, and refuses a body that is not a JSON object', async () => {
    const { controller } = make({ edit: jest.fn().mockRejectedValue(new RulebookRejected('the title is empty on too many rows')) });
    await expect(controller.editRules(file, user, undefined, '{"tables":{}}')).rejects.toThrow('the title is empty on too many rows');
    await expect(controller.editRules(file, user, undefined, 'not json')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.editRules(file, user, undefined, '[1]')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the result-cache key changes with the rulebook, and an unchanged job keeps its old key', () => {
    const cache = new JobResultCache({} as any, 'code-1');
    const parts = { fileHash: SHA, userId: 'u1', model: 'm', mode: 'survey', kbVersion: 'k', ingestionVersion: 'i', profileVersion: null };
    const plain = cache.keyFor(parts);
    expect(cache.keyFor({ ...parts, rulebookHash: null })).toBe(plain);
    expect(cache.keyFor({ ...parts, rulebookHash: 'h1' })).not.toBe(plain);
    expect(cache.keyFor({ ...parts, rulebookHash: 'h1' })).not.toBe(cache.keyFor({ ...parts, rulebookHash: 'h2' }));
    const legacy = createHash('sha256').update(JSON.stringify(['code-1', SHA, 'u1', 'm', 'survey', 'k', 'i', null])).digest('hex');
    expect(plain).toBe(`job-result:${legacy}`);
  });
});

describe('what the rules make of the file (the wizard\'s breakdown)', () => {
  const details = { approximate: false, tables: [{ name: 'Sheet', totalRows: 346, typeCounts: { Epic: 4, Feature: 39, Requirement: 235 } }], document: null };

  it('stores the breakdown with the rulebook and returns it, from the study and on reuse', async () => {
    const { service, prisma, ingestion } = setup({ prestudy: jest.fn().mockResolvedValue(learned({ details })) });
    expect((await service.learn(input)).details).toEqual(details);
    expect(prisma.rows[0].details).toEqual(details);
    expect((await service.learn(input)).details).toEqual(details);
    expect(ingestion.prestudy).toHaveBeenCalledTimes(1);
  });

  it('returns null for a rulebook stored before the breakdown was kept, without asking the model again', async () => {
    const { service, prisma, ingestion } = setup();
    prisma.rows.push({ id: 'old', userId: 'u1', fileSha256: SHA, prestudyVersion: 'v1', source: 'model', model: '', rulebook: {}, hash: 'h0', rules: [], warnings: [], createdAt: new Date(0) });
    const view = await service.learn(input);
    expect(view).toMatchObject({ id: 'old', reused: true, details: null });
    expect(ingestion.prestudy).not.toHaveBeenCalled();
  });

  it('stores the breakdown an edit gives', async () => {
    const edited = { ...details, tables: [{ ...details.tables[0], typeCounts: { Epic: 4, Feature: 39, Requirement: 303 } }] };
    const { service, prisma } = setup({ prestudy: jest.fn().mockResolvedValue(learned({ source: 'user', details: edited })) });
    expect((await service.edit({ ...input, rulebook: { tables: {} } })).details).toEqual(edited);
    expect(prisma.rows[0]).toMatchObject({ source: 'user', details: edited });
  });

  it('has no breakdown for a study that learned nothing, or one that was skipped', async () => {
    const none = setup({ prestudy: jest.fn().mockResolvedValue(learned({ source: 'none', details })) });
    expect((await none.service.learn(input)).details).toBeNull();
    const skipped = setup();
    (skipped.service as any).clients.getClientFor = jest.fn().mockRejectedValue(new Error('no connection'));
    expect((await skipped.service.learn(input)).details).toBeNull();
  });
});

describe('the FileRulebook details migration', () => {
  it('adds a nullable column and nothing else', () => {
    const sql = readFileSync(join(__dirname, '../prisma/migrations/20261121090000_add_file_rulebook_details/migration.sql'), 'utf8');
    expect(sql.split('\n').filter((l) => l.trim() && !l.startsWith('--'))).toEqual(['ALTER TABLE "FileRulebook" ADD COLUMN "details" JSONB;']);
  });
});
