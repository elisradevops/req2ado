# P2b — RAG-first retrieval-injection design

## Goal

Ground SURVEY mode's two whole-document LLM calls (`infer_hierarchy`,
`generate_requirements_for_document`) with relevant KB material when it
exists, falling back cleanly to the model's baseline knowledge when it
doesn't. The KB ingest path (P2a + folder-crawl + recursive) already
populates a per-area-path Chroma collection (`req2ado_kb_<hash>`) with
chunk text + embeddings; nothing reads from it yet. This phase wires the
read side in. Chat-based retrieval (mentioned in the roadmap) is out of
scope — no chat feature exists yet.

## Scope

- `infer_hierarchy` and `generate_requirements_for_document` (both on
  `OrchestratorLlmClient` / the `LlmLevelingClient` and
  `BatchedRequirementClient` Protocols) gain optional KB-context
  injection.
- One retrieval per document, not per node/block — matches the existing
  "whole-doc, not per-node" batching philosophy that
  `generate_requirements_for_document` was already built around (avoiding
  N sequential round-trips).
- No doc_type filtering. Query the whole area_path KB collection
  regardless of doc_type (which is sparse/optional metadata to begin
  with).
- BASELINE mode is untouched — it has no LLM calls today and this phase
  doesn't add any.

## Components

### `KbVectorStore.query` (new method, `app/kb/kb_vector_store.py`)

```python
def query(self, area_path: str, embedding: list[float], top_k: int) -> list[dict]:
    """Returns up to top_k nearest chunks for this area_path's KB
    collection, each as {text, distance, source_file}. distance is
    chromadb's cosine distance (lower = closer); callers apply their own
    similarity cutoff. Empty list if the collection has no chunks."""
```

Implemented via `collection.query(query_embeddings=[embedding], n_results=top_k)`,
mapping chromadb's parallel-array result shape (`documents`, `distances`,
`metadatas`) into the returned list of dicts.

### `retrieve_context` (new module, `app/kb/retrieval.py`)

```python
def retrieve_context(
    area_path: str,
    query_text: str,
    embed_client: EmbedClient,
    vector_store: KbVectorStore,
    top_k: int = 5,
    max_distance: float = 0.7,  # cosine similarity >= 0.3
) -> str | None:
    """Embeds query_text, queries the KB collection for area_path, keeps
    hits with distance <= max_distance, and joins their text with a
    blank-line separator. Returns None when the collection is empty, no
    hit clears the similarity bar, or the embed/query call itself raises
    (network failure, Chroma error) — KB retrieval is an enhancement, not
    a hard dependency, and must never fail or block a SURVEY job. Any
    exception is caught and logged as a warning inside this function; it
    is the single seam that makes KB failure non-fatal for callers."""
```

### `llm_leveling.build_survey_tree` (signature change)

Gains a required `area_path: str` parameter (the one non-additive
signature change in this phase — existing callers/tests must be updated).
Calls `retrieve_context` once using the outline text already built for
`infer_hierarchy`, and threads the resulting `kb_context: str | None` into
both `llm_client.infer_hierarchy(outline, profile_hint=None, kb_context=...)`
and `requirement_client.generate_requirements_for_document(blocks_by_node_id, kb_context=...)`.

The `LlmLevelingClient` and `BatchedRequirementClient` Protocols both gain
the new `kb_context: str | None` parameter on their single method.

### `OrchestratorLlmClient` (prompt construction)

`infer_hierarchy` and `generate_requirements_for_document` each gain
`kb_context: str | None = None`. When not `None`, it's prepended to the
existing system prompt as:

```
Reference material from the knowledge base (may be incomplete or
irrelevant — use only what's genuinely helpful):

{kb_context}

```

followed by the existing system prompt text unchanged. When `None`, the
system prompt is byte-identical to today's — no behavior change for
area paths with no KB material.

### `main.py` wiring

The `/level` route already receives `body.area_path` (used elsewhere) but
today's `build_survey_tree(doc, llm_client=client, requirement_client=client)`
call doesn't thread it through. This becomes
`build_survey_tree(doc, llm_client=client, requirement_client=client, area_path=body.area_path)`,
and `build_survey_tree` internally constructs its `retrieve_context` call
using the existing module-level `_embed_client` / `_kb_vector_store`
singletons (passed in as new parameters, following the same
dependency-injection pattern already used for `llm_client`/
`requirement_client`).

## Error handling

- Embed failure, Chroma query failure, empty collection, or
  all-hits-below-threshold: all collapse to `kb_context=None`. No
  exception ever propagates out of `retrieve_context`.
- A SURVEY job with a KB outage behaves exactly as it does today
  (baseline-only formalization) — retrieval is additive, never a new
  failure mode.

## Testing

- `KbVectorStore.query`: top-k ordering, distance values surfaced,
  empty-collection returns `[]`.
- `retrieve_context`: happy path (hits above/below threshold mixed),
  empty collection → `None`, embed-client-raises → `None` + warning
  logged, query-raises → `None` + warning logged.
- `build_survey_tree`: KB context threaded into both LLM client calls
  when present; `area_path` is now a required param (update existing
  tests' call sites).
- `OrchestratorLlmClient`: prompt-construction tests — `kb_context`
  prepended verbatim when present, prompt byte-identical to current
  behavior when `None`.

## Out of scope (future phases)

- Chat-based retrieval (no chat feature exists).
- doc_type-filtered retrieval.
- Per-node/per-block retrieval granularity.
- P2c (RAG-grounded quality scoring), P2d (learning-loop write-back).
