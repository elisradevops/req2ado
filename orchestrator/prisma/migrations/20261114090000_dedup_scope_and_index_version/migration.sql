-- AlterTable
ALTER TABLE "AreaPathBackfill" ADD COLUMN "indexVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "embedModel" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "dedupScope" TEXT NOT NULL DEFAULT 'area_path';
