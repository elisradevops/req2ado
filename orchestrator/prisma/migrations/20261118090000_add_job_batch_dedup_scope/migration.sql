-- AlterTable: B4 batch duplicate scope. Additive only: every existing batch reads as 'area_path', the scope it already ran with
-- (the pump passed none, and a job's own default is 'area_path'). No row is rewritten or deleted.
ALTER TABLE "JobBatch" ADD COLUMN "dedupScope" TEXT NOT NULL DEFAULT 'area_path';
