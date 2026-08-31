-- Job.diffVersion: optimistic-concurrency guard for the dryRunDiff JSON
-- array (SWEEP.md section 8a, "Lost updates on dryRunDiff"). All five
-- review-tree mutation endpoints in jobs.service.ts were findUnique ->
-- mutate the array in JS -> update({ where: { id } }) with no concurrency
-- check at all, so two clients editing different nodes both read the same
-- array and the later write silently discarded the earlier one -- both
-- callers got a 200. JobsService.mutateDiffVersioned() now guards each
-- write with WHERE diffVersion = <the value it read>, mirroring the atomic
-- status claim confirm() already uses.
--
-- NOT NULL DEFAULT 0 rather than the nullable-for-historical-rows
-- convention every other added Job column uses: a version whose value can
-- be NULL has no meaningful comparison in the guard's WHERE clause, and
-- the default backfills every existing row in this same statement.

ALTER TABLE "Job" ADD COLUMN "diffVersion" INTEGER NOT NULL DEFAULT 0;
