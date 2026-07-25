import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from '../pipeline/ingestion-http.client';

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

@Injectable()
export class KbService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingestionClient: IngestionHttpClient,
  ) {}

  async ingestUrl(url: string, userId: string, docType: string | null): Promise<IngestUrlResult> {
    const result = await this.ingestionClient.ingestUrl(url, userId, docType);
    await this.prisma.ingestedDocument.upsert({
      where: { userId_driveItemId: { userId, driveItemId: result.driveitemId } },
      create: {
        userId,
        driveItemId: result.driveitemId,
        name: result.documentName,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
        docType,
      },
      update: {
        name: result.documentName,
        sizeBytes: result.sizeBytes,
        mimeType: result.mimeType,
        docType,
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

  async ingestFolderUrl(
    url: string,
    userId: string,
    docType: string | null,
    recursive = false,
  ): Promise<FolderIngestUrlResult> {
    const result = await this.ingestionClient.ingestFolderUrl(url, userId, docType, recursive);
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
