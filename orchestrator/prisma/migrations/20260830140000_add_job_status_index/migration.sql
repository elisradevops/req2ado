-- Job.status had no covering index at all -- StaleJobWatchdogService.sweep()
-- and JobsService.onModuleInit()'s orphan-reconciliation query both filter
-- on status alone (WHERE status IN (...)) and seq-scanned the whole table.

CREATE INDEX "Job_status_idx" ON "Job"("status");
