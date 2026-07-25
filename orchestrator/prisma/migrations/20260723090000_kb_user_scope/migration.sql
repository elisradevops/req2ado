-- AlterTable: Job gains userId (nullable -- historical jobs predate it),
-- the submitting user's stable ADO identity, threaded into ingestion's
-- /level as the Knowledge Base scope key. Kept separate from areaPath,
-- which stays the ADO write-back destination + idempotency key only.
ALTER TABLE "Job" ADD COLUMN "userId" TEXT;

-- IngestedDocument re-scope: areaPath -> userId. Pre-production/test data
-- only (no production KB data exists yet) -- truncate rather than attempt
-- a value migration, since Chroma stores chunks/embeddings keyed by the
-- OLD area-path-derived collection name anyway; a real re-ingest (fetching
-- fresh bytes from SharePoint) is required regardless of any row-level
-- migration here. The old req2ado_kb_<hash(area_path)> Chroma collections
-- are left orphaned -- harmless, never queried under the new user-scoped
-- naming scheme.
TRUNCATE TABLE "IngestedDocument";

DROP INDEX "IngestedDocument_areaPath_driveItemId_key";
ALTER TABLE "IngestedDocument" DROP COLUMN "areaPath";
ALTER TABLE "IngestedDocument" ADD COLUMN "userId" TEXT NOT NULL;
CREATE UNIQUE INDEX "IngestedDocument_userId_driveItemId_key" ON "IngestedDocument"("userId", "driveItemId");
