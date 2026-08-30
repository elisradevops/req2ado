-- Job.documentOverview: whole-document synopsis generated in the New Job
-- Wizard's SURVEY-only "Confirm understanding" step, persisted at job
-- creation. Same nullable-JSONB convention as figureDescriptions/warnings.

ALTER TABLE "Job" ADD COLUMN "documentOverview" JSONB;
