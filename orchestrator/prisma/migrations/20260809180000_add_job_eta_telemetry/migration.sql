-- AlterTable
-- Telemetry for the SURVEY cost estimate (DESIGN.md §11.2.3) -- all five
-- columns nullable, no backfill: historical jobs predate them, and
-- recovering blockCount/figureCount would mean re-parsing every retained
-- source blob for a job history that was already wiped to zero by an
-- account reset before this migration was written. No index added either
-- -- the fit query is capped at 50 rows behind a 60s in-memory cache, and
-- no @@index exists on Job today; adding one here would be the first,
-- unjustified by current volume.
ALTER TABLE "Job" ADD COLUMN "blockCount" INTEGER;
ALTER TABLE "Job" ADD COLUMN "figureCount" INTEGER;
ALTER TABLE "Job" ADD COLUMN "model" TEXT;
ALTER TABLE "Job" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN "diffReadyAt" TIMESTAMP(3);
