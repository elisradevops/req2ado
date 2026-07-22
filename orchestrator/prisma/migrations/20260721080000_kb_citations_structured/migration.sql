-- Widen kbCitations from a bare filename array to structured
-- {sourceFile, similarity, relevance}[] objects. Existing rows' old-shape
-- values (bare filenames) are not representable in the new shape and are
-- reset to empty -- this is dev-only data with no production write path
-- yet, and a job's dry-run diff (the actual reviewable artifact) is
-- unaffected either way.
ALTER TABLE "Job" ALTER COLUMN "kbCitations" DROP DEFAULT;
ALTER TABLE "Job" ALTER COLUMN "kbCitations" TYPE JSONB USING '[]'::jsonb;
ALTER TABLE "Job" ALTER COLUMN "kbCitations" SET DEFAULT '[]'::jsonb;
