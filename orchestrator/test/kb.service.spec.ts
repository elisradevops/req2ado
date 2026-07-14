import { KbService } from '../src/modules/kb/kb.service';

describe('KbService', () => {
  it('ingestUrl() calls the ingestion client and upserts an IngestedDocument, returning the ingest result', async () => {
    const ingestResult = {
      documentName: 'doc.pdf',
      driveitemId: 'drive-1',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      chunksStored: 3,
      skippedUnchanged: false,
    };
    const ingestionClient = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any);

    const result = await service.ingestUrl('https://contoso.sharepoint.com/x', 'Project\\Area1', 'SRD');

    expect(ingestionClient.ingestUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/x', 'Project\\Area1', 'SRD');
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith({
      where: { areaPath_driveItemId: { areaPath: 'Project\\Area1', driveItemId: 'drive-1' } },
      create: { areaPath: 'Project\\Area1', driveItemId: 'drive-1', name: 'doc.pdf', sizeBytes: 1024, mimeType: 'application/pdf', docType: 'SRD' },
      update: { name: 'doc.pdf', sizeBytes: 1024, mimeType: 'application/pdf', docType: 'SRD', ingestedAt: expect.any(Date) },
    });
    expect(result).toEqual(ingestResult);
  });

  it('listDocuments() filters by areaPath when provided', async () => {
    const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new KbService(prisma as any, {} as any);

    await service.listDocuments('Project\\Area1');

    expect(prisma.ingestedDocument.findMany).toHaveBeenCalledWith({ where: { areaPath: 'Project\\Area1' }, orderBy: { ingestedAt: 'desc' } });
  });

  it('listDocuments() returns all documents ordered newest-first when areaPath is omitted', async () => {
    const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new KbService(prisma as any, {} as any);

    await service.listDocuments();

    expect(prisma.ingestedDocument.findMany).toHaveBeenCalledWith({ where: {}, orderBy: { ingestedAt: 'desc' } });
  });

  it('ingestFolderUrl() persists a row per ingested/skipped file and skips failed ones', async () => {
    const folderResult = {
      files: [
        { file: 'a.docx', status: 'ingested', chunksStored: 2, driveitemId: 'drive-a', mimeType: 'application/a', sizeBytes: 100, reason: null },
        { file: 'b.docx', status: 'skipped_unchanged', chunksStored: 0, driveitemId: 'drive-b', mimeType: 'application/b', sizeBytes: 200, reason: null },
        { file: 'bad.docx', status: 'failed', chunksStored: 0, driveitemId: null, mimeType: null, sizeBytes: null, reason: 'corrupt' },
      ],
    };
    const ingestionClient = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any);

    const result = await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD');

    expect(ingestionClient.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD');
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { areaPath_driveItemId: { areaPath: 'Project\\Area1', driveItemId: 'drive-a' } } }),
    );
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { areaPath_driveItemId: { areaPath: 'Project\\Area1', driveItemId: 'drive-b' } } }),
    );
    expect(result).toEqual(folderResult);
  });
});
