import { Injectable } from '@nestjs/common';
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
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(): Promise<AppSettingsView> {
    const row = await this.prisma.appSettings.findUnique({ where: { id: SETTINGS_ROW_ID } });
    return { dedupThreshold: row?.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD };
  }

  async update(dedupThreshold: number): Promise<AppSettingsView> {
    const row = await this.prisma.appSettings.upsert({
      where: { id: SETTINGS_ROW_ID },
      create: { id: SETTINGS_ROW_ID, dedupThreshold },
      update: { dedupThreshold },
    });
    return { dedupThreshold: row.dedupThreshold };
  }
}
