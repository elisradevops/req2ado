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
  areaPath: string;
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

  async ingestUrl(url: string, areaPath: string, docType: string | null): Promise<IngestUrlResult> {
    const result = await this.ingestionClient.ingestUrl(url, areaPath, docType);
    await this.prisma.ingestedDocument.upsert({
      where: { areaPath_driveItemId: { areaPath, driveItemId: result.driveitemId } },
      create: {
        areaPath,
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

  async listDocuments(areaPath?: string): Promise<IngestedDocumentSummary[]> {
    return this.prisma.ingestedDocument.findMany({
      where: areaPath ? { areaPath } : {},
      orderBy: { ingestedAt: 'desc' },
    });
  }

  async ingestFolderUrl(url: string, areaPath: string, docType: string | null): Promise<FolderIngestUrlResult> {
    const result = await this.ingestionClient.ingestFolderUrl(url, areaPath, docType);
    // Persist a row for every file that actually landed in the KB
    // (ingested or skipped-unchanged) — mirrors ingestUrl's single-doc
    // persistence. Failed files have no driveitemId and are not persisted.
    await Promise.all(
      result.files
        .filter((f) => f.status !== 'failed' && f.driveitemId)
        .map((f) =>
          this.prisma.ingestedDocument.upsert({
            where: { areaPath_driveItemId: { areaPath, driveItemId: f.driveitemId! } },
            create: {
              areaPath,
              driveItemId: f.driveitemId!,
              name: f.file,
              sizeBytes: f.sizeBytes ?? 0,
              mimeType: f.mimeType,
              docType,
            },
            update: {
              name: f.file,
              sizeBytes: f.sizeBytes ?? 0,
              mimeType: f.mimeType,
              docType,
              ingestedAt: new Date(),
            },
          }),
        ),
    );
    return result;
  }
}
