-- AlterTable: what the rules make of the file, shown on the wizard's rules card (additive, nullable: rulebooks stored earlier have none).
ALTER TABLE "FileRulebook" ADD COLUMN "details" JSONB;
