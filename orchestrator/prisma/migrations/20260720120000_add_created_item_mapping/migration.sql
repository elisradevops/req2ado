-- CreateTable
CREATE TABLE "CreatedItemMapping" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "adoWorkItemId" INTEGER NOT NULL,
    "linked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatedItemMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatedItemMapping_jobId_localId_key" ON "CreatedItemMapping"("jobId", "localId");

-- AddForeignKey
ALTER TABLE "CreatedItemMapping" ADD CONSTRAINT "CreatedItemMapping_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
