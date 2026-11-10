-- IngestedDocument.chunkCount: how many chunks the vector store held for the
-- file at its last ingest. The row alone only proves an ingest call returned;
-- it never proved vectors exist (a skip-unchanged branch even returned 0
-- stored chunks while the row was refreshed). Nullable: existing rows have no
-- recorded count (unknown), and are never back-filled with a guess.

ALTER TABLE "IngestedDocument" ADD COLUMN "chunkCount" INTEGER;
