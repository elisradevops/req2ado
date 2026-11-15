import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KbIngestBatchService } from './kb-ingest-batch.service';

const logger = new Logger('KbIngestRetention');

// Forgets finished knowledge-base batches after a while, so the ledger does not grow without end. Same shape as
// JobRetentionService (a timer that sweeps; a failed sweep is retried on the next tick). Only the record of the batch goes:
// the documents its files added are untouched. KbModule only loads in the orchestrator HTTP process, so there is one.
@Injectable()
export class KbIngestRetentionService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle?: NodeJS.Timeout;

  constructor(
    private readonly batches: KbIngestBatchService,
    private readonly checkIntervalMs: number,
    private readonly maxAgeMs: number,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      this.sweep().catch((error) => {
        logger.error(`Sweep failed, will retry next interval: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.checkIntervalMs);
  }

  onModuleDestroy(): void {
    clearInterval(this.intervalHandle);
  }

  async sweep(): Promise<void> {
    const removed = await this.batches.deleteFinishedBefore(new Date(Date.now() - this.maxAgeMs));
    if (removed > 0) logger.log(`Forgot ${removed} finished knowledge-base batch(es)`);
  }
}
