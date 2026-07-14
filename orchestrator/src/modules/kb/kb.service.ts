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
}
