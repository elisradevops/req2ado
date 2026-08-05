-- CreateTable
CREATE TABLE "AreaPathBackfill" (
    "areaPath" TEXT NOT NULL,
    "lastBackfilledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaPathBackfill_pkey" PRIMARY KEY ("areaPath")
);
