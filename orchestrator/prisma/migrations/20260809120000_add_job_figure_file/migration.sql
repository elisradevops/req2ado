-- CreateTable
CREATE TABLE "JobFigureFile" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "figureId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobFigureFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobFigureFile_jobId_figureId_key" ON "JobFigureFile"("jobId", "figureId");

-- AddForeignKey
ALTER TABLE "JobFigureFile" ADD CONSTRAINT "JobFigureFile_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
