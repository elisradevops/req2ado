import { KbService } from '../src/modules/kb/kb.service';

// Every user in these tests has connected SharePoint with their own token (the per-user rule is tested in kb-sharepoint-per-user.spec.ts).
const USER_TOKEN = JSON.stringify({ token: 'user-tok', rotatedByUserId: 'u', rotatedAt: '2026-01-01T00:00:00.000Z' });
const fakeCredentialVault = { get: jest.fn().mockResolvedValue(USER_TOKEN), set: jest.fn(), delete: jest.fn(), has: jest.fn() };

describe('KbService', () => {
  it('ingestUrl() calls the ingestion client and upserts an IngestedDocument, returning the ingest result', async () => {
    const ingestResult = {
      documentName: 'doc.pdf',
      driveitemId: 'drive-1',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      chunksStored: 3,
      chunksInStore: 3,
      skippedUnchanged: false,
    };
    const ingestionClient = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    const result = await service.ingestUrl('https://contoso.sharepoint.com/x', 'Project\\Area1', 'SRD');

    expect(ingestionClient.ingestUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/x', 'Project\\Area1', 'SRD', 'user-tok', null);
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith({
      where: { userId_driveItemId: { userId: 'Project\\Area1', driveItemId: 'drive-1' } },
      create: { userId: 'Project\\Area1', driveItemId: 'drive-1', name: 'doc.pdf', sizeBytes: 1024, mimeType: 'application/pdf', docType: 'SRD', retrievalMode: null, chunkCount: 3 },
      update: { name: 'doc.pdf', sizeBytes: 1024, mimeType: 'application/pdf', docType: 'SRD', retrievalMode: null, chunkCount: 3, ingestedAt: expect.any(Date) },
    });
    expect(result).toEqual(ingestResult);
  });

  it('ingestUrl() records the library the file is in when ingestion reports it', async () => {
    const ingestResult = { documentName: 'doc.pdf', driveitemId: 'item-1', mimeType: null, sizeBytes: 1, chunksStored: 1, chunksInStore: 1, skippedUnchanged: false, driveId: 'drive-9' };
    const ingestionClient = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestUrl('https://contoso.sharepoint.com/x', 'u', null);

    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ driveId: 'drive-9' }), update: expect.objectContaining({ driveId: 'drive-9' }) }),
    );
  });

  it('ingestFolderUrl() records the library of each file', async () => {
    const files = [{ file: 'a.docx', status: 'ingested', chunksStored: 1, chunksInStore: 1, driveitemId: 'item-a', mimeType: null, sizeBytes: 1, reason: null, relativePath: 'a.docx', driveId: 'drive-9' }];
    const ingestionClient = { ingestFolderUrl: jest.fn().mockResolvedValue({ files }) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'u', null);

    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ driveId: 'drive-9' }) }));
  });

  it('ingestUrl() forwards retrievalMode to the ingestion client and persists it', async () => {
    const ingestResult = {
      documentName: 'standards.docx',
      driveitemId: 'drive-2',
      mimeType: 'application/pdf',
      sizeBytes: 512,
      chunksStored: 1,
      skippedUnchanged: false,
    };
    const ingestionClient = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestUrl('https://contoso.sharepoint.com/x', 'Project\\Area1', null, 'always_include');

    expect(ingestionClient.ingestUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/x', 'Project\\Area1', null, 'user-tok', 'always_include');
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ retrievalMode: 'always_include' }),
        update: expect.objectContaining({ retrievalMode: 'always_include' }),
      }),
    );
  });

  it('ingestUrl() records the real stored chunk count on a skip-unchanged re-ingest (not the 0 newly stored)', async () => {
    const ingestResult = { documentName: 'doc.pdf', driveitemId: 'drive-1', mimeType: null, sizeBytes: 10, chunksStored: 0, chunksInStore: 32, skippedUnchanged: true };
    const ingestionClient = { ingestUrl: jest.fn().mockResolvedValue(ingestResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestUrl('https://contoso.sharepoint.com/x', 'u', null);

    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ chunkCount: 32 }),
        update: expect.objectContaining({ chunkCount: 32 }),
      }),
    );
  });

  it('ingestItem() persists chunkCount from the ingestion result', async () => {
    const ingestResult = { documentName: 'a.pdf', driveitemId: 'drive-9', mimeType: 'application/pdf', sizeBytes: 5, chunksStored: 0, chunksInStore: 0, skippedUnchanged: true };
    const ingestionClient = { ingestItem: jest.fn().mockResolvedValue(ingestResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue({ id: 'row-1' }) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    const result = await service.ingestItem('a.pdf', 'drive-9', 'https://dl', 'Sub/a.pdf', 'u', null);

    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ chunkCount: 0 }),
        update: expect.objectContaining({ chunkCount: 0 }),
      }),
    );
    expect(result.ingestedDocumentId).toBe('row-1');
  });

  it('ingestFolderUrl() persists each file\'s chunkCount', async () => {
    const folderResult = {
      files: [
        { file: 'a.docx', status: 'ingested', chunksStored: 2, chunksInStore: 2, driveitemId: 'drive-a', mimeType: null, sizeBytes: 1, reason: null },
        { file: 'b.docx', status: 'skipped_unchanged', chunksStored: 0, chunksInStore: 7, driveitemId: 'drive-b', mimeType: null, sizeBytes: 1, reason: null },
      ],
    };
    const ingestionClient = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'u', null);

    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_driveItemId: { userId: 'u', driveItemId: 'drive-b' } }, update: expect.objectContaining({ chunkCount: 7 }) }),
    );
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_driveItemId: { userId: 'u', driveItemId: 'drive-a' } }, create: expect.objectContaining({ chunkCount: 2 }) }),
    );
  });

  it('an unknown count (older ingestion) is stored as null on create and overwrites a possibly stale count on update', async () => {
    const unknown = { documentName: 'd.pdf', driveitemId: 'drive-1', mimeType: null, sizeBytes: 1, chunksStored: 0, chunksInStore: null, skippedUnchanged: true };
    const ingestionClient = {
      ingestUrl: jest.fn().mockResolvedValue(unknown),
      ingestItem: jest.fn().mockResolvedValue(unknown),
      ingestFolderUrl: jest.fn().mockResolvedValue({ files: [{ file: 'd.pdf', status: 'skipped_unchanged', chunksStored: 0, chunksInStore: null, driveitemId: 'drive-1', mimeType: null, sizeBytes: 1, reason: null }] }),
    };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue({ id: 'row' }) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestUrl('https://x/d.pdf', 'u', null);
    await service.ingestItem('d.pdf', 'drive-1', 'https://dl', 'd.pdf', 'u', null);
    await service.ingestFolderUrl('https://x/folder', 'u', null);

    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledTimes(3);
    for (const [args] of prisma.ingestedDocument.upsert.mock.calls) {
      expect(args.create.chunkCount).toBeNull();
      expect(args.update.chunkCount).toBeNull();
    }
  });

  it('listDocuments() filters by userId when provided', async () => {
    const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new KbService(prisma as any, {} as any, fakeCredentialVault as any);

    await service.listDocuments('Project\\Area1');

    expect(prisma.ingestedDocument.findMany).toHaveBeenCalledWith({ where: { userId: 'Project\\Area1' }, orderBy: { ingestedAt: 'desc' } });
  });

  it('listDocuments() returns all documents ordered newest-first when userId is omitted', async () => {
    const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new KbService(prisma as any, {} as any, fakeCredentialVault as any);

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
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    const result = await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD');

    expect(ingestionClient.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD', false, 'user-tok');
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_driveItemId: { userId: 'Project\\Area1', driveItemId: 'drive-a' } } }),
    );
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_driveItemId: { userId: 'Project\\Area1', driveItemId: 'drive-b' } } }),
    );
    expect(result).toEqual(folderResult);
  });

  it('ingestFolderUrl() forwards recursive to the ingestion client and persists relativePath as the document name', async () => {
    const folderResult = {
      files: [
        { file: 'nested.docx', status: 'ingested', chunksStored: 1, driveitemId: 'drive-n', mimeType: 'application/n', sizeBytes: 50, reason: null, relativePath: 'Sub/nested.docx' },
      ],
    };
    const ingestionClient = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD', true);

    expect(ingestionClient.ingestFolderUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD', true, 'user-tok');
    expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ name: 'Sub/nested.docx' }) }),
    );
  });

  it("ingestFolderUrl() does not let one file's DB-persist rejection fail the whole batch", async () => {
    const folderResult = {
      files: [
        { file: 'a.docx', status: 'ingested', chunksStored: 2, driveitemId: 'drive-a', mimeType: 'application/a', sizeBytes: 100, reason: null },
        { file: 'b.docx', status: 'ingested', chunksStored: 1, driveitemId: 'drive-b', mimeType: 'application/b', sizeBytes: 200, reason: null },
      ],
    };
    const ingestionClient = { ingestFolderUrl: jest.fn().mockResolvedValue(folderResult) };
    const prisma = {
      ingestedDocument: {
        upsert: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('db unavailable')),
      },
    };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

    const result = await service.ingestFolderUrl('https://contoso.sharepoint.com/folder', 'Project\\Area1', 'SRD');

    expect(result.files.find((f) => f.file === 'a.docx')).toEqual(
      expect.objectContaining({ status: 'ingested' }),
    );
    expect(result.files.find((f) => f.file === 'b.docx')).toEqual(
      expect.objectContaining({ status: 'failed', reason: expect.stringContaining('db unavailable') }),
    );
  });

  it('getSharePointStatus() checks the user own vaulted token', async () => {
    const vaulted = JSON.stringify({ token: 'vaulted-tok', rotatedByUserId: 'user-1', rotatedAt: '2026-01-01T00:00:00.000Z' });
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 }) };
    const credentialVault = { get: jest.fn().mockResolvedValue(vaulted) };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    const result = await service.getSharePointStatus('user-1');

    expect(credentialVault.get).toHaveBeenCalledWith('user:user-1', 'sharepoint_token');
    expect(ingestionClient.getSharePointStatus).toHaveBeenCalledWith('vaulted-tok');
    expect(result).toEqual({ status: 'valid', expiresInSeconds: 3600 });
  });

  it('getSharePointStatus() says not connected for a user with no token of their own, without asking ingestion', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn() };
    const credentialVault = { get: jest.fn().mockResolvedValue(null) };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    expect(await service.getSharePointStatus('user-1')).toEqual({ status: 'not_configured', expiresInSeconds: null });

    expect(ingestionClient.getSharePointStatus).not.toHaveBeenCalled();
  });

  it('reconnectSharePointToken() validates before vaulting -- an invalid token is never stored', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'invalid', expiresInSeconds: null }) };
    const credentialVault = { get: jest.fn(), set: jest.fn() };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    const result = await service.reconnectSharePointToken('bad-token', 'user-1');

    expect(ingestionClient.getSharePointStatus).toHaveBeenCalledWith('bad-token');
    expect(credentialVault.set).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'invalid', expiresInSeconds: null });
  });

  it.each([
    ['a "Bearer " prefix, as copied from an Authorization header', 'Bearer eyJ0.abc.def', 'eyJ0.abc.def'],
    ['the whole Authorization header', 'Authorization: Bearer eyJ0.abc.def', 'eyJ0.abc.def'],
    ['surrounding quotes', '"eyJ0.abc.def"', 'eyJ0.abc.def'],
    ['line breaks and spaces from a wrapped copy', '  eyJ0.abc\n.def \r\n', 'eyJ0.abc.def'],
  ])('reconnectSharePointToken() cleans a token pasted with %s before checking and storing it', async (_label, pasted, expected) => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 }) };
    const credentialVault = { get: jest.fn(), set: jest.fn() };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    await service.reconnectSharePointToken(pasted, 'user-1');

    expect(ingestionClient.getSharePointStatus).toHaveBeenCalledWith(expected);
    expect(JSON.parse(credentialVault.set.mock.calls[0][2]).token).toBe(expected);
  });

  it('reconnectSharePointToken() resumes the batches that were waiting for a fresh token, once the token is stored', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 }) };
    const order: string[] = [];
    const credentialVault = { get: jest.fn(), set: jest.fn().mockImplementation(async () => order.push('stored')) };
    const batches = { resumePausedBy: jest.fn().mockImplementation(async () => order.push('resumed')) };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any, undefined, batches as any);

    await service.reconnectSharePointToken('good-token', 'user-1');

    expect(batches.resumePausedBy).toHaveBeenCalledWith('sharepoint_token', 'user-1');
    expect(order).toEqual(['stored', 'resumed']);
  });

  it('reconnectSharePointToken() does not resume anything for a token that is not valid', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'invalid', expiresInSeconds: null }) };
    const batches = { resumePausedBy: jest.fn() };
    const service = new KbService({} as any, ingestionClient as any, { get: jest.fn(), set: jest.fn() } as any, undefined, batches as any);

    await service.reconnectSharePointToken('bad-token', 'user-1');

    expect(batches.resumePausedBy).not.toHaveBeenCalled();
  });

  it('reconnectSharePointToken() still succeeds when resuming the batches fails', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 }) };
    const batches = { resumePausedBy: jest.fn().mockRejectedValue(new Error('db down')) };
    const service = new KbService({} as any, ingestionClient as any, { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) } as any, undefined, batches as any);

    await expect(service.reconnectSharePointToken('good-token', 'user-1')).resolves.toEqual({ status: 'valid', expiresInSeconds: 3600 });
  });

  it('reconnectSharePointToken() vaults the token with rotation attribution when valid', async () => {
    const ingestionClient = { getSharePointStatus: jest.fn().mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 }) };
    const credentialVault = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) };
    const service = new KbService({} as any, ingestionClient as any, credentialVault as any);

    await service.reconnectSharePointToken('good-token', 'user-1');

    expect(credentialVault.set).toHaveBeenCalledWith(
      'user:user-1',
      'sharepoint_token',
      expect.stringContaining('"token":"good-token"'),
    );
    expect(credentialVault.set).toHaveBeenCalledWith('user:user-1', 'sharepoint_token', expect.stringContaining('"rotatedByUserId":"user-1"'));
  });

  describe('browseFolder() / withIngestedFlag()', () => {
    const child = (overrides: Partial<{ id: string; name: string; isFolder: boolean }> = {}) => ({
      id: 'drive-1',
      name: 'doc.docx',
      mimeType: null,
      sizeBytes: 100,
      isFolder: false,
      driveId: null,
      downloadUrl: null,
      ...overrides,
    });

    it('matches an already-ingested file by driveItemId even when the filename has changed (rename/move)', async () => {
      // Regression for the confirmed SharePoint rename bug: the file was
      // ingested as "old.docx" but Graph now reports it renamed to
      // "new.docx" under the SAME drive-item id -- must still match.
      const prisma = {
        ingestedDocument: { findMany: jest.fn().mockResolvedValue([{ id: 'doc-1', driveItemId: 'drive-1' }]) },
      };
      const ingestionClient = { browseFolder: jest.fn().mockResolvedValue([child({ id: 'drive-1', name: 'new.docx' })]) };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

      const result = await service.browseFolder('https://contoso.sharepoint.com/x', 'Project\\Area1', '');

      expect(result).toEqual([
        expect.objectContaining({ id: 'drive-1', name: 'new.docx', alreadyIngested: true, ingestedDocumentId: 'doc-1' }),
      ]);
    });

    it('returns the matched row\'s chunkCount (null when unknown or not ingested)', async () => {
      const prisma = {
        ingestedDocument: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'doc-1', driveItemId: 'drive-1', chunkCount: 0, retrievalMode: 'always_include' },
            { id: 'doc-2', driveItemId: 'drive-2', chunkCount: 32, retrievalMode: null },
            { id: 'doc-3', driveItemId: 'drive-3', chunkCount: null },
          ]),
        },
      };
      const ingestionClient = {
        browseFolder: jest.fn().mockResolvedValue([
          child({ id: 'drive-1' }), child({ id: 'drive-2' }), child({ id: 'drive-3' }), child({ id: 'drive-4' }),
        ]),
      };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

      const result = await service.browseFolder('https://contoso.sharepoint.com/x', 'Project\\Area1', '');

      expect(result.map((r) => r.chunkCount)).toEqual([0, 32, null, null]);
      expect(result.map((r) => r.retrievalMode)).toEqual(['always_include', null, null, null]);
    });

    it('does not match a file whose driveItemId is not in this user\'s KB', async () => {
      const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue([{ id: 'doc-1', driveItemId: 'drive-1' }]) } };
      const ingestionClient = { browseFolder: jest.fn().mockResolvedValue([child({ id: 'drive-2', name: 'other.docx' })]) };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

      const result = await service.browseFolder('https://contoso.sharepoint.com/x', 'Project\\Area1', '');

      expect(result).toEqual([expect.objectContaining({ alreadyIngested: false, ingestedDocumentId: null })]);
    });

    it('folders are never marked alreadyIngested regardless of a matching driveItemId', async () => {
      const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue([{ id: 'doc-1', driveItemId: 'drive-1' }]) } };
      const ingestionClient = {
        browseFolder: jest.fn().mockResolvedValue([child({ id: 'drive-1', name: 'SomeFolder', isFolder: true })]),
      };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

      const result = await service.browseFolder('https://contoso.sharepoint.com/x', 'Project\\Area1', '');

      expect(result).toEqual([expect.objectContaining({ alreadyIngested: false, ingestedDocumentId: null })]);
    });
  });
  describe('setRetrievalMode()', () => {
    const document = { id: 'doc-1', userId: 'Project\\Area1', driveItemId: 'drive-1', name: 'guide.pptx', retrievalMode: null };

    it('retags the stored chunks and records the mode on the row', async () => {
      const ingestionClient = { setRetrievalMode: jest.fn().mockResolvedValue(undefined) };
      const prisma = {
        ingestedDocument: {
          findUnique: jest.fn().mockResolvedValue(document),
          update: jest.fn().mockResolvedValue({ ...document, retrievalMode: 'always_include' }),
        },
      };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

      const result = await service.setRetrievalMode('doc-1', 'Project\\Area1', 'always_include');

      expect(ingestionClient.setRetrievalMode).toHaveBeenCalledWith('Project\\Area1', 'drive-1', 'always_include');
      expect(prisma.ingestedDocument.update).toHaveBeenCalledWith({ where: { id: 'doc-1' }, data: { retrievalMode: 'always_include' } });
      expect(result).toEqual(expect.objectContaining({ retrievalMode: 'always_include' }));
    });

    it('returns null without touching the index when the row belongs to another user', async () => {
      const ingestionClient = { setRetrievalMode: jest.fn() };
      const prisma = { ingestedDocument: { findUnique: jest.fn().mockResolvedValue(document), update: jest.fn() } };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

      expect(await service.setRetrievalMode('doc-1', 'Someone\\Else', 'always_include')).toBeNull();
      expect(ingestionClient.setRetrievalMode).not.toHaveBeenCalled();
      expect(prisma.ingestedDocument.update).not.toHaveBeenCalled();
    });

    it('does not record the mode when the index update fails', async () => {
      const ingestionClient = { setRetrievalMode: jest.fn().mockRejectedValue(new Error('boom')) };
      const prisma = { ingestedDocument: { findUnique: jest.fn().mockResolvedValue(document), update: jest.fn() } };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);

      await expect(service.setRetrievalMode('doc-1', 'Project\\Area1', 'always_include')).rejects.toThrow('boom');
      expect(prisma.ingestedDocument.update).not.toHaveBeenCalled();
    });
  });

  describe('recordIngestedDocument() and ingestDriveItem()', () => {
    const ingestResult = { documentName: 'guide.pptx', driveitemId: 'item-1', mimeType: 'application/pdf', sizeBytes: 5, chunksStored: 3, chunksInStore: 3, skippedUnchanged: false };

    function build(overrides: { vaultToken?: unknown } = {}) {
      const ingestionClient = { ingestDriveItem: jest.fn().mockResolvedValue(ingestResult) };
      const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue({ id: 'row-1' }), findMany: jest.fn().mockResolvedValue([]) } };
      const profileScheduler = { schedule: jest.fn().mockResolvedValue(undefined) };
      const vault = { ...fakeCredentialVault, get: jest.fn().mockResolvedValue(overrides.vaultToken ?? USER_TOKEN) };
      const service = new KbService(prisma as any, ingestionClient as any, vault as any, profileScheduler as any);
      return { service, ingestionClient, prisma, profileScheduler };
    }

    it('recordIngestedDocument() upserts the row under the relative path and returns its id', async () => {
      const { service, prisma } = build();

      const id = await service.recordIngestedDocument('u', ingestResult, { relativePath: 'Sub/guide.pptx', docType: 'SRD', retrievalMode: 'always_include' });

      expect(id).toBe('row-1');
      expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith({
        where: { userId_driveItemId: { userId: 'u', driveItemId: 'item-1' } },
        create: { userId: 'u', driveItemId: 'item-1', name: 'Sub/guide.pptx', sizeBytes: 5, mimeType: 'application/pdf', docType: 'SRD', retrievalMode: 'always_include', chunkCount: 3 },
        update: { name: 'Sub/guide.pptx', sizeBytes: 5, mimeType: 'application/pdf', docType: 'SRD', retrievalMode: 'always_include', chunkCount: 3, ingestedAt: expect.any(Date) },
      });
    });

    it('ingestDriveItem() ingests by ids with the freshly read token, records the document and schedules the profile', async () => {
      const { service, ingestionClient, prisma, profileScheduler } = build({ vaultToken: JSON.stringify({ token: 'rotated', rotatedByUserId: 'x', rotatedAt: 'now' }) });

      const result = await service.ingestDriveItem({ userId: 'u', driveId: 'drive-1', itemId: 'item-1', relativePath: 'Sub/guide.pptx', docType: null, retrievalMode: 'retrieve' });

      expect(ingestionClient.ingestDriveItem).toHaveBeenCalledWith('drive-1', 'item-1', 'u', null, 'rotated', 'retrieve', undefined);
      expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ name: 'Sub/guide.pptx', retrievalMode: 'retrieve' }) }));
      expect(profileScheduler.schedule).toHaveBeenCalledWith('u');
      expect(result).toEqual({ ...ingestResult, ingestedDocumentId: 'row-1' });
    });

    it('ingestDriveItem() with scheduleProfile:false leaves the profile build to the caller', async () => {
      const { service, profileScheduler } = build();

      await service.ingestDriveItem({ userId: 'u', driveId: 'd', itemId: 'i', relativePath: 'g.pptx', docType: null, retrievalMode: null, scheduleProfile: false });

      expect(profileScheduler.schedule).not.toHaveBeenCalled();
    });

    it('ingestDriveItem() forwards the abort signal', async () => {
      const { service, ingestionClient } = build();
      const controller = new AbortController();

      await service.ingestDriveItem({ userId: 'u', driveId: 'd', itemId: 'i', relativePath: 'g.pptx', docType: null, retrievalMode: null, signal: controller.signal });

      expect(ingestionClient.ingestDriveItem.mock.calls[0][6]).toBe(controller.signal);
    });

    it('ingestDriveItem() records nothing when the ingestion fails', async () => {
      const { service, ingestionClient, prisma, profileScheduler } = build();
      ingestionClient.ingestDriveItem.mockRejectedValue(new Error('boom'));

      await expect(service.ingestDriveItem({ userId: 'u', driveId: 'd', itemId: 'i', relativePath: 'g.pptx', docType: null, retrievalMode: null })).rejects.toThrow('boom');

      expect(prisma.ingestedDocument.upsert).not.toHaveBeenCalled();
      expect(profileScheduler.schedule).not.toHaveBeenCalled();
    });

    it('ingestItem() still records through the same path', async () => {
      const ingestionClient = { ingestItem: jest.fn().mockResolvedValue(ingestResult) };
      const prisma = { ingestedDocument: { upsert: jest.fn().mockResolvedValue({ id: 'row-1' }) } };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any);
      const spy = jest.spyOn(service, 'recordIngestedDocument');

      await service.ingestItem('guide.pptx', 'item-1', 'https://dl', 'Sub/guide.pptx', 'u', null, 'always_include');

      expect(spy).toHaveBeenCalledWith('u', ingestResult, { relativePath: 'Sub/guide.pptx', docType: null, retrievalMode: 'always_include' });
    });
  });

  describe('getProfile()', () => {
    const stored = {
      version: 'v1', builtWith: 'model-1', docsInKb: 3, docsContributing: 2,
      profile: {
        built_at: '2026-11-11T10:00:00Z', truncated: true,
        docs: [
          { file: 'a.pptx', status: 'contributed', reason: null, categories: 10, rules: 32, type_definitions: 0, glossary: 7 },
          { file: 'b.pptx', status: 'not_relevant', reason: 'about recipes', categories: 0, rules: 0, type_definitions: 0, glossary: 0 },
        ],
        conflicts: [{ kind: 'type_definition', key: 'requirement', variants: [{ text: 'x', sources: ['a'] }, { text: 'y', sources: ['b'] }] }],
      },
    };

    function build(options: { stored?: unknown; activity?: 'idle' | 'queued' | 'building'; hasModel?: boolean } = {}) {
      const ingestionClient = { getKbProfile: jest.fn().mockResolvedValue(options.stored === undefined ? stored : options.stored) };
      const scheduler = { schedule: jest.fn(), activity: jest.fn().mockResolvedValue(options.activity ?? 'idle'), hasModel: jest.fn().mockResolvedValue(options.hasModel ?? true) };
      return { service: new KbService({} as any, ingestionClient as any, fakeCredentialVault as any, scheduler as any), ingestionClient, scheduler };
    }

    it('reports a stored profile as ready, with what each document contributed and the conflicts', async () => {
      const { service } = build();

      expect(await service.getProfile('u')).toEqual({
        state: 'ready',
        builtAt: '2026-11-11T10:00:00Z',
        version: 'v1',
        builtWith: 'model-1',
        docsInKb: 3,
        docsContributing: 2,
        truncated: true,
        docs: [
          { file: 'a.pptx', status: 'contributed', reason: null, categories: 10, rules: 32, typeDefinitions: 0, glossary: 7 },
          { file: 'b.pptx', status: 'not_relevant', reason: 'about recipes', categories: 0, rules: 0, typeDefinitions: 0, glossary: 0 },
        ],
        conflicts: [{ kind: 'type_definition', key: 'requirement', variantCount: 2 }],
      });
    });

    it.each(['queued', 'building'] as const)('says %s while a build is pending or running, and still shows the previous profile', async (activity) => {
      const { service } = build({ activity });

      const view = await service.getProfile('u');

      expect(view.state).toBe(activity);
      expect(view.docs).toHaveLength(2);
    });

    it('with nothing stored: none when a build could start, no_model when no model connection exists', async () => {
      expect((await build({ stored: null }).service.getProfile('u')).state).toBe('none');
      expect((await build({ stored: null, hasModel: false }).service.getProfile('u')).state).toBe('no_model');
    });

    it('with nothing stored but a build under way, says so', async () => {
      const view = await build({ stored: null, activity: 'building' }).service.getProfile('u');

      expect(view).toMatchObject({ state: 'building', docs: [], conflicts: [], builtAt: null, version: null });
    });

    it('tolerates a stored profile without optional parts', async () => {
      const { service } = build({ stored: { version: 'v1', builtWith: 'm', docsInKb: 0, docsContributing: 0, profile: {} } });

      expect(await service.getProfile('u')).toMatchObject({ state: 'ready', docs: [], conflicts: [], builtAt: null, truncated: false });
    });

    it('works without a scheduler (no queue configured): ready if stored, none otherwise', async () => {
      const ingestionClient = { getKbProfile: jest.fn().mockResolvedValue(stored) };
      const service = new KbService({} as any, ingestionClient as any, fakeCredentialVault as any);

      expect((await service.getProfile('u')).state).toBe('ready');
      ingestionClient.getKbProfile.mockResolvedValue(null);
      expect((await service.getProfile('u')).state).toBe('none');
    });
  });
  describe('the one-library rule', () => {
    const ingestResult = { documentName: 'a.pdf', driveitemId: 'item-1', mimeType: 'application/pdf', sizeBytes: 5, chunksStored: 1, chunksInStore: 1, skippedUnchanged: false };

    function build(docs: Record<string, unknown>[] = [], options: { activeBatches?: number; failDelete?: string } = {}) {
      const ingestionClient = {
        ingestItem: jest.fn().mockResolvedValue(ingestResult),
        deleteDocument: jest.fn().mockImplementation(async (_user: string, name: string) => {
          if (name === options.failDelete) throw new Error('chroma down');
        }),
      };
      const prisma = {
        ingestedDocument: {
          findMany: jest.fn().mockResolvedValue(docs),
          upsert: jest.fn().mockResolvedValue({ id: 'row-1' }),
          delete: jest.fn().mockResolvedValue(undefined),
        },
        kbIngestBatch: { count: jest.fn().mockResolvedValue(options.activeBatches ?? 0) },
      };
      const profileScheduler = { schedule: jest.fn().mockResolvedValue(undefined) };
      const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any, profileScheduler as any);
      return { service, ingestionClient, prisma, profileScheduler };
    }

    const doc = (id: string, driveId: string | null) => ({ id, userId: 'u', name: `${id}.pdf`, driveItemId: `item-${id}`, driveId });

    it('recordIngestedDocument() stores the library the file came from', async () => {
      const { service, prisma } = build();

      await service.recordIngestedDocument('u', ingestResult, { relativePath: 'a.pdf', docType: null, retrievalMode: null, driveId: 'drive-1' });

      expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ driveId: 'drive-1' }), update: expect.objectContaining({ driveId: 'drive-1' }) }),
      );
    });

    it('ingestItem() with a library that differs from the knowledge base is refused before anything is ingested', async () => {
      const { service, ingestionClient } = build([doc('x', 'drive-OLD')]);

      await expect(service.ingestItem('a.pdf', 'item-1', 'https://dl', 'a.pdf', 'u', null, null, 'drive-NEW')).rejects.toMatchObject({
        response: { code: 'kb_drive_mismatch', otherDriveDocuments: 1 },
      });
      expect(ingestionClient.ingestItem).not.toHaveBeenCalled();
    });

    it('ingestDriveItem() (the batch path) is refused too when the knowledge base moved to another library since the batch was queued', async () => {
      const { service } = build([doc('x', 'drive-OLD')]);
      const ingestDriveItem = jest.fn().mockResolvedValue(ingestResult);
      (service as any).ingestionClient.ingestDriveItem = ingestDriveItem;

      await expect(
        service.ingestDriveItem({ userId: 'u', driveId: 'drive-NEW', itemId: 'item-1', relativePath: 'a.pdf', docType: null, retrievalMode: null }),
      ).rejects.toMatchObject({ response: { code: 'kb_drive_mismatch', otherDriveDocuments: 1 } });
      expect(ingestDriveItem).not.toHaveBeenCalled();
    });

    it('ingestDriveItem() from the same library goes through', async () => {
      const { service } = build([doc('x', 'drive-1')]);
      const ingestDriveItem = jest.fn().mockResolvedValue(ingestResult);
      (service as any).ingestionClient.ingestDriveItem = ingestDriveItem;

      await service.ingestDriveItem({ userId: 'u', driveId: 'drive-1', itemId: 'item-1', relativePath: 'a.pdf', docType: null, retrievalMode: null });

      expect(ingestDriveItem).toHaveBeenCalled();
    });

    it('ingestItem() from the same library goes through and records it', async () => {
      const { service, prisma } = build([doc('x', 'drive-1')]);

      await service.ingestItem('a.pdf', 'item-1', 'https://dl', 'a.pdf', 'u', null, null, 'drive-1');

      expect(prisma.ingestedDocument.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ driveId: 'drive-1' }) }));
    });

    describe('switchDrive()', () => {
      it('removes the documents of other libraries and of unknown ones, keeps the new library\'s, and schedules the profile once', async () => {
        const { service, ingestionClient, prisma, profileScheduler } = build([doc('keep', 'drive-NEW'), doc('old', 'drive-OLD'), doc('legacy', null)]);

        const result = await service.switchDrive('u', 'drive-NEW');

        expect(result).toEqual({ removed: 2, failed: [] });
        expect(ingestionClient.deleteDocument.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(['legacy.pdf', 'old.pdf']);
        expect(prisma.ingestedDocument.delete.mock.calls.map((c: any[]) => c[0].where.id).sort()).toEqual(['legacy', 'old']);
        expect(profileScheduler.schedule).toHaveBeenCalledTimes(1);
      });

      it('does nothing, and schedules nothing, when there is nothing to remove', async () => {
        const { service, ingestionClient, profileScheduler } = build([doc('keep', 'drive-NEW')]);

        expect(await service.switchDrive('u', 'drive-NEW')).toEqual({ removed: 0, failed: [] });
        expect(ingestionClient.deleteDocument).not.toHaveBeenCalled();
        expect(profileScheduler.schedule).not.toHaveBeenCalled();
      });

      it('is refused while a batch is still going, so no file is added back behind the cleanup', async () => {
        const { service, ingestionClient } = build([doc('old', 'drive-OLD')], { activeBatches: 1 });

        await expect(service.switchDrive('u', 'drive-NEW')).rejects.toMatchObject({ response: { code: 'kb_batch_active' } });
        expect(ingestionClient.deleteDocument).not.toHaveBeenCalled();
      });

      it('reports a document it could not remove, keeps its row so it stays listed, and carries on with the rest', async () => {
        const { service, prisma } = build([doc('bad', 'drive-OLD'), doc('good', 'drive-OLD')], { failDelete: 'bad.pdf' });

        const result = await service.switchDrive('u', 'drive-NEW');

        expect(result.removed).toBe(1);
        expect(result.failed).toEqual([{ id: 'bad', name: 'bad.pdf' }]);
        expect(prisma.ingestedDocument.delete.mock.calls.map((c: any[]) => c[0].where.id)).toEqual(['good']);
      });

      it('only ever touches the given user\'s documents', async () => {
        const { service, prisma } = build([]);

        await service.switchDrive('user-7', 'drive-NEW');

        expect(prisma.ingestedDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-7' } }));
      });
    });
  });
});

describe('KbService.reconcileOrphans()', () => {
  type Source = { source_id: string | null; source_files: string[]; file_hashes: string[]; chunks: number };
  const source = (id: string | null, name: string, chunks = 2): Source => ({ source_id: id, source_files: [name], file_hashes: ['h'], chunks });

  function build(sources: Source[], rows: string[], options: { activeBatches?: number; failDelete?: string } = {}) {
    const ingestionClient = {
      listKbSources: jest.fn().mockResolvedValue(sources),
      deleteDocument: jest.fn().mockImplementation(async (_user: string, _name: string, sourceId: string) => {
        if (sourceId === options.failDelete) throw new Error('chroma down');
      }),
      deleteUnattributedKbChunks: jest.fn().mockResolvedValue(3),
    };
    const prisma = {
      ingestedDocument: { findMany: jest.fn().mockResolvedValue(rows.map((driveItemId) => ({ driveItemId }))) },
      kbIngestBatch: { count: jest.fn().mockResolvedValue(options.activeBatches ?? 0) },
    };
    const profileScheduler = { schedule: jest.fn().mockResolvedValue(undefined) };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any, profileScheduler as any);
    return { service, ingestionClient, prisma, profileScheduler };
  }

  const stored = [source('item-keep', 'spec.docx'), source('item-old', 'spec.docx', 5), source(null, 'ancient.docx', 3)];

  it('lists content the KB page has no record of, and deletes nothing, on a dry run', async () => {
    const { service, ingestionClient, profileScheduler } = build(stored, ['item-keep']);

    const result = await service.reconcileOrphans('u', true);

    expect(result).toEqual({
      dryRun: true,
      orphans: [
        { sourceId: 'item-old', fileNames: ['spec.docx'], chunks: 5 },
        { sourceId: null, fileNames: ['ancient.docx'], chunks: 3 },
      ],
      removed: 0,
      failed: [],
    });
    expect(ingestionClient.deleteDocument).not.toHaveBeenCalled();
    expect(ingestionClient.deleteUnattributedKbChunks).not.toHaveBeenCalled();
    expect(profileScheduler.schedule).not.toHaveBeenCalled();
  });

  it('removes each unlisted source (and the content with no source id), never a listed one, and rebuilds the profile once', async () => {
    const { service, ingestionClient, profileScheduler } = build(stored, ['item-keep']);

    const result = await service.reconcileOrphans('u', false);

    expect(result.removed).toBe(2);
    expect(ingestionClient.deleteDocument).toHaveBeenCalledTimes(1);
    expect(ingestionClient.deleteDocument).toHaveBeenCalledWith('u', 'spec.docx', 'item-old');
    expect(ingestionClient.deleteUnattributedKbChunks).toHaveBeenCalledWith('u');
    expect(profileScheduler.schedule).toHaveBeenCalledTimes(1);
  });

  it('does nothing, and schedules nothing, when every stored source is listed', async () => {
    const { service, ingestionClient, profileScheduler } = build([source('item-keep', 'spec.docx')], ['item-keep']);

    expect(await service.reconcileOrphans('u', false)).toEqual({ dryRun: false, orphans: [], removed: 0, failed: [] });
    expect(ingestionClient.deleteDocument).not.toHaveBeenCalled();
    expect(profileScheduler.schedule).not.toHaveBeenCalled();
  });

  it('is refused while a batch is still going, before it reads or deletes anything', async () => {
    const { service, ingestionClient } = build(stored, ['item-keep'], { activeBatches: 1 });

    await expect(service.reconcileOrphans('u', false)).rejects.toMatchObject({ response: { code: 'kb_batch_active' } });
    expect(ingestionClient.listKbSources).not.toHaveBeenCalled();
    expect(ingestionClient.deleteDocument).not.toHaveBeenCalled();
  });

  it('reports a source it could not remove and carries on with the rest', async () => {
    const { service, ingestionClient } = build([source('item-a', 'a.docx'), source('item-b', 'b.docx')], [], { failDelete: 'item-a' });

    const result = await service.reconcileOrphans('u', false);

    expect(result.removed).toBe(1);
    expect(result.failed).toEqual([{ sourceId: 'item-a', fileNames: ['a.docx'] }]);
    expect(ingestionClient.deleteDocument).toHaveBeenCalledTimes(2);
  });

  it("only ever looks at the given user's rows and sources", async () => {
    const { service, ingestionClient, prisma } = build([], []);

    await service.reconcileOrphans('user-7', true);

    expect(ingestionClient.listKbSources).toHaveBeenCalledWith('user-7');
    expect(prisma.ingestedDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-7' } }));
  });
});

describe('KbService: a file whose chunks were stored but whose row could not be saved', () => {
  const stored = { documentName: 'a.pdf', driveitemId: 'item-1', mimeType: 'application/pdf', sizeBytes: 5, chunksStored: 2, chunksInStore: 2, skippedUnchanged: false };

  function build(options: { existingRow?: boolean; lookupFails?: boolean } = {}) {
    const ingestionClient = {
      ingestItem: jest.fn().mockResolvedValue(stored),
      ingestDriveItem: jest.fn().mockResolvedValue(stored),
      ingestFolderUrl: jest.fn(),
      deleteDocument: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      ingestedDocument: {
        findMany: jest.fn().mockResolvedValue([]), // the one-library check made before an ingest
        upsert: jest.fn().mockRejectedValue(new Error('db down')),
        findUnique: options.lookupFails
          ? jest.fn().mockRejectedValue(new Error('db still down'))
          : jest.fn().mockResolvedValue(options.existingRow ? { id: 'row-1' } : null),
      },
      kbIngestBatch: { count: jest.fn().mockResolvedValue(0) },
    };
    const profileScheduler = { schedule: jest.fn().mockResolvedValue(undefined) };
    const service = new KbService(prisma as any, ingestionClient as any, fakeCredentialVault as any, profileScheduler as any);
    return { service, ingestionClient, prisma };
  }

  it('removes the chunks again, so they are not left unlisted, and still reports the failure (single file)', async () => {
    const { service, ingestionClient } = build();

    await expect(service.ingestItem('a.pdf', 'item-1', 'https://dl', 'Sub/a.pdf', 'u', null)).rejects.toThrow('db down');

    expect(ingestionClient.deleteDocument).toHaveBeenCalledWith('u', 'Sub/a.pdf', 'item-1');
  });

  it('does the same for a file added by a batch', async () => {
    const { service, ingestionClient } = build();

    await expect(
      service.ingestDriveItem({ userId: 'u', driveId: 'd', itemId: 'item-1', relativePath: 'a.pdf', docType: null, retrievalMode: null }),
    ).rejects.toThrow('db down');

    expect(ingestionClient.deleteDocument).toHaveBeenCalledWith('u', 'a.pdf', 'item-1');
  });

  it('keeps the chunks of a file that is already listed: a re-ingest would otherwise leave a listed document with none', async () => {
    const { service, ingestionClient } = build({ existingRow: true });

    await expect(service.ingestItem('a.pdf', 'item-1', 'https://dl', 'a.pdf', 'u', null)).rejects.toThrow('db down');

    expect(ingestionClient.deleteDocument).not.toHaveBeenCalled();
  });

  it('removes nothing when it cannot tell whether the file is listed, and still reports the original failure', async () => {
    const { service, ingestionClient } = build({ lookupFails: true });

    await expect(service.ingestItem('a.pdf', 'item-1', 'https://dl', 'a.pdf', 'u', null)).rejects.toThrow('db down');

    expect(ingestionClient.deleteDocument).not.toHaveBeenCalled();
  });

  it('a failed removal never replaces the original error', async () => {
    const { service, ingestionClient } = build();
    ingestionClient.deleteDocument.mockRejectedValue(new Error('chroma down'));

    await expect(service.ingestItem('a.pdf', 'item-1', 'https://dl', 'a.pdf', 'u', null)).rejects.toThrow('db down');
  });

  it('removes the chunks of each file of a folder whose row failed, marks it failed, and leaves the others alone', async () => {
    const { service, ingestionClient, prisma } = build();
    prisma.ingestedDocument.upsert.mockImplementation(async (args: any) => {
      if (args.where.userId_driveItemId.driveItemId === 'item-bad') throw new Error('db down');
      return { id: 'row' };
    });
    const files = [
      { file: 'good.pdf', status: 'ingested', driveitemId: 'item-good', mimeType: 'application/pdf', sizeBytes: 1, chunksInStore: 1 },
      { file: 'bad.pdf', relativePath: 'Sub/bad.pdf', status: 'ingested', driveitemId: 'item-bad', mimeType: 'application/pdf', sizeBytes: 1, chunksInStore: 1 },
    ];
    ingestionClient.ingestFolderUrl.mockResolvedValue({ files });

    const result: any = await service.ingestFolderUrl('https://x', 'u', null);

    expect(result.files.map((f: any) => f.status)).toEqual(['ingested', 'failed']);
    expect(ingestionClient.deleteDocument).toHaveBeenCalledTimes(1);
    expect(ingestionClient.deleteDocument).toHaveBeenCalledWith('u', 'Sub/bad.pdf', 'item-bad');
  });
});

