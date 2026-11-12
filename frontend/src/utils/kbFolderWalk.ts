import { isAxiosError } from 'axios';
import { browseSubfolder, type FolderTreeEntry } from '../api/kb';
import { KB_BATCH_MAX_FILES, KB_WALK_MAX_DEPTH, KB_WALK_MAX_FOLDERS } from './kbBatchLimits';

// Finds every file below some folders, for "include subfolders". One folder is listed at a time (breadth first), each by drive and
// item id, so the scan can report how far it is, be cancelled between folders, and keep what it found when something goes wrong.
// Nothing here throws for a problem with the tree: a folder that cannot be read, a limit, an expired token and a cancel all come
// back in the result, and the caller decides what to tell the user.

export interface WalkRoot {
  entry: FolderTreeEntry;
  // The folder's path below the folder the user is looking at (its own name for a folder shown in that list).
  subpath: string;
}

export interface WalkedFile {
  entry: FolderTreeEntry;
  // The path of the folder holding the file, below the folder the user is looking at.
  subpath: string;
}

export interface WalkProgress {
  folders: number;
  files: number;
}

export interface WalkResult {
  files: WalkedFile[];
  // Why the list may be incomplete, in words (one entry per cause).
  partial: string[];
  // SharePoint access ran out during the scan: nothing further can be read until it is reconnected.
  expired: boolean;
  cancelled: boolean;
}

export interface WalkOptions {
  // The path of the folder the user is looking at ('' for the root); what the server matches already-added files against.
  pathPrefix: string;
  signal?: AbortSignal;
  onProgress?: (progress: WalkProgress) => void;
  maxDepth?: number;
  maxFolders?: number;
  // The scan stops once it holds more than this many files: enough to know a batch would be too big.
  maxFiles?: number;
}

const joinPath = (...parts: string[]): string => parts.filter(Boolean).join('/');

export async function walkFolders(roots: WalkRoot[], userId: string, options: WalkOptions): Promise<WalkResult> {
  const { pathPrefix, signal, onProgress, maxDepth = KB_WALK_MAX_DEPTH, maxFolders = KB_WALK_MAX_FOLDERS, maxFiles = KB_BATCH_MAX_FILES + 1 } = options;
  const files: WalkedFile[] = [];
  const partial: string[] = [];
  let expired = false;
  let cancelled = false;
  let visited = 0;
  const seen = new Set<string>();
  const queue: { entry: FolderTreeEntry; subpath: string; depth: number }[] = [];

  const enqueue = (entry: FolderTreeEntry, subpath: string, depth: number): void => {
    const key = `${entry.driveId ?? entry.parentDriveId ?? ''}:${entry.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ entry, subpath, depth });
  };
  for (const root of roots) enqueue(root.entry, root.subpath, 1);

  let depthLimitHit = false;
  let folderLimitHit = false;
  while (queue.length > 0) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    if (files.length >= maxFiles) {
      partial.push(`Stopped after finding more than ${maxFiles} files.`);
      break;
    }
    if (visited >= maxFolders) {
      folderLimitHit = true;
      break;
    }
    const { entry, subpath, depth } = queue.shift()!;
    const driveId = entry.driveId ?? entry.parentDriveId;
    if (!driveId) {
      partial.push(`Could not open "${subpath}": SharePoint did not say which drive it is in.`);
      continue;
    }
    visited += 1;
    let children: FolderTreeEntry[];
    try {
      children = await browseSubfolder(driveId, entry.id, userId, joinPath(pathPrefix, subpath), signal);
    } catch (error) {
      if (signal?.aborted || (isAxiosError(error) && error.code === 'ERR_CANCELED')) {
        cancelled = true;
        break;
      }
      if (isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 424)) {
        expired = true;
        partial.push('SharePoint access expired during the scan. Reconnect SharePoint to include the rest.');
        break;
      }
      partial.push(`Could not read "${subpath}".`);
      onProgress?.({ folders: visited, files: files.length });
      continue;
    }
    for (const child of children) {
      if (child.isFolder) {
        if (depth >= maxDepth) depthLimitHit = true;
        else enqueue(child, joinPath(subpath, child.name), depth + 1);
      } else if (child.downloadUrl) {
        // A file with no download link is a shortcut or the like: there is nothing to ingest, and nothing to report.
        files.push({ entry: child, subpath });
      }
    }
    onProgress?.({ folders: visited, files: files.length });
  }
  if (depthLimitHit) partial.push(`Some folders are nested more than ${maxDepth} levels deep and were not opened.`);
  if (folderLimitHit) partial.push(`Stopped after opening ${maxFolders} folders; there are more than ${maxFolders} folders here.`);
  return { files, partial, expired, cancelled };
}
