-- AlterTable: W1 content-aware identity. Additive only: contentHash is nullable and identityVersion defaults to 1, so every existing
-- row is kept as it is (a version-1 row with no content hash) and keeps matching exactly as before. No row is rewritten or deleted.
ALTER TABLE "IdempotencyMapping" ADD COLUMN "contentHash" TEXT,
ADD COLUMN "identityVersion" INTEGER NOT NULL DEFAULT 1;
