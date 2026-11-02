import { Chip } from '../ui/Chip';

// Shared status chip for the KB explorer's list and detail panes. An
// IngestedDocument row only proves an ingest call returned; chunkCount (what
// the vector store held at last ingest) says whether grounding can actually
// use the file. 0 = "No vectors" (re-ingest); null/undefined = unknown (legacy
// row), which keeps the plain status rather than guessing.
export function hasNoVectors(ingested: boolean, chunkCount: number | null | undefined): boolean {
  return ingested && chunkCount === 0;
}

export function KbIngestStatusChip({
  ingested,
  chunkCount,
}: {
  ingested: boolean;
  chunkCount: number | null | undefined;
}): React.ReactElement {
  if (hasNoVectors(ingested, chunkCount)) {
    return (
      <Chip bg="var(--color-warning-soft)" color="var(--color-warning-ink)" className="text-xs font-normal">
        No vectors
      </Chip>
    );
  }
  const label =
    ingested && chunkCount != null && chunkCount > 0
      ? `In knowledge base · ${chunkCount} ${chunkCount === 1 ? 'chunk' : 'chunks'}`
      : ingested
        ? 'In knowledge base'
        : 'Not ingested';
  return (
    <Chip
      bg={ingested ? 'var(--color-ok-soft)' : 'var(--color-surface-alt)'}
      color={ingested ? 'var(--color-ok-ink)' : 'var(--color-ink-3)'}
      className="text-xs font-normal"
    >
      {label}
    </Chip>
  );
}
