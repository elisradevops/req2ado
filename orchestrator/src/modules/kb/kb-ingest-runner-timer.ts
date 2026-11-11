import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KbIngestRunner } from './kb-ingest-runner';

const logger = new Logger('KbIngestRunnerTimer');

// Timer separated from logic, same pattern as BatchPumpService: specs call KbIngestRunner directly with no fake timers. KbModule
// only loads in the orchestrator HTTP process, so there is exactly one runner.
@Injectable()
export class KbIngestRunnerTimer implements OnModuleInit, OnModuleDestroy {
  private intervalHandle?: NodeJS.Timeout;

  constructor(
    private readonly runner: KbIngestRunner,
    private readonly tickMs: number,
  ) {}

  async onModuleInit(): Promise<void> {
    // Whatever was running when the process last stopped is not running now. A failure here must not keep the runner from
    // starting: the lease would still bring those files back, just later.
    try {
      await this.runner.recoverOrphans();
    } catch (error) {
      logger.error(`Could not recover interrupted knowledge-base files: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.intervalHandle = setInterval(() => {
      void this.runner.run();
    }, this.tickMs);
  }

  onModuleDestroy(): void {
    // Not waiting for a file in flight (it can take many minutes): the next start puts it back in the queue.
    clearInterval(this.intervalHandle);
  }
}
