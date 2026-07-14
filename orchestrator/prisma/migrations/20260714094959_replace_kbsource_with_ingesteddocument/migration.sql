/*
  Warnings:

  - You are about to drop the `KbSource` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "KbSource";

-- CreateTable
CREATE TABLE "IngestedDocument" (
    "id" TEXT NOT NULL,
    "areaPath" TEXT NOT NULL,
    "driveItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mimeType" TEXT,
    "docType" TEXT,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IngestedDocument_areaPath_driveItemId_key" ON "IngestedDocument"("areaPath", "driveItemId");
