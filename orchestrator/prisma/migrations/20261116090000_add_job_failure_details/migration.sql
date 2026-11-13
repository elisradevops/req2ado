-- AlterTable: why a failed job failed. All nullable, so existing rows (and jobs that failed before this) are untouched.
ALTER TABLE "Job" ADD COLUMN "failedStage" TEXT,
ADD COLUMN "failureClass" TEXT,
ADD COLUMN "failureMessage" TEXT;
