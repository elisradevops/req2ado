-- CreateTable
CREATE TABLE "DedupSkipAudit" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "existingAdoId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DedupSkipAudit_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DedupSkipAudit" ADD CONSTRAINT "DedupSkipAudit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
