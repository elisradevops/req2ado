import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { FolderChild, IngestionHttpClient, SharePointStatus } from '../pipeline/ingestion-http.client';
import { CredentialVaultService, SHARED_OWNER_KEY } from '../auth/credential-vault.service';

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
  skippedUnchanged: boolean;
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
  ingestedAt: Date;
}

export interface FolderIngestFile {
  file: string;
  status: string;
  chunksStored: number;
  driveitemId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  reason: string | null;
  relativePath: string | null;
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
  // Files only -- Graph's pre-signed download URL, passed straight through
  // from ingestion so a tree row's ingest action can call POST
  // /kb/ingest-item without a share link for this specific file.
  downloadUrl: string | null;
}

@Injectable()
export class KbService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingestionClient: IngestionHttpClient,
    private readonly credentialVault: CredentialVaultService,
  ) {}

  /**
   * The shared SharePoint token, if it's been rotated via
   * POST /kb/sharepoint/reconnect (stored in the vault). Returns null when
   * no one has rotated it yet -- callers fall back to ingestion's own
   * SHAREPOINT_TOKEN/GRAPH_TOKEN env var in that case, unchanged from
   * before this vault path existed.
   */
  private async resolveGraphTokenOverride(): Promise<string | null> {
    const raw = await this.credentialVault.get(SHARED_OWNER_KEY, 'sharepoint_token');
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as VaultedSharePointToken).token;
    } catch {
      return null;
    }
  }

  async getSharePointStatus(): Promise<SharePointStatus> {
    const override = await this.resolveGraphTokenOverride();
    return this.ingestionClient.getSharePointStatus(override);
  }

  /**
   * Validates a candidate token live against Graph before storing anything
   * -- a bad paste must never overwrite a working token. Attribution
   * (rotatedByUserId/rotatedAt) rides inside the encrypted payload itself
   * rather than a separate plaintext column, since the vault only stores
   * one opaque ciphertext blob per ownerKey/kind.
   */
  async reconnectSharePointToken(token: string, rotatedByUserId: string): Promise<SharePointStatus> {
    const status = await this.ingestionClient.getSharePointStatus(token);
    if (status.status !== 'valid') {
      return status;
    }
    const payload: VaultedSharePointToken = { token, rotatedByUserId, rotatedAt: new Date().toISOString() };
    await this.credentialVault.set(SHARED_OWNER_KEY, 'sharepoint_token', JSON.stringify(payload));
    return status;
  }

  async ingestUrl(
    url: string,
    userId: string,
    docType: string | null,
    retrievalMode: string | null = null,
  ): Promise<IngestUrlResult> {
    const graphToken = await this.resolveGraphTokenOverride();
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
      },
      update: {
        name: result.documentName,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
        docType,
        retrievalMode,
        ingestedAt: new Date(),
      },
    });
    return result;
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
    return document;
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
    const graphToken = await this.resolveGraphTokenOverride();
    const children = await this.ingestionClient.browseFolder(url, graphToken);
    return this.withIngestedFlag(children, userId, pathPrefix);
  }

  async browseChildren(driveId: string, itemId: string, userId: string, pathPrefix: string): Promise<BrowseFolderEntry[]> {
    const graphToken = await this.resolveGraphTokenOverride();
    const children = await this.ingestionClient.browseChildren(driveId, itemId, graphToken);
    return this.withIngestedFlag(children, userId, pathPrefix);
  }

  private async withIngestedFlag(children: FolderChild[], userId: string, pathPrefix: string): Promise<BrowseFolderEntry[]> {
    const documents = await this.prisma.ingestedDocument.findMany({
      where: { userId },
      select: { id: true, driveItemId: true },
    });
    // Matched by driveItemId -- the stable Graph drive-item identity, which
    // survives a SharePoint rename/move. Confirmed real bug (fixed here):
    // matching by name/fullName alone meant a renamed/moved file no longer
    // matched its own IngestedDocument row, so the tree showed it as
    // not-yet-ingested and invited a duplicate re-ingest. driveItemId is a
    // required, unique-per-user column (schema.prisma), so every row has
    // one -- no fallback needed.
    const idByDriveItemId = new Map(documents.map((d) => [d.driveItemId, d.id]));
    return children.map((child) => {
      const ingestedDocumentId = !child.isFolder ? (idByDriveItemId.get(child.id) ?? null) : null;
      return {
        ...child,
        alreadyIngested: ingestedDocumentId !== null,
        ingestedDocumentId,
      };
    });
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
  ): Promise<IngestUrlResult & { ingestedDocumentId: string }> {
    const graphToken = await this.resolveGraphTokenOverride();
    const result = await this.ingestionClient.ingestItem(name, itemId, downloadUrl, userId, docType, graphToken, retrievalMode);
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
      },
      update: {
        name: relativePath,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
        docType,
        retrievalMode,
        ingestedAt: new Date(),
      },
    });
    // Returned so the tree row that triggered this can immediately offer a
    // remove action -- IngestUrlResult alone only carries the Graph
    // driveitemId, not the Prisma row's own id that DELETE
    // /kb/documents/:id needs.
    return { ...result, ingestedDocumentId: row.id };
  }

  async ingestFolderUrl(
    url: string,
    userId: string,
    docType: string | null,
    recursive = false,
  ): Promise<FolderIngestUrlResult> {
    const graphToken = await this.resolveGraphTokenOverride();
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
          },
          update: {
            name: f.relativePath ?? f.file,
            sizeBytes: f.sizeBytes ?? 0,
            mimeType: f.mimeType,
            docType,
            ingestedAt: new Date(),
          },
        }),
      ),
    );
    settled.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        const file = toPersist[i];
        file.status = 'failed';
        file.reason = `KB store succeeded but database persistence failed: ${outcome.reason?.message ?? outcome.reason}`;
      }
    });
    return result;
  }
}
