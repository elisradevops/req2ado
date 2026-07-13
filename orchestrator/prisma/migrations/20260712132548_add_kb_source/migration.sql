-- CreateTable
CREATE TABLE "KbSource" (
    "id" TEXT NOT NULL,
    "areaPath" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "library" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbSource_pkey" PRIMARY KEY ("id")
);
