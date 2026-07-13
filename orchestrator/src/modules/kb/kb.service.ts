import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from '../pipeline/ingestion-http.client';

export interface KbSourceInput {
  areaPath: string;
  siteUrl: string;
  library: string;
  folder: string;
  displayName: string;
}

export interface KbSourceSummary {
  id: string;
  areaPath: string;
  siteUrl: string;
  library: string;
  folder: string;
  displayName: string;
  lastSyncedAt: Date | null;
  createdAt: Date;
}

export interface KbSyncResult {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: { file: string; reason: string }[];
  chunksStored: number;
}

@Injectable()
export class KbService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingestionClient: IngestionHttpClient,
  ) {}

  async create(input: KbSourceInput): Promise<KbSourceSummary> {
    return this.prisma.kbSource.create({ data: input });
  }

  async list(): Promise<KbSourceSummary[]> {
    return this.prisma.kbSource.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async sync(id: string, bearerToken: string): Promise<KbSyncResult | null> {
    const source = await this.prisma.kbSource.findUnique({ where: { id } });
    if (!source) return null;
    const result = await this.ingestionClient.syncKb(source.siteUrl, source.library, source.folder, source.areaPath, id, bearerToken);
    await this.prisma.kbSource.update({ where: { id }, data: { lastSyncedAt: new Date() } });
    return result;
  }
}
