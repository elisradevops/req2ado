import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

// Fixed row id -- AppSettings is a deliberate singleton (see its own schema
// comment): one global row every logged-in user reads and can edit, not a
// per-user table.
const SETTINGS_ROW_ID = 'singleton';

// Same 0.90 default check_for_duplicates.py itself falls back to when no
// threshold is passed at all -- kept here too so a fresh deployment with no
// AppSettings row yet reads back the exact value it would get if this
// feature didn't exist, rather than some other implicit default.
const DEFAULT_DEDUP_THRESHOLD = 0.9;

export interface AppSettingsView {
  dedupThreshold: number;
  // The embedding model the similarity is measured with. Read-only: set by whoever deploys the system, not by a user.
  embeddingModel?: string;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaClient,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private embeddingModel(): { embeddingModel?: string } {
    const model = this.config?.get<string>('EMBED_MODEL');
    return model ? { embeddingModel: model } : {};
  }

  async get(): Promise<AppSettingsView> {
    const row = await this.prisma.appSettings.findUnique({ where: { id: SETTINGS_ROW_ID } });
    return { dedupThreshold: row?.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD, ...this.embeddingModel() };
  }

  async update(dedupThreshold: number): Promise<AppSettingsView> {
    const row = await this.prisma.appSettings.upsert({
      where: { id: SETTINGS_ROW_ID },
      create: { id: SETTINGS_ROW_ID, dedupThreshold },
      update: { dedupThreshold },
    });
    return { dedupThreshold: row.dedupThreshold, ...this.embeddingModel() };
  }
}
