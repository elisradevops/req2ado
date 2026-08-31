import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BatchService } from './batch.service';

// Timer separated from logic, same pattern as JobRetentionService/
// StaleJobWatchdogService -- lets specs call BatchService.pumpOnce()
// directly with no fake timers. JobsModule (which this is wired into)
// only ever loads in the orchestrator HTTP process, so there is exactly
// one pump running.
@Injectable()
export class BatchPumpService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle?: NodeJS.Timeout;

  constructor(
    private readonly batchService: BatchService,
    private readonly pumpIntervalMs: number,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.batchService.pumpOnce();
    }, this.pumpIntervalMs);
  }

  onModuleDestroy(): void {
    clearInterval(this.intervalHandle);
  }
}
