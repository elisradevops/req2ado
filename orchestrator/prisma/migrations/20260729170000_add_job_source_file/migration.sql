-- CreateTable
CREATE TABLE "JobSourceFile" (
    "jobId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobSourceFile_pkey" PRIMARY KEY ("jobId")
);

-- AddForeignKey
ALTER TABLE "JobSourceFile" ADD CONSTRAINT "JobSourceFile_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
