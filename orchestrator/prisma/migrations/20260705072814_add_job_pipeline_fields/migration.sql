/*
  Warnings:

  - Added the required column `areaPath` to the `Job` table without a default value. This is not possible if the table is not empty.
  - Added the required column `originalFilename` to the `Job` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "areaPath" TEXT NOT NULL,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "dryRunDiff" JSONB,
ADD COLUMN     "originalFilename" TEXT NOT NULL;
