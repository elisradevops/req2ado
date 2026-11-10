-- Job.kbCoverage: {filesAvailable, filesCited} reported by ingestion's
-- WorkItemTree.kb_coverage -- how many KB files a SURVEY run could use vs.
-- cited. Nullable: BASELINE / no-KB runs and every existing row have no
-- value (unknown), and are never back-filled with a guess.

ALTER TABLE "Job" ADD COLUMN "kbCoverage" JSONB;
