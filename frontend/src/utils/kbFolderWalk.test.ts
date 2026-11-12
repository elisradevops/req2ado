import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { walkFolders, type WalkProgress } from './kbFolderWalk';
import * as kbApi from '../api/kb';
import type { FolderTreeEntry } from '../api/kb';

vi.mock('../api/kb');

const file = (id: string, name = `${id}.pdf`, overrides: Partial<FolderTreeEntry> = {}): FolderTreeEntry => ({
  id, name, mimeType: null, sizeBytes: 100, isFolder: false, driveId: null, parentDriveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: `https://dl/${id}`, ...overrides,
});
const folder = (id: string, name = id): FolderTreeEntry => ({
  id, name, mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-1', parentDriveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null,
});

// A tree keyed by the folder's item id.
function tree(children: Record<string, FolderTreeEntry[]>): void {
  vi.mocked(kbApi.browseSubfolder).mockImplementation(async (_drive, itemId) => children[itemId] ?? []);
}

const walk = (roots: FolderTreeEntry[], options: Partial<Parameters<typeof walkFolders>[2]> = {}) =>
  walkFolders(roots.map((entry) => ({ entry, subpath: entry.name })), 'user-1', { pathPrefix: 'Root', ...options });

describe('walkFolders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('finds the files in a folder and in the folders below it, with the path under the starting folder', async () => {
    tree({ s: [file('a'), folder('deep')], deep: [file('b', 'b.pdf')] });

    const result = await walk([folder('s', 'Sub Items')]);

    expect(result.files.map((f) => [f.entry.id, f.subpath])).toEqual([['a', 'Sub Items'], ['b', 'Sub Items/deep']]);
    expect(result.partial).toEqual([]);
  });

  it('asks Graph for each folder by drive and id, with the full path so already-added files are recognised', async () => {
    tree({ s: [folder('deep')], deep: [] });

    await walk([folder('s', 'Sub Items')], { pathPrefix: 'Standards' });

    expect(kbApi.browseSubfolder).toHaveBeenNthCalledWith(1, 'drive-1', 's', 'user-1', 'Standards/Sub Items', undefined);
    expect(kbApi.browseSubfolder).toHaveBeenNthCalledWith(2, 'drive-1', 'deep', 'user-1', 'Standards/Sub Items/deep', undefined);
  });

  it('puts the files of the starting folder at the top when there is no prefix', async () => {
    tree({ s: [file('a')] });

    const result = await walk([folder('s', 'S')], { pathPrefix: '' });

    expect(kbApi.browseSubfolder).toHaveBeenCalledWith('drive-1', 's', 'user-1', 'S', undefined);
    expect(result.files[0].subpath).toBe('S');
  });

  it('leaves out a file with no download link (a shortcut), without calling it a problem', async () => {
    tree({ s: [file('a'), file('x', 'x.url', { downloadUrl: null })] });

    const result = await walk([folder('s')]);

    expect(result.files.map((f) => f.entry.id)).toEqual(['a']);
    expect(result.partial).toEqual([]);
  });

  it('never visits a folder twice', async () => {
    tree({ s: [folder('t')], t: [folder('s')] });

    await walk([folder('s'), folder('t')]);

    expect(vi.mocked(kbApi.browseSubfolder)).toHaveBeenCalledTimes(2);
  });

  it('stops at the depth limit and says so', async () => {
    tree({ f0: [folder('f1')], f1: [folder('f2')], f2: [file('deepfile')] });

    const result = await walk([folder('f0')], { maxDepth: 2 });

    expect(result.files).toEqual([]);
    expect(result.partial.join(' ')).toMatch(/more than 2 levels/i);
  });

  it('stops at the folder limit and says so, keeping what it found', async () => {
    tree({ root: [folder('a'), folder('b'), folder('c')], a: [file('fa')], b: [file('fb')], c: [file('fc')] });

    const result = await walk([folder('root')], { maxFolders: 3 });

    expect(result.files.map((f) => f.entry.id)).toEqual(['fa', 'fb']);
    expect(result.partial.join(' ')).toMatch(/more than 3 folders/i);
  });

  it('stops once it has more files than a batch holds, and says so', async () => {
    tree({ s: Array.from({ length: 6 }, (_, i) => file(`f${i}`)), t: [file('late')] });

    const result = await walk([folder('s'), folder('t')], { maxFiles: 5 });

    expect(result.files.length).toBe(6);
    expect(result.partial.join(' ')).toMatch(/more than 5 files/i);
    expect(kbApi.browseSubfolder).not.toHaveBeenCalledWith('drive-1', 't', expect.anything(), expect.anything(), undefined);
  });

  it('records a folder it cannot read and carries on with the rest', async () => {
    vi.mocked(kbApi.browseSubfolder).mockImplementation(async (_drive, itemId) => {
      if (itemId === 'bad') throw new AxiosError('x', 'ERR', undefined, undefined, { status: 403 } as never);
      return itemId === 'good' ? [file('g')] : [];
    });

    const result = await walk([folder('bad', 'Secret'), folder('good')]);

    expect(result.files.map((f) => f.entry.id)).toEqual(['g']);
    expect(result.partial.join(' ')).toContain('Secret');
  });

  it.each([401, 424])('stops everything when SharePoint access has expired (%i), keeping what was found', async (status) => {
    vi.mocked(kbApi.browseSubfolder).mockImplementation(async (_drive, itemId) => {
      if (itemId === 'two') throw new AxiosError('x', 'ERR', undefined, undefined, { status } as never);
      return itemId === 'one' ? [file('a')] : [file('never')];
    });

    const result = await walk([folder('one'), folder('two'), folder('three')]);

    expect(result.files.map((f) => f.entry.id)).toEqual(['a']);
    expect(result.expired).toBe(true);
    expect(result.partial.join(' ')).toMatch(/reconnect/i);
    expect(kbApi.browseSubfolder).not.toHaveBeenCalledWith('drive-1', 'three', expect.anything(), expect.anything(), undefined);
  });

  it('stops when cancelled, keeping what was found and marking the result as cancelled', async () => {
    const controller = new AbortController();
    vi.mocked(kbApi.browseSubfolder).mockImplementation(async (_drive, itemId) => {
      if (itemId === 'one') {
        controller.abort();
        return [file('a')];
      }
      return [file('b')];
    });

    const result = await walk([folder('one'), folder('two')], { signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.files.map((f) => f.entry.id)).toEqual(['a']);
    expect(kbApi.browseSubfolder).toHaveBeenCalledTimes(1);
  });

  it('is cancelled at once when the request itself is aborted', async () => {
    const controller = new AbortController();
    vi.mocked(kbApi.browseSubfolder).mockImplementation(async () => {
      controller.abort();
      throw new AxiosError('canceled', 'ERR_CANCELED');
    });

    const result = await walk([folder('one')], { signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.partial).toEqual([]);
  });

  it('reports progress as it goes', async () => {
    tree({ s: [file('a'), folder('t')], t: [file('b')] });
    const seen: WalkProgress[] = [];

    await walk([folder('s')], { onProgress: (progress) => seen.push({ ...progress }) });

    expect(seen.at(-1)).toEqual({ folders: 2, files: 2 });
  });
});
