import { createHash } from 'node:crypto';
import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { FolderChild, IngestionHttpClient, Rubric, SharePointStatus } from '../pipeline/ingestion-http.client';
import { CredentialVaultService, userOwnerKey } from '../auth/credential-vault.service';
import { KbDriveMismatchException, findDriveConflict } from './kb-drive';

/**
 * The user has no SharePoint token of their own (owner finding, 2026-11-26: one shared token used to serve every user). Answered as 424, as
 * an expired token is (kb.controller.ts), so the page offers to connect and the batch runner pauses that user's batch until they do.
 */
export class SharePointNotConnectedException extends HttpException {
  constructor() {
    super('SharePoint is not connected for you. Connect it with your own token on the Knowledge base page.', 424);
  }
}

interface VaultedSharePointToken {
  token: string;
  rotatedByUserId: string;
  rotatedAt: string;
}

export interface IngestUrlResult {
  documentName: string;
  driveitemId: string;
  mimeType: string | null;
  sizeBytes: number;
  chunksStored: number;
  // What the vector store holds for the file now (see the ingestion client); null when unknown.
  chunksInStore: number | null;
  skippedUnchanged: boolean;
}

export type KbProfileState = 'none' | 'queued' | 'building' | 'ready' | 'no_model';

/** What the page shows about the grading rubric the knowledge base builds: whether it is ready, and what each document gave it. */
export interface KbProfileView {
  state: KbProfileState;
  // When the stored profile was built; null when none is stored.
  builtAt: string | null;
  version: string | null;
  builtWith: string | null;
  docsInKb: number;
  docsContributing: number;
  truncated: boolean;
  docs: { file: string; status: string; reason: string | null; categories: number; rules: number; typeDefinitions: number; glossary: number }[];
  conflicts: { kind: string; key: string; variantCount: number }[];
}

/** Stored KB content with no matching document on the KB page (see KbService.reconcileOrphans). */
export interface KbOrphanSource {
  /** Null for chunks that carry no source id at all. */
  sourceId: string | null;
  fileNames: string[];
  chunks: number;
}

export interface KbReconcileResult {
  dryRun: boolean;
  orphans: KbOrphanSource[];
  removed: number;
  failed: { sourceId: string | null; fileNames: string[] }[];
}

export interface IngestedDocumentSummary {
  id: string;
  userId: string;
  driveItemId: string;
  name: string;
  sizeBytes: number;
  mimeType: string | null;
  docType: string | null;
  retrievalMode: string | null;
  // Chunks the vector store held for this file at its last successful ingest (a snapshot); null = unknown (older rows, or the count was unavailable).
  chunkCount: number | null;
  // The SharePoint library the file came from; null = recorded before this was tracked.
  driveId: string | null;
  ingestedAt: Date;
}

export interface FolderIngestFile {
  file: string;
  status: string;
  chunksStored: number;
  chunksInStore: number | null;
  driveitemId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  reason: string | null;
  relativePath: string | null;
  // The SharePoint library the file is in, when ingestion says.
  driveId?: string;
}

export interface FolderIngestUrlResult {
  files: FolderIngestFile[];
}

export interface BrowseFolderEntry {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  isFolder: boolean;
  driveId: string | null;
  // True when this file is already in this user's KB -- matched against
  // IngestedDocument.driveItemId (the stable Graph identity, so a
  // rename/move still matches; driveItemId is a required column, so there
  // is no legacy-row fallback to fall back to). Always false for folders
  // themselves; a folder has no single ingested/not state.
  alreadyIngested: boolean;
  // The matched IngestedDocument's own id when alreadyIngested is true,
  // null otherwise -- needed because removing a document (DELETE
  // /kb/documents/:id) is keyed by that Prisma row's id, which a Graph
  // listing has no way to know on its own.
  ingestedDocumentId: string | null;
  // The matched row's stored chunk count (IngestedDocument.chunkCount): 0
  // means the row exists but the vector store held nothing at last ingest
  // ("no vectors"); null for not-ingested files, folders, and legacy rows
  // that never recorded a count (unknown).
  chunkCount: number | null;
  // The matched row's retrieval mode ('always_include' | 'retrieve' | null),
  // so a re-ingest from the explorer can preserve it instead of resetting it.
  retrievalMode: string | null;
  // Files only -- Graph's pre-signed download URL, passed straight through
  // from ingestion so a tree row's ingest action can call POST
  // /kb/ingest-item without a share link for this specific file.
  downloadUrl: string | null;
}

const logger = new Logger('KbService');

// A token is pasted from somewhere: a Graph Explorer tab, a curl example, a chat. Take off what is not part of it so a real token is not
// rejected for how it was copied: an "Authorization: Bearer " prefix, surrounding quotes, and the spaces and line breaks a wrapped copy adds
// (a token has none inside). The cleaned value is what is checked and what is stored.
export function cleanPastedToken(pasted: string): string {
  return pasted
    .trim()
    .replace(/^authorization\s*:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '');
}

@Injectable()
export class KbService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingestionClient: IngestionHttpClient,
    private readonly credentialVault: CredentialVaultService,
    // Rebuilds the user's KB profile in the background after a change of their knowledge base (never fails the action).
    private readonly profileScheduler?: {
      schedule(userId: string): Promise<void>;
      activity?(userId: string): Promise<'idle' | 'queued' | 'building'>;
      hasModel?(userId: string): Promise<boolean>;
    },
    // Continues batch ingests that paused for want of a valid SharePoint token once a new one is saved.
    private readonly batchResumer?: { resumePausedBy(reason: string, userId: string): Promise<number> },
  ) {}

  /**
   * The user's own SharePoint token, saved by POST /kb/sharepoint/reconnect; null when they have not connected. Every SharePoint call acts
   * with the token of the user it acts for: never another user's, never a server-wide one (owner finding, 2026-11-26).
   */
  private async userGraphToken(userId: string): Promise<string | null> {
    const raw = await this.credentialVault.get(userOwnerKey(userId), 'sharepoint_token');
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as VaultedSharePointToken).token || null;
    } catch {
      return null;
    }
  }

  private async requireGraphToken(userId: string): Promise<string> {
    const token = await this.userGraphToken(userId);
    if (!token) throw new SharePointNotConnectedException();
    return token;
  }

  /** The user's own connection. One who has not connected is not configured: ingestion is never asked without a token. */
  async getSharePointStatus(userId: string): Promise<SharePointStatus> {
    const token = await this.userGraphToken(userId);
    if (!token) return { status: 'not_configured', expiresInSeconds: null };
    return this.ingestionClient.getSharePointStatus(token);
  }

  /**
   * Validates a candidate token live against Graph before storing anything
   * -- a bad paste must never overwrite a working token. Attribution
   * (rotatedByUserId/rotatedAt) rides inside the encrypted payload itself
   * rather than a separate plaintext column, since the vault only stores
   * one opaque ciphertext blob per ownerKey/kind.
   */
  async reconnectSharePointToken(pastedToken: string, rotatedByUserId: string): Promise<SharePointStatus> {
    const token = cleanPastedToken(pastedToken);
    const status = await this.ingestionClient.getSharePointStatus(token);
    if (status.status !== 'valid') {
      return status;
    }
    const payload: VaultedSharePointToken = { token, rotatedByUserId, rotatedAt: new Date().toISOString() };
    await this.credentialVault.set(userOwnerKey(rotatedByUserId), 'sharepoint_token', JSON.stringify(payload));
    // This user's batches that stopped for want of a valid token can go on now; never another user's, which run on their own token.
    // Not part of the reconnect: if this fails the new token is saved all the same, and a batch can be resumed by hand.
    try {
      await this.batchResumer?.resumePausedBy('sharepoint_token', rotatedByUserId);
    } catch (error) {
      logger.warn(`Could not resume the knowledge-base batches waiting for a SharePoint token: ${error instanceof Error ? error.message : String(error)}`);
    }
    return status;
  }

  async ingestUrl(
    url: string,
    userId: string,
    docType: string | null,
    retrievalMode: string | null = null,
  ): Promise<IngestUrlResult> {
    const graphToken = await this.requireGraphToken(userId);
    const result = await this.ingestionClient.ingestUrl(url, userId, docType, graphToken, retrievalMode);
    await this.prisma.ingestedDocument.upsert({
      where: { userId_driveItemId: { userId, driveItemId: result.driveitemId } },
      create: {
        userId,
        driveItemId: result.driveitemId,
        name: result.documentName,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
        docType,
        retrievalMode,
        chunkCount: result.chunksInStore,
        ...(result.driveId ? { driveId: result.driveId } : {}),
      },
      update: {
        name: result.documentName,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
        docType,
        retrievalMode,
        chunkCount: result.chunksInStore,
        ...(result.driveId ? { driveId: result.driveId } : {}),
        ingestedAt: new Date(),
      },
    });
    await this.profileScheduler?.schedule(userId);
    return result;
  }

  /** The rubric the user's jobs are graded against (the KB's or the built-in one), with their pins and removals. */
  async getRubric(userId: string): Promise<Rubric> {
    return this.ingestionClient.getRubric(userId);
  }

  async putRubric(userId: string, input: { pinned: { name: string; passCondition: string }[]; removed: string[] }): Promise<Rubric> {
    return this.ingestionClient.putRubric(userId, input);
  }

  async listDocuments(userId?: string): Promise<IngestedDocumentSummary[]> {
    return this.prisma.ingestedDocument.findMany({
      where: userId ? { userId } : {},
      orderBy: { ingestedAt: 'desc' },
    });
  }

  /**
   * Removes a document from the KB: deletes its Chroma chunks first (so a
   * failure there leaves the Prisma row intact and the document still
   * listed, rather than silently orphaning live vector chunks with no
   * tracking row pointing at them), then the Prisma row itself.
   * `expectedUserId` scopes the lookup so one caller can't delete another
   * user's row by guessing its id -- returns null (caller maps to 404)
   * rather than throwing, since "not found" and "not yours" should look
   * identical to the caller (no id enumeration signal either way).
   */
  async deleteDocument(id: string, expectedUserId: string): Promise<IngestedDocumentSummary | null> {
    const document = await this.prisma.ingestedDocument.findUnique({ where: { id } });
    if (!document || document.userId !== expectedUserId) {
      return null;
    }
    await this.ingestionClient.deleteDocument(document.userId, document.name, document.driveItemId);
    await this.prisma.ingestedDocument.delete({ where: { id } });
    // An audit line for a destructive action: the file and a short hash of the user (for correlating events, not for identifying a person).
    logger.log(`KB document removed: user=${createHash('sha256').update(document.userId).digest('hex').slice(0, 10)} file="${document.name}" id=${id}`);
    await this.profileScheduler?.schedule(document.userId);
    return document;
  }

  /**
   * Switches an already-ingested file between similarity-gated retrieval and
   * full-context injection by retagging its stored chunks (no re-ingest). The
   * index is updated first so the row never claims a mode the index doesn't
   * have. Scoped like deleteDocument: null (caller maps to 404) for a missing
   * row or another user's.
   */
  async setRetrievalMode(id: string, expectedUserId: string, retrievalMode: 'retrieve' | 'always_include'): Promise<IngestedDocumentSummary | null> {
    const document = await this.prisma.ingestedDocument.findUnique({ where: { id } });
    if (!document || document.userId !== expectedUserId) {
      return null;
    }
    await this.ingestionClient.setRetrievalMode(document.userId, document.driveItemId, retrievalMode);
    return this.prisma.ingestedDocument.update({ where: { id }, data: { retrievalMode } });
  }

  /**
   * Lists a shared folder's immediate children (live from Graph, no
   * caching/mirroring -- see the design note on FolderChildSummary in
   * ingestion) and marks each file as already-in-KB or not, scoped to
   * `userId`. `pathPrefix` is the relative path the caller has descended
   * through so far (empty at the shared root) -- needed because
   * IngestedDocument.name for a folder-ingested file stores its full
   * relative path, not just its own filename.
   */
  async browseFolder(url: string, userId: string, pathPrefix: string): Promise<BrowseFolderEntry[]> {
    const graphToken = await this.requireGraphToken(userId);
    const children = await this.ingestionClient.browseFolder(url, graphToken);
    return this.withIngestedFlag(children, userId, pathPrefix);
  }

  async browseChildren(driveId: string, itemId: string, userId: string, pathPrefix: string): Promise<BrowseFolderEntry[]> {
    const graphToken = await this.requireGraphToken(userId);
    const children = await this.ingestionClient.browseChildren(driveId, itemId, graphToken);
    return this.withIngestedFlag(children, userId, pathPrefix);
  }

  private async withIngestedFlag(children: FolderChild[], userId: string, pathPrefix: string): Promise<BrowseFolderEntry[]> {
    const documents = await this.prisma.ingestedDocument.findMany({
      where: { userId },
      select: { id: true, driveItemId: true, chunkCount: true, retrievalMode: true },
    });
    // Matched by driveItemId -- the stable Graph drive-item identity, which
    // survives a SharePoint rename/move. Confirmed real bug (fixed here):
    // matching by name/fullName alone meant a renamed/moved file no longer
    // matched its own IngestedDocument row, so the tree showed it as
    // not-yet-ingested and invited a duplicate re-ingest. driveItemId is a
    // required, unique-per-user column (schema.prisma), so every row has
    // one -- no fallback needed.
    const idByDriveItemId = new Map(documents.map((d) => [d.driveItemId, d.id]));
    const chunkCountByDriveItemId = new Map(documents.map((d) => [d.driveItemId, d.chunkCount ?? null]));
    const retrievalModeByDriveItemId = new Map(documents.map((d) => [d.driveItemId, d.retrievalMode ?? null]));
    return children.map((child) => {
      const ingestedDocumentId = !child.isFolder ? (idByDriveItemId.get(child.id) ?? null) : null;
      return {
        ...child,
        alreadyIngested: ingestedDocumentId !== null,
        ingestedDocumentId,
        chunkCount: ingestedDocumentId !== null ? (chunkCountByDriveItemId.get(child.id) ?? null) : null,
        retrievalMode: ingestedDocumentId !== null ? (retrievalModeByDriveItemId.get(child.id) ?? null) : null,
      };
    });
  }

  /**
   * The grading rubric's state for the page's ingestion report. The profile is built in the background after an ingest (a
   * debounce, then a run of LLM calls), so `state` says whether a build is queued or running, and the stored profile, if any,
   * is returned either way (the previous one while a new one builds). With none stored: `none` when a build could start,
   * `no_model` when the user has no model connection to build it with (the first job builds it then, with its own).
   */
  async getProfile(userId: string): Promise<KbProfileView> {
    const activityPromise: Promise<'idle' | 'queued' | 'building'> = this.profileScheduler?.activity?.(userId) ?? Promise.resolve('idle');
    const [stored, activity] = await Promise.all([this.ingestionClient.getKbProfile(userId), activityPromise]);
    if (!stored) {
      const hasModel = (await this.profileScheduler?.hasModel?.(userId)) ?? true;
      return {
        state: activity !== 'idle' ? activity : hasModel ? 'none' : 'no_model',
        builtAt: null,
        version: null,
        builtWith: null,
        docsInKb: 0,
        docsContributing: 0,
        truncated: false,
        docs: [],
        conflicts: [],
      };
    }
    const profile = stored.profile ?? {};
    return {
      state: activity !== 'idle' ? activity : 'ready',
      builtAt: profile.built_at ?? null,
      version: stored.version,
      builtWith: stored.builtWith,
      docsInKb: stored.docsInKb,
      docsContributing: stored.docsContributing,
      truncated: profile.truncated ?? false,
      docs: (profile.docs ?? []).map((d) => ({
        file: d.file,
        status: d.status,
        reason: d.reason,
        categories: d.categories,
        rules: d.rules,
        typeDefinitions: d.type_definitions,
        glossary: d.glossary,
      })),
      conflicts: (profile.conflicts ?? []).map((c) => ({ kind: c.kind, key: c.key, variantCount: c.variants.length })),
    };
  }

  /**
   * Records an ingested file in the user's document list (the row the tree's alreadyIngested cross-reference and the
   * remove action use), under its relative path, and returns the row's id. The one place a file's row is written after
   * ingestion, shared by the single-file and the batch paths.
   */
  async recordIngestedDocument(
    userId: string,
    result: IngestUrlResult,
    options: { relativePath: string; docType: string | null; retrievalMode: string | null; driveId?: string },
  ): Promise<string> {
    const { relativePath, docType, retrievalMode, driveId } = options;
    // Left out when unknown, so an ingest path that does not know the library never blanks one that was recorded.
    const drive = driveId ? { driveId } : {};
    const row = await this.prisma.ingestedDocument.upsert({
      where: { userId_driveItemId: { userId, driveItemId: result.driveitemId } },
      create: {
        userId,
        driveItemId: result.driveitemId,
        name: relativePath,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
        docType,
        retrievalMode,
        chunkCount: result.chunksInStore,
        ...drive,
      },
      update: {
        name: relativePath,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
        docType,
        retrievalMode,
        chunkCount: result.chunksInStore,
        ...drive,
        ingestedAt: new Date(),
      },
    });
    return row.id;
  }

  /**
   * Called when ingestion stored a file's chunks but its document row could not be saved. Chunks with no row are invisible on the KB page
   * (so they can never be deleted there) while jobs still read them, so they are removed again, best-effort. Only when no row exists for
   * the file: a re-ingest of a listed file keeps its old row, and deleting its fresh chunks would leave a listed document with none. When
   * that cannot be told (the lookup fails too), nothing is removed: reconcileOrphans finds whatever is left.
   */
  private async removeChunksIfUnlisted(userId: string, name: string, driveItemId: string): Promise<void> {
    try {
      const row = await this.prisma.ingestedDocument.findUnique({ where: { userId_driveItemId: { userId, driveItemId } }, select: { id: true } });
      if (row) return;
      await this.ingestionClient.deleteDocument(userId, name, driveItemId);
      logger.warn(`KB: removed the stored chunks of "${name}" (${driveItemId}) because its document row could not be saved`);
    } catch (error) {
      logger.warn(`KB: could not remove the stored chunks of "${name}" (${driveItemId}) after its row failed to save: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** recordIngestedDocument for a file ingestion has just stored: when the row cannot be saved, the chunks are not left behind unlisted. */
  private async recordStoredDocument(
    userId: string,
    result: IngestUrlResult,
    options: { relativePath: string; docType: string | null; retrievalMode: string | null; driveId?: string },
  ): Promise<string> {
    try {
      return await this.recordIngestedDocument(userId, result, options);
    } catch (error) {
      await this.removeChunksIfUnlisted(userId, options.relativePath, result.driveitemId);
      throw error;
    }
  }

  /**
   * Ingests one file addressed by drive + item id and records it. Used by the batch runner: the SharePoint token is read
   * fresh from the vault for every file (so one rotated mid-batch is picked up), ingestion looks the item up itself (no
   * download link to expire), and the profile build is left to the caller (`scheduleProfile: false`), because a batch
   * schedules it once at the end: a build per file would start between files and compete with the next one for the LLM.
   * Nothing is recorded when the ingestion fails.
   */
  async ingestDriveItem(input: {
    userId: string;
    driveId: string;
    itemId: string;
    relativePath: string;
    docType: string | null;
    retrievalMode: 'retrieve' | 'always_include' | null;
    scheduleProfile?: boolean;
    signal?: AbortSignal;
  }): Promise<IngestUrlResult & { ingestedDocumentId: string }> {
    const { userId, driveId, itemId, relativePath, docType, retrievalMode, scheduleProfile = true, signal } = input;
    // The one-library rule, checked per file as ingestItem does: the knowledge base may have taken files of another library since
    // this batch was queued (a single file added meanwhile), and nothing here would stop this one landing beside them.
    const conflict = await findDriveConflict(this.prisma, userId, driveId);
    if (conflict) throw new KbDriveMismatchException(conflict);
    const graphToken = await this.requireGraphToken(userId);
    const result = await this.ingestionClient.ingestDriveItem(driveId, itemId, userId, docType, graphToken, retrievalMode, signal);
    const ingestedDocumentId = await this.recordStoredDocument(userId, result, { relativePath, docType, retrievalMode, driveId });
    if (scheduleProfile) await this.profileScheduler?.schedule(userId);
    return { ...result, ingestedDocumentId };
  }

  /**
   * Ingests exactly one file from an already-browsed tree row -- addressed
   * by its Graph download URL (no sharing link needed), so a reviewer can
   * pull in a single file without leaving the tree view. `relativePath` is
   * stored as the document's name (matching ingestFolderUrl's own
   * `relativePath ?? file` convention) so the tree's own alreadyIngested
   * cross-reference keeps matching correctly on the next browse.
   */
  async ingestItem(
    name: string,
    itemId: string,
    downloadUrl: string,
    relativePath: string,
    userId: string,
    docType: string | null,
    retrievalMode: string | null = null,
    driveId?: string,
  ): Promise<IngestUrlResult & { ingestedDocumentId: string }> {
    if (driveId) {
      const conflict = await findDriveConflict(this.prisma, userId, driveId);
      if (conflict) throw new KbDriveMismatchException(conflict);
    }
    const graphToken = await this.requireGraphToken(userId);
    const result = await this.ingestionClient.ingestItem(name, itemId, downloadUrl, userId, docType, graphToken, retrievalMode);
    // Returned so the tree row that triggered this can immediately offer a
    // remove action -- IngestUrlResult alone only carries the Graph
    // driveitemId, not the Prisma row's own id that DELETE
    // /kb/documents/:id needs.
    const ingestedDocumentId = await this.recordStoredDocument(userId, result, { relativePath, docType, retrievalMode, driveId });
    await this.profileScheduler?.schedule(userId);
    return { ...result, ingestedDocumentId };
  }

  /**
   * Makes the user's knowledge base hold only files of `driveId`: removes every document that came from another library, or
   * whose library was never recorded, the same way deleteDocument does (its chunks first, then its row, so a failure leaves
   * the file listed instead of orphaning vectors). Refused while a batch is still going, or it would add files back behind
   * the cleanup. A file that could not be removed is reported, not hidden, and the rest carry on; running it again finishes
   * the job. The profile is rebuilt once at the end.
   */
  async switchDrive(userId: string, driveId: string): Promise<{ removed: number; failed: { id: string; name: string }[] }> {
    const active = await this.prisma.kbIngestBatch.count({ where: { userId, status: { in: ['queued', 'running', 'paused'] } } });
    if (active > 0) {
      throw new ConflictException({ code: 'kb_batch_active', message: 'Files are still being added. Wait for them to finish, or cancel them, then switch.' });
    }
    const documents = await this.prisma.ingestedDocument.findMany({ where: { userId } });
    const doomed = documents.filter((document) => document.driveId !== driveId);
    let removed = 0;
    const failed: { id: string; name: string }[] = [];
    for (const document of doomed) {
      try {
        await this.ingestionClient.deleteDocument(document.userId, document.name, document.driveItemId);
        await this.prisma.ingestedDocument.delete({ where: { id: document.id } });
        removed += 1;
      } catch (error) {
        logger.warn(`KB switch: could not remove "${document.name}" (id=${document.id}): ${error instanceof Error ? error.message : String(error)}`);
        failed.push({ id: document.id, name: document.name });
      }
    }
    if (removed > 0) {
      logger.log(`KB library switch: user=${createHash('sha256').update(userId).digest('hex').slice(0, 10)} removed=${removed} failed=${failed.length}`);
      await this.profileScheduler?.schedule(userId);
    }
    return { removed, failed };
  }

  /**
   * Finds (and, unless `dryRun`, removes) KB content the user's document list has no record of: stored chunks whose source id matches no
   * IngestedDocument row, plus chunks that carry no source id at all. Such content is invisible on the KB page, so it can never be
   * deleted there, yet jobs still read it, next to the current copy of the same file. Refused while a batch is still going, like
   * switchDrive. A source that could not be removed is reported and the rest carry on; running it again finishes the job.
   * Content being added by a single upload at this very moment has chunks before its row, so run it when nothing is being added.
   */
  async reconcileOrphans(userId: string, dryRun: boolean): Promise<KbReconcileResult> {
    const active = await this.prisma.kbIngestBatch.count({ where: { userId, status: { in: ['queued', 'running', 'paused'] } } });
    if (active > 0) {
      throw new ConflictException({ code: 'kb_batch_active', message: 'Files are still being added. Wait for them to finish, or cancel them, then clean up.' });
    }
    const [sources, documents] = await Promise.all([
      this.ingestionClient.listKbSources(userId),
      this.prisma.ingestedDocument.findMany({ where: { userId }, select: { driveItemId: true } }),
    ]);
    const known = new Set(documents.map((document) => document.driveItemId));
    const orphans: KbOrphanSource[] = sources
      .filter((source) => source.source_id === null || !known.has(source.source_id))
      .map((source) => ({ sourceId: source.source_id, fileNames: source.source_files, chunks: source.chunks }));
    if (dryRun || orphans.length === 0) {
      return { dryRun, orphans, removed: 0, failed: [] };
    }
    let removed = 0;
    const failed: KbReconcileResult['failed'] = [];
    for (const orphan of orphans) {
      try {
        if (orphan.sourceId === null) {
          await this.ingestionClient.deleteUnattributedKbChunks(userId);
        } else {
          await this.ingestionClient.deleteDocument(userId, orphan.fileNames[0] ?? 'unknown', orphan.sourceId);
        }
        removed += 1;
      } catch (error) {
        logger.warn(`KB cleanup: could not remove ${orphan.sourceId ?? 'content without a source'}: ${error instanceof Error ? error.message : String(error)}`);
        failed.push({ sourceId: orphan.sourceId, fileNames: orphan.fileNames });
      }
    }
    logger.log(`KB cleanup: user=${createHash('sha256').update(userId).digest('hex').slice(0, 10)} removed=${removed} failed=${failed.length}`);
    if (removed > 0) await this.profileScheduler?.schedule(userId);
    return { dryRun, orphans, removed, failed };
  }

  async ingestFolderUrl(
    url: string,
    userId: string,
    docType: string | null,
    recursive = false,
  ): Promise<FolderIngestUrlResult> {
    const graphToken = await this.requireGraphToken(userId);
    const result = await this.ingestionClient.ingestFolderUrl(url, userId, docType, recursive, graphToken);
    const toPersist = result.files.filter((f) => f.status !== 'failed' && f.driveitemId);
    // allSettled: the KB (Chroma) side already succeeded for every file in
    // toPersist, so one file's Prisma upsert rejecting must not throw away
    // the others' already-committed results or mark them failed.
    const settled = await Promise.allSettled(
      toPersist.map((f) =>
        this.prisma.ingestedDocument.upsert({
          where: { userId_driveItemId: { userId, driveItemId: f.driveitemId! } },
          create: {
            userId,
            driveItemId: f.driveitemId!,
            name: f.relativePath ?? f.file,
            sizeBytes: f.sizeBytes ?? 0,
            mimeType: f.mimeType,
            docType,
            chunkCount: f.chunksInStore,
            ...(f.driveId ? { driveId: f.driveId } : {}),
          },
          update: {
            name: f.relativePath ?? f.file,
            sizeBytes: f.sizeBytes ?? 0,
            mimeType: f.mimeType,
            docType,
            chunkCount: f.chunksInStore,
            ...(f.driveId ? { driveId: f.driveId } : {}),
            ingestedAt: new Date(),
          },
        }),
      ),
    );
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        const file = toPersist[i];
        file.status = 'failed';
        file.reason = `KB store succeeded but database persistence failed: ${outcome.reason?.message ?? outcome.reason}`;
        await this.removeChunksIfUnlisted(userId, file.relativePath ?? file.file, file.driveitemId!);
      }
    }
    await this.profileScheduler?.schedule(userId);
    return result;
  }
}
