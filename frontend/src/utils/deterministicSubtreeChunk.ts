// deterministic_subtree's two chunked LLM passes (id_tree_builder.py's
// _apply_synthesis_pass/_apply_title_tag_pass, 150-node chunks) don't carry
// structured chunk-index/chunk-count fields the way score_requirements does
// (chunkIndex/chunkCount) -- only a free-text subtreeLabel, e.g.
// "synthesizing requirement text for 150 node(s) (chunk 1 of 2)" or
// "enhancing titles/tags for 3 node(s) (chunk 2 of 2)". Parsed here rather
// than adding backend fields, since the label format is already stable and
// this is the only place that needs the numbers pulled back out of it.
export interface DeterministicSubtreeChunkInfo {
  chunkIndex: number;
  chunkCount: number;
  passLabel: string;
  // Real count of items THIS chunk is processing (e.g. 150) -- null on the
  // rare label shape that has a chunk marker but no node count (kept
  // optional rather than failing the whole parse over one missing number).
  nodeCount: number | null;
}

const CHUNK_PATTERN = /\(chunk (\d+) of (\d+)\)/;
const NODE_COUNT_PATTERN = /for (\d+) node\(s\)/;

export function parseDeterministicSubtreeChunk(
  subtreeLabel: string | null | undefined,
): DeterministicSubtreeChunkInfo | null {
  if (!subtreeLabel) return null;
  const match = subtreeLabel.match(CHUNK_PATTERN);
  if (!match) return null;
  const chunkIndex = Number(match[1]);
  const chunkCount = Number(match[2]);
  if (!Number.isFinite(chunkIndex) || !Number.isFinite(chunkCount) || chunkCount <= 0) return null;
  const passLabel = subtreeLabel.includes('enhancing titles/tags') ? 'enhancing titles/tags' : 'synthesizing text';
  const nodeCountMatch = subtreeLabel.match(NODE_COUNT_PATTERN);
  const nodeCount = nodeCountMatch ? Number(nodeCountMatch[1]) : null;
  return { chunkIndex, chunkCount, passLabel, nodeCount: nodeCount != null && Number.isFinite(nodeCount) ? nodeCount : null };
}

// _apply_synthesis_pass always runs before _apply_title_tag_pass (see
// id_tree_builder.py's own call order) -- synthesis is pass 1, title/tag is
// pass 2, always, so the pass number is derivable from passLabel alone.
export function formatDeterministicSubtreePassSubLabel(chunk: DeterministicSubtreeChunkInfo): string {
  const passNumber = chunk.passLabel === 'enhancing titles/tags' ? 2 : 1;
  return `pass ${passNumber} of 2 · ${chunk.passLabel}`;
}
