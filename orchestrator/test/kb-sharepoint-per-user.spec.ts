import { KbService } from '../src/modules/kb/kb.service';

// Owner finding (2026-11-26): one pasted SharePoint token served every user, so each user's knowledge base was read with someone else's
// Microsoft identity. Each user now connects their own; no call ever uses another user's token or a server-wide one.

const ALICE = 'user-alice';
const BOB = 'user-bob';

function memoryVault() {
  const rows = new Map<string, string>();
  return {
    rows,
    get: jest.fn(async (owner: string, kind: string) => rows.get(`${owner}|${kind}`) ?? null),
    set: jest.fn(async (owner: string, kind: string, value: string) => void rows.set(`${owner}|${kind}`, value)),
    delete: jest.fn(async (owner: string, kind: string) => void rows.delete(`${owner}|${kind}`)),
    has: jest.fn(async (owner: string, kind: string) => rows.has(`${owner}|${kind}`)),
  };
}

function ingestion() {
  return {
    getSharePointStatus: jest.fn(async (token: string | null) => ({ status: token ? 'valid' : 'not_configured', expiresInSeconds: token ? 3600 : null })),
    ingestUrl: jest.fn().mockResolvedValue({ driveitemId: 'i1', name: 'a.docx', sizeBytes: 1, mimeType: null, chunks: 1, status: 'ingested' }),
    browseFolder: jest.fn().mockResolvedValue([]),
    browseChildren: jest.fn().mockResolvedValue([]),
    ingestDriveItem: jest.fn().mockResolvedValue({ driveitemId: 'i1', name: 'a.docx', sizeBytes: 1, mimeType: null, chunks: 1, status: 'ingested' }),
  };
}

function prisma() {
  return {
    ingestedDocument: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ id: 'doc-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

async function connected() {
  const vault = memoryVault();
  const client = ingestion();
  const resumer = { resumePausedBy: jest.fn().mockResolvedValue(0) };
  const service = new KbService(prisma() as any, client as any, vault as any, undefined as any, resumer as any);
  await service.reconnectSharePointToken('alice-token', ALICE);
  return { service, client, vault, resumer };
}

describe('SharePoint: one connection per user', () => {
  it('stores a token as its user own, never as a shared one', async () => {
    const { vault } = await connected();
    expect(vault.set).toHaveBeenCalledWith(`user:${ALICE}`, 'sharepoint_token', expect.any(String));
    expect([...vault.rows.keys()].some((key) => key.startsWith('shared|'))).toBe(false);
  });

  it('shows each user their own connection: another user who has not connected is not connected', async () => {
    const { service, client } = await connected();
    expect(await service.getSharePointStatus(ALICE)).toEqual({ status: 'valid', expiresInSeconds: 3600 });
    client.getSharePointStatus.mockClear();
    expect(await service.getSharePointStatus(BOB)).toEqual({ status: 'not_configured', expiresInSeconds: null });
    // Never asked with no token: ingestion would fall back to a server-wide one.
    expect(client.getSharePointStatus).not.toHaveBeenCalled();
  });

  it('browses and ingests with the token of the user it acts for', async () => {
    const { service, client } = await connected();
    await service.browseFolder('https://contoso.sharepoint.com/f', ALICE, '');
    expect(client.browseFolder).toHaveBeenCalledWith('https://contoso.sharepoint.com/f', 'alice-token');
    await service.ingestUrl('https://contoso.sharepoint.com/x', ALICE, null);
    expect(client.ingestUrl).toHaveBeenCalledWith('https://contoso.sharepoint.com/x', ALICE, null, 'alice-token', null);
    await service.ingestDriveItem({ userId: ALICE, driveId: 'd', itemId: 'i', relativePath: 'a.docx', docType: null, retrievalMode: null, scheduleProfile: false });
    expect(client.ingestDriveItem).toHaveBeenCalledWith('d', 'i', ALICE, null, 'alice-token', null, undefined);
  });

  it('refuses SharePoint work for a user who has not connected, and never uses another user token or a server one', async () => {
    const { service, client } = await connected();
    await expect(service.browseFolder('https://contoso.sharepoint.com/f', BOB, '')).rejects.toThrow(/not connected/i);
    await expect(service.ingestUrl('https://contoso.sharepoint.com/x', BOB, null)).rejects.toThrow(/not connected/i);
    await expect(
      service.ingestDriveItem({ userId: BOB, driveId: 'd', itemId: 'i', relativePath: 'a.docx', docType: null, retrievalMode: null, scheduleProfile: false }),
    ).rejects.toThrow(/not connected/i);
    expect(client.browseFolder).not.toHaveBeenCalled();
    expect(client.ingestUrl).not.toHaveBeenCalled();
    expect(client.ingestDriveItem).not.toHaveBeenCalled();
  });

  it('a reconnect resumes only the reconnecting user batches', async () => {
    const { resumer } = await connected();
    expect(resumer.resumePausedBy).toHaveBeenCalledWith('sharepoint_token', ALICE);
  });
});
