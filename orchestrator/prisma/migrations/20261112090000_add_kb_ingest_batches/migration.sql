-- CreateTable
CREATE TABLE "KbIngestBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "driveId" TEXT NOT NULL,
    "folderItemId" TEXT,
    "folderPath" TEXT NOT NULL,
    "docType" TEXT,
    "status" TEXT NOT NULL,
    "pauseReason" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "profileScheduledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "KbIngestBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbIngestBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "driveId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "retrievalMode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "errorKind" TEXT,
    "reason" TEXT,
    "chunksStored" INTEGER,
    "chunksInStore" INTEGER,
    "ingestedDocumentId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "KbIngestBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KbIngestBatch_userId_createdAt_idx" ON "KbIngestBatch"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "KbIngestBatch_status_idx" ON "KbIngestBatch"("status");

-- CreateIndex
CREATE INDEX "KbIngestBatchItem_state_nextAttemptAt_idx" ON "KbIngestBatchItem"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "KbIngestBatchItem_batchId_ordinal_idx" ON "KbIngestBatchItem"("batchId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "KbIngestBatchItem_batchId_itemId_key" ON "KbIngestBatchItem"("batchId", "itemId");

-- AddForeignKey
ALTER TABLE "KbIngestBatchItem" ADD CONSTRAINT "KbIngestBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "KbIngestBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
