-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "batchId" TEXT;

-- CreateTable
CREATE TABLE "JobBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "areaPath" TEXT NOT NULL,
    "customerId" TEXT,
    "mode" TEXT NOT NULL,
    "state" TEXT,
    "iterationPath" TEXT,
    "model" TEXT,
    "followUp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobBatchFile" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "jobId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobBatchFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobBatchFileBlob" (
    "batchFileId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobBatchFileBlob_pkey" PRIMARY KEY ("batchFileId")
);

-- CreateIndex
CREATE INDEX "JobBatchFile_batchId_ordinal_idx" ON "JobBatchFile"("batchId", "ordinal");

-- CreateIndex
CREATE INDEX "JobBatchFile_status_createdAt_idx" ON "JobBatchFile"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Job_batchId_idx" ON "Job"("batchId");

-- AddForeignKey
ALTER TABLE "JobBatchFile" ADD CONSTRAINT "JobBatchFile_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "JobBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobBatchFileBlob" ADD CONSTRAINT "JobBatchFileBlob_batchFileId_fkey" FOREIGN KEY ("batchFileId") REFERENCES "JobBatchFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

