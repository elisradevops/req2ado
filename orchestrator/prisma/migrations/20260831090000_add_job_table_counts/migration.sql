-- Job.tableCount/cellCount: doc.tables.length / summed grid size at the
-- same ETA-telemetry write site blockCount/figureCount already use
-- (pipeline.worker.ts) -- lets a table-only-format job (xlsx/csv) train
-- and be estimated against its own real feature instead of a (0,0) sample
-- that pollutes the block/figure regression (see eta.service.ts's new
-- NOT: { blockCount: 0, figureCount: 0 } exclusion and
-- bootstrapMinutesForTables).

ALTER TABLE "Job" ADD COLUMN "tableCount" INTEGER;
ALTER TABLE "Job" ADD COLUMN "cellCount" INTEGER;
