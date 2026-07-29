-- Backfill legacy jobs (userId IS NULL, predating Job.userId's introduction)
-- onto the single real user this pre-production deployment has been run
-- under, so they don't become invisible once GET /jobs starts filtering by
-- session userId. One-time data fix, not a schema change.
UPDATE "Job"
SET "userId" = 'Microsoft.IdentityModel.Claims.ClaimsIdentity;4a2625ff-24b9-42a0-b572-54c888d73535\eden@korentec.co.il'
WHERE "userId" IS NULL;
