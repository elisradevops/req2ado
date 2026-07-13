import { KbService } from '../src/modules/kb/kb.service';

describe('KbService', () => {
  it('create() persists a KbSource via prisma and returns it', async () => {
    const created = { id: 'kb-1', areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs', lastSyncedAt: null, createdAt: new Date() };
    const prisma = { kbSource: { create: jest.fn().mockResolvedValue(created) } };
    const service = new KbService(prisma as any, {} as any);

    const result = await service.create({ areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs' });

    expect(prisma.kbSource.create).toHaveBeenCalledWith({
      data: { areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs' },
    });
    expect(result).toEqual(created);
  });

  it('list() returns all sources ordered newest-first', async () => {
    const prisma = { kbSource: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new KbService(prisma as any, {} as any);

    await service.list();

    expect(prisma.kbSource.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
  });

  it('sync() returns null when the KbSource does not exist', async () => {
    const prisma = { kbSource: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new KbService(prisma as any, {} as any);

    const result = await service.sync('missing-id', 'tok-1');

    expect(result).toBeNull();
  });

  it('sync() forwards the source config + bearer token to ingestion, updates lastSyncedAt, and returns the result', async () => {
    const source = { id: 'kb-1', areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder' };
    const syncResult = { filesProcessed: 1, filesSkipped: 0, filesFailed: [], chunksStored: 3 };
    const prisma = {
      kbSource: {
        findUnique: jest.fn().mockResolvedValue(source),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ingestionClient = { syncKb: jest.fn().mockResolvedValue(syncResult) };
    const service = new KbService(prisma as any, ingestionClient as any);

    const result = await service.sync('kb-1', 'tok-1');

    expect(ingestionClient.syncKb).toHaveBeenCalledWith('https://s', 'Lib', 'Folder', 'Project\\Area1', 'kb-1', 'tok-1');
    expect(prisma.kbSource.update).toHaveBeenCalledWith({ where: { id: 'kb-1' }, data: { lastSyncedAt: expect.any(Date) } });
    expect(result).toEqual(syncResult);
  });
});
