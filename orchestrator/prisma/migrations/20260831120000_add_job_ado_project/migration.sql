-- Job.adoProject: the ADO project this job writes into, made explicit
-- instead of derived from areaPath at each call site. The derivation
-- (areaPath.split('\')[0]) is a correct VALUE -- an area path's first
-- segment is always its project -- but several ADO write operations
-- (create work item, upload attachment, discover fields, discover link
-- types, and the api-version-ladder probe hit by every call) never got the
-- derived project threaded to them and kept resolving a server-wide
-- ADO_PROJECT env var instead. On a multi-project deployment this is a
-- real, silent bug: a job could read from its own project (the operations
-- that DID get the derived project) and have its work items CREATED into a
-- different one (the operations that didn't). Reads looking correct is
-- what made this dangerous.
--
-- Nullable for historical rows, matching this model's dominant convention
-- (userId, iterationPath, etc.) -- but backfilled in this same migration
-- from areaPath, since the derivation is safe and exactly reproduces what
-- the old runtime derivation would have produced. A NULL adoProject after
-- this migration should only ever mean a genuinely inconsistent row, not
-- an ordinary historical one; the write path treats it as a hard failure
-- rather than falling back to any global default.

ALTER TABLE "Job" ADD COLUMN "adoProject" TEXT;

UPDATE "Job" SET "adoProject" = split_part("areaPath", '\', 1) WHERE "adoProject" IS NULL;

-- JobBatch.adoProject: same reasoning, same backfill, for batch (NEW-05)
-- submissions -- BatchPumpService.pumpOnce() creates one Job per queued
-- file from a JobBatch row, and that Job's own adoProject must come from
-- somewhere real rather than falling back to a derivation at pump time.
ALTER TABLE "JobBatch" ADD COLUMN "adoProject" TEXT;

UPDATE "JobBatch" SET "adoProject" = split_part("areaPath", '\', 1) WHERE "adoProject" IS NULL;
