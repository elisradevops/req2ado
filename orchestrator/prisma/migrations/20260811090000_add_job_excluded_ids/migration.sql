-- AlterTable
-- Doc-wide figure/table ids the mapping stage (Part B) judged decorative/
-- irrelevant or that failed mapping (WorkItemTree.excluded_figure_ids/
-- excluded_table_ids) -- nullable, same convention as warnings/
-- figureDescriptions (no backfill for historical jobs).
ALTER TABLE "Job" ADD COLUMN "excludedFigureIds" JSONB;
ALTER TABLE "Job" ADD COLUMN "excludedTableIds" JSONB;
