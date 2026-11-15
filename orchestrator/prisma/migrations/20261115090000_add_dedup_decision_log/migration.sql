-- CreateTable
CREATE TABLE "DedupDecisionLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "areaPath" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "candidateTitle" TEXT NOT NULL,
    "candidateText" TEXT NOT NULL,
    "matchedAdoId" INTEGER,
    "matchedText" TEXT,
    "similarity" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION,
    "judgeVerdict" TEXT,
    "decision" TEXT NOT NULL,
    "reviewerOutcome" TEXT,
    "reviewerAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DedupDecisionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DedupDecisionLog_createdAt_idx" ON "DedupDecisionLog"("createdAt");

-- CreateIndex
CREATE INDEX "DedupDecisionLog_jobId_localId_idx" ON "DedupDecisionLog"("jobId", "localId");
