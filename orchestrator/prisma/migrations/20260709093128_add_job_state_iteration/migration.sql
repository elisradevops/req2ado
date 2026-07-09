-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "iterationPath" TEXT,
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'Proposed';
