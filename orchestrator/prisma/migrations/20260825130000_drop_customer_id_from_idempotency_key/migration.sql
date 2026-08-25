-- Customer ID no longer has any job/document-level meaning -- it's now a
-- per-Requirement, document-derived attribute (see
-- ingestion/app/leveling/id_hierarchy.py, WorkItemNode.customer_id), never
-- a per-job/per-document value. Tighten IdempotencyMapping's key from
-- (sourceHash, customerId, areaPath) to (sourceHash, areaPath) to match.
--
-- Explicit, accepted tradeoff: two different customers who previously
-- submitted byte-identical content to the same area path under different
-- customerId values had two separate mapping rows; after this migration
-- they collapse to one, and re-ingesting either document going forward
-- reuses the single surviving ADO item rather than creating a duplicate.
-- customerId itself is left in place on the table (unused, legacy/
-- historical) -- no destructive DROP COLUMN.

-- Dedupe first: the new unique index cannot be created while a
-- (sourceHash, areaPath) pair has more than one row. Keeps an arbitrary
-- one per pair (deterministic by id) and drops the rest.
DELETE FROM "IdempotencyMapping" a
USING "IdempotencyMapping" b
WHERE a.id > b.id
  AND a."sourceHash" = b."sourceHash"
  AND a."areaPath" = b."areaPath";

DROP INDEX IF EXISTS "IdempotencyMapping_sourceHash_customerId_areaPath_key";

CREATE UNIQUE INDEX "IdempotencyMapping_sourceHash_areaPath_key" ON "IdempotencyMapping"("sourceHash", "areaPath");
