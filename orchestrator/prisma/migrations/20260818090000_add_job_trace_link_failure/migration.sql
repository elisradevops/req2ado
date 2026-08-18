-- CreateTable
CREATE TABLE "JobTraceLinkFailure" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceLocalId" TEXT NOT NULL,
    "sourceAdoId" INTEGER NOT NULL,
    "targetAdoId" INTEGER NOT NULL,
    "referenceName" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobTraceLinkFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobTraceLinkFailure_jobId_sourceAdoId_targetAdoId_reference_key" ON "JobTraceLinkFailure"("jobId", "sourceAdoId", "targetAdoId", "referenceName");

-- AddForeignKey
ALTER TABLE "JobTraceLinkFailure" ADD CONSTRAINT "JobTraceLinkFailure_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
