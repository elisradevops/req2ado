-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "kbCitations" TEXT[] DEFAULT ARRAY[]::TEXT[];
