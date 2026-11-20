-- AlterTable: the rulebook a job was built from (additive, nullable: older jobs have none).
ALTER TABLE "Job" ADD COLUMN "fileRulebook" JSONB,
ADD COLUMN "fileRulebookHash" TEXT;

-- CreateTable: how a file states its structure, per user and file. Additive only: a new table, nothing existing is touched.
CREATE TABLE "FileRulebook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "prestudyVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rulebook" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileRulebook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileRulebook_userId_fileSha256_idx" ON "FileRulebook"("userId", "fileSha256");
