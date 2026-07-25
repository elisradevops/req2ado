from __future__ import annotations

import hashlib
import logging
import re
from typing import Callable, NamedTuple, Protocol

from app.canonical.model import Block, BlockKind, CanonicalDoc, Figure, Table
from app.distillation.title import extract_baseline_title
from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import retrieve_context
from app.leveling.depth import resolve_block_depth
from app.leveling.narration_publisher import LevelingProgress, Phase, ProgressCallback
from app.leveling.profiles import LevelingProfile
from app.leveling.tree_builder import _bound_branch_size, _split_into_branches
from app.quality.criteria_retrieval import CriteriaRetriever
from app.workitem.model import (
    KbCitation,
    KbCitationRelevance,
    RequirementQualityIssue,
    RequirementTag,
    TraceLink,
    TraceLinkResolutionStatus,
    TraceLinkTargetKind,
    WorkItemMode,
    WorkItemNode,
    WorkItemTree,
    WorkItemType,
)

logger = logging.getLogger(__name__)

# Fraction of a candidate-dropped block's own significant vocabulary that
# must appear somewhere in the generated output (any node, not just an
# adjacent one) before it's considered "merged into another node's text"
# rather than genuinely dropped. Deliberately low, same rationale as
# _LOW_GROUNDING_THRESHOLD: a legitimate merge/paraphrase can reuse a
# minority of the block's exact words while still incorporating its
# content -- this only needs to rule out "no trace at all".
_BLOCK_COVERAGE_OVERLAP_THRESHOLD = 0.3

# grounding_score below this is flagged in warnings -- deliberately low: a
# legitimate formalization/paraphrase of a source sentence into "shall"
# language can genuinely reuse a minority of the source's exact words while
# still being fully grounded (different phrasing, added standard terms like
# "shall"/"the system"). This is a coarse hallucination SIGNAL for a human
# reviewer, not a hard quality gate -- it does not fail or drop anything.
_LOW_GROUNDING_THRESHOLD = 0.2
# Ceiling on how many blocks a single SURVEY branch's infer_hierarchy/
# generate_requirements_for_document calls are ever handed at once. Real
# documents can have very few, wildly unbalanced top-level sections
# (observed live: an ICD with only 4 top-level sections, one 372 blocks) --
# _split_into_branches's document-structure-driven split alone cannot
# guarantee a small branch; _bound_branch_size enforces this ceiling
# directly regardless of the document's actual heading structure. Not a
# precisely-tuned token budget -- a conservative block-count proxy for "this
# branch is small enough that one more level of recursive splitting isn't
# needed".
#
# Originally 60, chosen deliberately small to avoid the per-call timeout
# that motivated this whole mechanism. Live testing against the same 679
# block ICD showed the real bottleneck is the OPPOSITE problem: at 60, the
# document's own fine-grained numbering recursively split down to 152
# branches (avg ~4.5 blocks each), and 2-4 sequential LLM calls per branch
# (~300-600 total, strictly one-at-a-time) made total /level wall time
# dominated by fixed per-call overhead, not model inference time -- pasting
# the WHOLE document into a chat UI in one shot was fast precisely because
# it's one call, not many. Raised to 200: modern local models here run with
# 32k+ context, comfortably fitting a 200-block branch's prompt+response, so
# this still guards against genuine context overflow on an unbounded branch
# while cutting round-trip count roughly in proportion (this same document
# now produces a handful of branches instead of 152).
_MAX_SURVEY_BRANCH_BLOCK_COUNT = 200

# Coverage-safe chunk budget for local models (see _ModelCaps.coverage_budget_tokens's
# own docstring for why this is much smaller than a model's real context window). The
# lost-in-the-middle recall trough sets in well before a context window fills; ~8-12k
# tokens is large enough that a chunk still spans several adjacent headings (preserving
# local cross-section reasoning) while staying off the trough. This is the PRIMARY
# TUNABLE for coverage quality -- too high under-chunks (the under-synthesis bug
# persists), too low over-fragments (node inflation, more sequential calls). 10k is a
# defensible starting midpoint; settle empirically against a real long document's
# node-count/coverage-warning delta.
_COVERAGE_BUDGET_TOKENS = 10_000


class _ModelCaps(NamedTuple):
    branch_cap: int              # _bound_branch_size's oversized-branch safety net (unchanged role)
    context_budget_tokens: int   # true context-window ceiling -- documented for future overflow-guarding/
                                  # num_ctx alignment, but NOT what drives chunking control flow (see
                                  # coverage_budget_tokens)
    coverage_budget_tokens: int  # drives the whole-doc single-call gate + budget-merge splitter. Deliberately
                                  # much smaller than context_budget_tokens for local models: confirmed live
                                  # that a document comfortably fitting the context window still under-
                                  # synthesizes when analyzed in one holistic call (lost-in-the-middle
                                  # positional bias, arXiv 2410.23609 -- an attention-architecture property
                                  # that degrades middle-of-input recall well before the context window
                                  # fills, so "fits in context" must NOT be treated as "safe to analyze in
                                  # one pass"). Equal to context_budget_tokens for frontier models -- the
                                  # reported under-synthesis is local-model-only so far; revisit if frontier
                                  # models show the same symptom.
    supports_tools: bool


# Per-model branch-size cap, context-token budget, and tool-calling capability
# (§5c's gate). Local Ollama models confirmed live via /api/show's own
# "capabilities" field this session -- both are tools-capable so far; the
# conservative supports_tools=False default below is for any UNKNOWN model, so
# it safely falls back to the pre-computed once-per-document KB path rather
# than sending a `tools` payload a model may not understand.
#
# context_budget_tokens: gemma4:e4b/qwen3:4b support 128k/32k context
# ARCHITECTURALLY, but Ollama's actual runtime window only reaches that far
# once num_ctx is explicitly raised for the request (see the numCtx threading
# in orchestrator/src/modules/llm/) -- these budgets assume that's done;
# otherwise Ollama truncates regardless of what this module sends.
_MODEL_CAPS: dict[str, _ModelCaps] = {
    "qwen3:4b": _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 28_000, _COVERAGE_BUDGET_TOKENS, True),
    "gemma4:e4b": _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 90_000, _COVERAGE_BUDGET_TOKENS, True),
    "gpt-5.5": _ModelCaps(100_000, 150_000, 150_000, True),
}


def _resolve_caps(model: str | None) -> _ModelCaps:
    """Resolves a model name to its branch-size cap, context-token budget, and
    tool-calling support. Frontier models (production target, see
    build_survey_tree's docstring) get much larger caps/budgets since they run
    huge context windows; an unknown model conservatively gets the small
    local-model cap/budget and supports_tools=False."""
    if model and model in _MODEL_CAPS:
        return _MODEL_CAPS[model]
    if model and model.startswith(("claude-opus", "gpt-5")):
        return _ModelCaps(100_000, 150_000, 150_000, True)
    return _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 28_000, _COVERAGE_BUDGET_TOKENS, False)


# Reserved out of coverage_budget_tokens for the KB context, system prompt,
# and the model's own output -- the whole-document gate (§3) and budget-merge
# splitter (§4) compare rendered TEXT size against (coverage_budget_tokens -
# this headroom), not the raw budget, so there's real room left for the rest
# of the payload.
_WHOLE_DOC_HEADROOM_TOKENS = 4_000

# Cheap chars/4 heuristic -- good enough for a budget GATE (deciding whether
# to skip splitting or how many blocks a merged branch can hold), not exact
# token accounting. Avoids a new tokenizer dependency; consistent with this
# module's other block-count-proxy conventions (see
# _MAX_SURVEY_BRANCH_BLOCK_COUNT's own docstring).
_CHARS_PER_TOKEN_ESTIMATE = 4


def _estimate_tokens(text: str) -> int:
    return len(text) // _CHARS_PER_TOKEN_ESTIMATE


def _merge_branches_by_budget(branches: list[list[Block]], budget_tokens: int) -> list[list[Block]]:
    """§4: structure-aware budget-merge for the doesn't-fit-in-one-call
    fallback path. _split_into_branches (tree_builder.py, shared with
    BASELINE mode -- deliberately left untouched, see its own docstring)
    splits on every occurrence of the document's shallowest heading/
    numbering depth. That's correct as a never-split-mid-section structural
    primitive, but produces one branch per heading regardless of how small
    each section actually is -- the AirPro document has ~79 depth-2 headings
    and no depth-1 ones at all, so every single heading became its own
    isolated branch, each analyzed with zero awareness of its neighbors.

    Greedily merges ADJACENT branches (preserving document order -- a
    section is never split apart, only whole sections joined together) into
    the current running branch until the NEXT branch would push the merged
    rendered text over budget_tokens; only then closes the current branch
    and starts a fresh one. Collapses many small sections into a handful of
    budget-sized branches instead of one per heading. Token cost is tracked
    via a running sum of each branch's OWN _estimate_tokens(render_section(..))
    rather than re-rendering the full merged buffer on every step -- O(n)
    instead of O(n^2); a good-enough approximation for a budget gate, not
    exact accounting (see _CHARS_PER_TOKEN_ESTIMATE's own docstring).

    _bound_branch_size still runs AFTER this (unchanged) as the safety net
    for any single section that alone exceeds the model's block-count cap,
    regardless of how small its token footprint is."""
    if not branches:
        return branches
    merged: list[list[Block]] = []
    current: list[Block] = list(branches[0])
    current_tokens = _estimate_tokens(render_section(current, None, None))
    for branch in branches[1:]:
        branch_tokens = _estimate_tokens(render_section(branch, None, None))
        if current_tokens + branch_tokens <= budget_tokens:
            current.extend(branch)
            current_tokens += branch_tokens
        else:
            merged.append(current)
            current = list(branch)
            current_tokens = branch_tokens
    merged.append(current)
    return merged


# Common connective/requirement-boilerplate words excluded from the overlap
# calculation so they don't inflate the score for genuinely unrelated
# content that merely happens to also be phrased as a "shall" statement.
_GROUNDING_STOPWORDS = {
    "a", "an", "the", "shall", "system", "is", "are", "of", "to", "and", "or",
    "in", "on", "for", "with", "be", "will", "this", "that", "it", "its",
}
_WORD_PATTERN = re.compile(r"[a-z0-9]+")


def _significant_words(text: str) -> set[str]:
    return {word for word in _WORD_PATTERN.findall(text.lower()) if word not in _GROUNDING_STOPWORDS}


def _grounding_score(generated_text: str, source_text: str) -> float:
    """Fraction of the generated text's own significant vocabulary that
    also appears in its source block's text -- precision, not similarity:
    a generated description using mostly words absent from the source
    (invented/unrelated content) scores low regardless of the source's own
    length. 1.0 when the generated text has no significant words at all
    (nothing to be ungrounded about) or when every significant word is
    present in the source."""
    generated_words = _significant_words(generated_text)
    if not generated_words:
        return 1.0
    source_words = _significant_words(source_text)
    return len(generated_words & source_words) / len(generated_words)


def _block_content_appears_in_generated_output(block_text: str, all_generated_texts: list[str]) -> bool:
    """True if the block's own significant vocabulary meaningfully overlaps
    with the generated output taken as a WHOLE (every node's text, not just
    one) -- a block whose node_id the LLM never referenced in `hierarchy`
    can still have had its content folded into a DIFFERENT node's formalized
    text (a legitimate merge), which per-node lookups can't detect. Trivially
    True for a block with no significant words at all (nothing to lose)."""
    block_words = _significant_words(block_text)
    if not block_words:
        return True
    combined_words = _significant_words(" ".join(all_generated_texts))
    overlap = len(block_words & combined_words) / len(block_words)
    return overlap >= _BLOCK_COVERAGE_OVERLAP_THRESHOLD


class LlmLevelingClient(Protocol):
    """Interface for SURVEY-mode hierarchy inference. No real implementation
    exists in this phase — the orchestrator's LLM proxy/redaction client
    (which would host the actual Open WebUI call) is separate, not-yet-built
    infrastructure. This Protocol lets tests and future callers inject any
    conforming client. Matches the runtime prompt contract documented in
    docs/architecture.md: strict JSON {node_id,type,parent_id}[].
    `kb_context` (see app.kb.retrieval.retrieve_context) is optional
    SharePoint/OneDrive-sourced reference material -- omitted (None) is
    byte-identical to before KB grounding existed."""

    def infer_hierarchy(
        self, outline: str, profile_hint: LevelingProfile | None, kb_context: str | None = None
    ) -> list[dict]: ...


class BatchedRequirementClient(Protocol):
    """Interface for whole-document SURVEY requirement generation — one call
    covering every node, not one call per node (see
    OrchestratorLlmClient.generate_requirements_for_document's docstring for
    why: a per-node design made ~101 sequential LLM calls for a 50-block
    document). Deliberately narrower than SurveyRequirementClient (which is
    still used by build_survey_requirements.py for its own single-block
    callers, untouched by this phase) — this Protocol's single method takes
    ALL blocks at once."""

    def generate_requirements_for_document(
        self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, list[dict]]: ...


class BatchedScoringClient(Protocol):
    """Interface for whole-document (or whole-branch) SURVEY quality
    scoring — one call judging every node's FINAL formalized description
    against EARS/INCOSE/ISO/IEC/IEEE-29148 criteria, not one call per node.
    Fully optional in build_survey_tree (a None scoring_client, the
    default, means no scoring at all — byte-identical to before this
    capability existed).

    `criteria_context` is optional retrieval-grounded reference material
    (see app.quality.criteria_retrieval.CriteriaRetriever) -- when supplied,
    a real implementation should cite it in the judgment instead of relying
    solely on the model's own parametric knowledge of the public standards.
    `kb_context` is the SAME SharePoint/OneDrive KB context already computed
    for infer_hierarchy/generate_requirements_for_document, threaded through
    for consistency across all three calls. Both grounding params are
    independent and orthogonal -- one grounds against customer content, the
    other against quality-criteria reference material -- and either or both
    may be omitted (None), byte-identical to before either capability
    existed."""

    def score_requirements_for_document(
        self,
        descriptions_by_node_id: dict[str, str],
        criteria_context: str | None = None,
        kb_context: str | None = None,
    ) -> dict[str, dict]: ...


class TraceLinkInferenceClient(Protocol):
    """Interface for SURVEY-mode trace/coverage link inference — one call
    covering every node ACROSS THE WHOLE TREE (all branches combined, not
    per-branch — a trace/coverage link can legitimately point from one
    branch's node to another's), mirroring BatchedRequirementClient's
    one-call-per-document rationale. Given the full node list and a
    discovered ADO link-type catalog, proposes zero or more links; anything
    the model returns with a reference_name outside the supplied catalog is
    dropped by build_survey_tree, never trusted blind."""

    def infer_trace_links(
        self, nodes: list[dict], link_type_catalog: list[dict], kb_context: str | None = None
    ) -> list[dict]: ...


class KbRelevanceClient(Protocol):
    """Interface for verifying whether KB snippets OFFERED to a branch
    (see app.kb.retrieval.retrieve_context) were actually relevant to it --
    passing the retrieval similarity cutoff and being pasted into a prompt
    is not proof the model found a snippet relevant, only that it was
    provided (see OrchestratorLlmClient.judge_kb_relevance's docstring).
    Entirely optional (default None, same opt-in-capability convention as
    scoring_client/criteria_retriever) -- when omitted, every KbCitation's
    relevance stays at its default (KbCitationRelevance.UNKNOWN), matching
    pre-verification behavior exactly."""

    def judge_kb_relevance(self, branch_content: str, snippets: list[dict]) -> dict[str, str]: ...


class SectionAnalysisClient(Protocol):
    """Interface for the holistic SURVEY redesign's one-call-per-branch
    analysis, replacing the LlmLevelingClient + BatchedRequirementClient pair
    above (kept, unchanged, for any caller not yet migrated). Given ONE
    coherent, structure-preserving rendering of a whole section (see
    render_section), returns the COMPLETE node set the model decides the
    section contains -- however many, not one per input block.

    `analyze_section` is the fallback path for models without tool-calling
    support: `kb_context` is a pre-computed once-per-document string (see
    §5c's capability gate in _build_survey_tree_for_branch).

    `analyze_section_agentic` is the tool-capable path: the model actively
    pulls KB context via a query_kb tool call during analysis instead of a
    pre-computed kb_context. `retrieve_fn` is injected by the caller (closing
    over user_id/embed_client/vector_store -> retrieve_context) so this
    Protocol/its real implementation stays free of KB dependencies -- it only
    executes tool calls the model asks for. `list_documents_fn`/
    `read_document_fn` (§15) are optional, same injected-closure convention --
    when supplied, the model can additionally read a FULL previously-ingested
    KB document (see KbVectorStore.get_document), not just top-k similarity
    snippets; omitting either (the pre-§15 default) offers only query_kb.
    `read_other_section_fn` (§3.3) is the same injected-closure convention for
    reading a specific OTHER SECTION of the CURRENT document (not the KB) on
    demand -- only populated on the compact-outline path (build_survey_tree's
    whole-doc gate found the document too large for one call).
    Returns (nodes, citations)."""

    def analyze_section(
        self,
        section_text: str,
        kb_context: str | None = None,
        whole_document: bool = False,
        topic_count: int | None = None,
    ) -> tuple[list[dict], bool]: ...

    def analyze_section_agentic(
        self,
        section_text: str,
        retrieve_fn: Callable[[str], tuple[str | None, list[dict]]],
        list_documents_fn: Callable[[], list[str]] | None = None,
        read_document_fn: Callable[[str], str | None] | None = None,
        read_other_section_fn: Callable[[str], str | None] | None = None,
        whole_document: bool = False,
        topic_count: int | None = None,
    ) -> tuple[list[dict], list[dict], bool]: ...


def _resolve_kb_citations(
    outline: str,
    raw_citations: list[dict],
    kb_relevance_client: KbRelevanceClient | None,
) -> list[KbCitation]:
    """Builds the final KbCitation list for one branch's retrieved
    snippets: verifies relevance via kb_relevance_client when supplied,
    degrading to KbCitationRelevance.UNKNOWN for any snippet the
    verification call didn't (or couldn't) judge -- verification is an
    enhancement, never a hard dependency, so any failure here must never
    fail the SURVEY job itself."""
    if not raw_citations:
        return []
    verdicts: dict[str, str] = {}
    if kb_relevance_client is not None:
        snippets = [{"source_file": c["source_file"], "text": c["text"]} for c in raw_citations]
        try:
            verdicts = kb_relevance_client.judge_kb_relevance(outline, snippets)
        except Exception as exc:  # noqa: BLE001 - KB relevance verification must never fail a SURVEY job
            logger.warning("KB relevance verification failed: %s", exc)
            verdicts = {}
    citations: list[KbCitation] = []
    for i, raw in enumerate(raw_citations):
        verdict_str = verdicts.get(str(i))
        try:
            relevance = KbCitationRelevance(verdict_str) if verdict_str is not None else KbCitationRelevance.UNKNOWN
        except ValueError:
            relevance = KbCitationRelevance.UNKNOWN
        citations.append(KbCitation(source_file=raw["source_file"], similarity=raw["similarity"], relevance=relevance))
    return citations


_DOC_LEVEL_QUERY_FALLBACK_CHARS = 2000


def _document_level_query_text(doc: CanonicalDoc) -> str:
    """Builds the ONE query text used to retrieve KB context ONCE per
    document for the §5c fallback (non-tool-capable model) path -- heading
    text is the strongest signal of what the document is about; when a
    document has no headings at all, falls back to its first ~2000 chars of
    block text (a conservative proxy, same spirit as
    _MAX_SURVEY_BRANCH_BLOCK_COUNT's block-count proxy)."""
    heading_text = "\n".join(block.text for block in doc.blocks if block.kind == BlockKind.HEADING)
    if heading_text.strip():
        return heading_text
    return "\n".join(block.text for block in doc.blocks)[:_DOC_LEVEL_QUERY_FALLBACK_CHARS]


# §14 Tier 1: cheap, always-on detection of a section referencing an
# external artifact this SURVEY run did not itself ingest (an attached
# spreadsheet, a numbered ReqID, an appendix/annex) -- flags it for manual
# KB ingest rather than silently proceeding as if the referenced content
# were already accounted for. Deliberately coarse pattern matching, no
# attempt to resolve the reference itself (that's Tier 2, out of scope
# here -- KB-resolution reuses this same agentic loop via §15's
# read_kb_document; ADO-resolution needs a new cross-service route, a much
# larger follow-up, deferred).
_REFERENCED_ATTACHMENT_PATTERN = re.compile(
    r"reqid\s*\d+|see excel|attached|refer(?:s|red)? to (?:the )?document|appendix|annex", re.IGNORECASE
)


def _referenced_attachment_warnings(section_text: str, node_id_prefix: str) -> list[str]:
    """One warning per distinct matched reference phrase in this branch's
    rendered section text, deduped case-insensitively (so a phrase repeated
    many times in one section doesn't spam the warnings list) while
    preserving the first occurrence's original casing in the message."""
    seen_by_key: dict[str, str] = {}
    for m in _REFERENCED_ATTACHMENT_PATTERN.finditer(section_text):
        seen_by_key.setdefault(m.group(0).lower(), m.group(0))
    return [
        f"Section {node_id_prefix or '(root)'} references an external artifact ({seen_by_key[key]!r}) this "
        "SURVEY run did not ingest -- consider adding it to the knowledge base."
        for key in sorted(seen_by_key)
    ]


_SECTION_LABEL_EXCERPT_CHARS = 60


def _derive_section_label(blocks: list[Block], tables: list[Table] | None, figures: list[Figure] | None) -> str | None:
    """Human-readable label for a branch's section, threaded into narration
    (see NarrationPublisher) so the progress UI can show WHICH real content
    a job is analyzing/failed on, not just an anonymous "Section N of M".
    Prefers the branch's own first heading text (the common case --
    _split_into_branches splits on depth-1 headings, so a branch's first
    block IS usually its heading); falls back to a short excerpt of the
    first block's text for a headingless branch, then a table's caption for
    the blocks-empty xlsx-only case (§4); None for a branch with nothing to
    label at all."""
    del figures  # no caption/label signal distinct from what tables/blocks already provide
    for block in blocks:
        if block.kind == BlockKind.HEADING:
            return block.text
    if blocks:
        text = blocks[0].text.strip()
        if len(text) > _SECTION_LABEL_EXCERPT_CHARS:
            return text[:_SECTION_LABEL_EXCERPT_CHARS] + "…"
        return text or None
    if tables and tables[0].caption:
        return tables[0].caption
    return None


def _build_document_outline(branches: list[list[Block]]) -> str:
    """Compact document outline (§3.3) -- section labels only, NOT raw
    section text -- threaded as `global_context` into every branch's
    analyze_section call when the whole document doesn't fit in one call
    (build_survey_tree's whole-doc gate). Gives every branch document-wide
    awareness without repeating the confirmed degrading pattern of
    re-sending the same raw full document on every one of many separate
    calls (see build_survey_tree's own docstring for the research citation).
    1-based numbering matches read_other_section_fn's section_id convention
    so the model can ask for e.g. "3" the same way this outline names it."""
    lines = [
        "Document outline (for orientation only -- you are analyzing ONE "
        "section below; call read_other_section with a number from this list "
        "if you need another section's full text for a cross-reference):"
    ]
    for i, branch in enumerate(branches, start=1):
        label = _derive_section_label(branch, None, None) or f"(section {i})"
        lines.append(f"{i}. {label}")
    return "\n".join(lines)


_FIGURE_TEXT_PATTERN = re.compile(r"^\[FIGURE:\s*(.*?)\s*\]$")


def _figure_line(block: Block) -> str | None:
    """FIGURE-kind blocks carry their caption embedded in block.text as
    "[FIGURE: {caption or 'none'}]" (see docx_loader.py/pdf_loader.py) --
    parse it back out. A 'none' placeholder (no real caption -- vision
    disabled, or the vision call failed for this image) is omitted from the
    rendered section entirely: the literal placeholder string must never
    reach the model and be mistaken for real content (the root cause of the
    "[FIGURE: none]" fake-requirement bug this redesign fixes). A real
    caption is rendered as a clearly-labeled blockquote line."""
    match = _FIGURE_TEXT_PATTERN.match(block.text)
    caption = match.group(1) if match else block.text
    if not caption or caption.lower() == "none":
        return None
    return f"> Figure: {caption}"


def _table_to_markdown(table: Table) -> str | None:
    """Renders a Table's rows as a markdown pipe table for inclusion in a
    section's rendered text (a PROMPT the model reads, unlike
    tree_builder._table_to_html's HTML rendering for an ADO rich-text
    field). Fully-blank rows are skipped, same convention as
    _table_to_html. Returns None for a table with no non-empty rows (a
    blank table contributes nothing, not an empty table block)."""
    rows = [row for row in table.rows if any(cell.strip() for cell in row)]
    if not rows:
        return None
    header, *body = rows
    lines = [
        "| " + " | ".join(cell.replace("|", "\\|") for cell in header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    lines.extend("| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in body)
    return "\n".join(lines)


def _render_block_line(block: Block) -> str | None:
    """One block rendered as a markdown-ish line for render_section, or None
    to omit it entirely (a 'none'-caption figure placeholder, or a
    never-actually-emitted TABLE-kind block -- tables live in the separate
    `tables` list render_section merges in by document order)."""
    if block.kind == BlockKind.HEADING:
        level = block.heading_level or 1
        return f"{'#' * min(level, 6)} {block.text}"
    if block.kind == BlockKind.LIST_ITEM:
        return f"- {block.text}"
    if block.kind == BlockKind.FIGURE:
        return _figure_line(block)
    if block.kind == BlockKind.TABLE:
        return None  # never actually emitted by any loader today
    return block.text  # PARAGRAPH, NOTE, OPEN_TBD -- plain content lines


def render_section(blocks: list[Block], tables: list[Table] | None = None, figures: list[Figure] | None = None) -> str:
    """Replaces _build_outline for the holistic SURVEY redesign: renders a
    whole section as ONE coherent, structure-preserving markdown passage
    instead of one outline line per block, so the model can synthesize a
    bullet run into one requirement instead of receiving it pre-shredded
    into one candidate node per line (see analyze_section/
    analyze_section_agentic). `figures` is accepted for API symmetry with
    the xlsx-only synthetic-branch call site (build_survey_tree) but is not
    consulted here yet -- every loader already embeds each Figure's caption
    directly in its corresponding FIGURE-kind Block.text (see
    _figure_line), which is what's actually rendered.

    Tables are interleaved at their REAL document-order position (§12) --
    each loader (docx_loader.py's body-walk, pdf_loader.py's bbox-based
    per-page merge) now shares ONE monotonically increasing offset counter
    across blocks AND tables, so `source_ref.start_offset` is directly
    comparable between the two lists within the same loader run. Sorting
    the merged (block, table) sequence by that offset replaces the previous
    "always appended at the very end under a ### Tables marker"
    approximation -- a table now lands wherever its real position in the
    document falls."""
    del figures  # see docstring -- not yet consulted, kept for signature symmetry
    entries: list[tuple[int, str]] = []
    for block in blocks:
        line = _render_block_line(block)
        if line is not None:
            entries.append((block.source_ref.start_offset, line))
    for table in tables or []:
        markdown = _table_to_markdown(table)
        if markdown is not None:
            entries.append((table.source_ref.start_offset, markdown))
    entries.sort(key=lambda entry: entry[0])
    return "\n".join(line for _, line in entries)


def build_survey_tree(
    doc: CanonicalDoc,
    analysis_client: SectionAnalysisClient,
    scoring_client: BatchedScoringClient | None = None,
    customer_id: str | None = None,
    criteria_retriever: CriteriaRetriever | None = None,
    user_id: str | None = None,
    embed_client: object | None = None,
    vector_store: KbVectorStore | None = None,
    link_type_client: TraceLinkInferenceClient | None = None,
    link_type_catalog: list[dict] | None = None,
    kb_relevance_client: KbRelevanceClient | None = None,
    progress_callback: ProgressCallback | None = None,
    model: str | None = None,
) -> WorkItemTree:
    """SURVEY-mode leveling entry point. Splits the document into top-level
    branches (_split_into_branches, the same depth-1-heading split
    BASELINE's build_baseline_tree already uses) and processes each branch
    through ONE holistic analyze_section (or analyze_section_agentic) call,
    replacing the old per-branch infer_hierarchy + generate_requirements_for_document
    call pair -- see SectionAnalysisClient's docstring and the redesign plan's
    §1/§2 for why: the old pair mechanically atomized structure (one input
    Block -> exactly one output node), while analyze_section lets the model
    return however many nodes a section actually contains.

    `model` (the per-job model override, same value threaded from main.py's
    /level route) resolves via `_resolve_caps` to this document's branch-size
    cap AND whether the model supports tool-calling (§5c): tool-capable
    models drive KB retrieval AGENTICALLY per-branch via analyze_section_agentic
    (a query_kb tool call during analysis); other models get a single
    pre-computed, once-per-document KB context threaded into every branch's
    plain analyze_section call (the ORIGINAL, pre-agentic KB design, kept as
    the fallback). Splitting the ENTIRE document into one call previously
    risked overflowing the LLM's context window in a single whole-document
    call, producing truncated/malformed JSON that aborted the whole job
    rather than a partial/degraded result.

    A document with only ONE branch (the common case: no heading structure,
    or one top-level section) behaves BYTE-IDENTICALLY to before this
    change — same single call pair, same unprefixed node_ids ("0", "1", ...)
    — chunking is invisible unless a document genuinely has multiple
    top-level branches. Only a genuinely multi-branch document gets
    per-branch node_id namespacing (see _build_survey_tree_for_branch); each
    branch's own hierarchy is entirely self-contained (a branch's node_ids
    only ever reference other node_ids within that SAME branch/outline, so
    there is no cross-branch parent-reference case to reconcile).

    `scoring_client` is entirely optional (default None, same as every
    pre-existing test/call site) — when supplied, every branch's nodes get
    a real quality_score/quality_issues judgment via ONE extra batched call
    per branch; when omitted, every node's quality_score/quality_issues
    stay at their model defaults (None/[]), byte-identical to before this
    capability existed.

    Warnings from every branch are concatenated into one list, in branch
    order.

    `customer_id` is a single value applied uniformly to every node produced
    (same contract as build_baseline_tree's own customer_id parameter) --
    previously this parameter did not exist at all here, so /level silently
    dropped the job's customer_id for every SURVEY-mode node (always None),
    while BASELINE nodes got it correctly. Confirm()'s Customer ID field
    resolution has therefore never been reachable for a SURVEY job.

    `criteria_retriever` is entirely optional (default None, same
    opt-in-capability convention as scoring_client) -- when supplied
    alongside scoring_client, each branch's quality scoring call is grounded
    against retrieved reference criteria (see
    app.quality.criteria_retrieval.CriteriaRetriever) instead of relying
    solely on the model's own parametric knowledge of public standards.

    `user_id`/`embed_client`/`vector_store`, when ALL supplied, ground
    every branch's analysis call, but HOW depends on `_resolve_caps(model)`'s
    tool-calling verdict (§5c): a tool-capable model gets a `retrieve_fn`
    closure (wrapping app.kb.retrieval.retrieve_context) passed into every
    branch's analyze_section_agentic call, which actively pulls KB context
    per its own query_kb tool calls; a non-tool-capable model instead gets
    ONE retrieve_context call made HERE, up front, against
    `_document_level_query_text(doc)` -- the SAME resulting kb_context string
    is threaded into every branch's plain analyze_section call (and into
    score_requirements_for_document). When any of the three KB params is
    omitted, KB retrieval is skipped entirely (kb_context/retrieve_fn stay
    None for every call), matching pre-KB behavior exactly. `kb_citations`
    (deduped by source_file, keeping the highest similarity) is returned once
    on the tree — for the fallback path this is the single document-level
    retrieval's citations; for the agentic path it's the union of every
    branch's own query_kb hits, each marked KbCitationRelevance.RELEVANT
    (the model chose to pull and use them, so relevance verification via
    kb_relevance_client does not apply on this path).

    `link_type_client`/`link_type_catalog`, when link_type_client is
    supplied, run ONE additional whole-tree call (after every branch has
    been processed, using the full combined node list — see
    TraceLinkInferenceClient's docstring for why this is whole-tree, not
    per-branch) inferring trace/coverage links; when omitted, trace_links
    stays [] — matching pre-trace-link behavior exactly. Every returned link
    is validated before being trusted: a source_node_id that doesn't match
    any node actually produced by this build is always dropped, and — when
    a non-empty link_type_catalog was supplied — a reference_name outside
    that catalog is dropped too. A link's target_ref is classified as
    intraJob when it matches another node's local_id in this same tree, and
    as crossJob (an opaque customer-id string) otherwise."""
    branch_cap, context_budget_tokens, coverage_budget_tokens, supports_tools = _resolve_caps(model)

    # §3: whole-document single-call gate. A single long-context call over
    # the WHOLE document is not the "repeated raw-text stuffing across many
    # calls" pattern adversarially-verified research warns against (see this
    # module's docstring for build_survey_tree) -- it's one call, so if the
    # rendered document fits this model's COVERAGE budget (with headroom for
    # KB context/system prompt/output), skip branch-splitting entirely and
    # let the existing single-branch path below (len(branches) <= 1) handle
    # the whole document exactly as it already does for a headingless
    # document. Gated on coverage_budget_tokens, NOT context_budget_tokens --
    # confirmed live that a document comfortably fitting the context window
    # still under-synthesizes in one holistic call (see _ModelCaps.
    # coverage_budget_tokens's own docstring).
    whole_doc_text = render_section(doc.blocks, doc.tables, doc.figures)
    fits_whole_document = _estimate_tokens(whole_doc_text) + _WHOLE_DOC_HEADROOM_TOKENS <= coverage_budget_tokens

    # Real heading count, computed once here (where doc.blocks is already in
    # scope) for the whole-document coverage hint (§3, see
    # _whole_document_hint's docstring) -- confirmed live that a qualitative-
    # only reminder doesn't change model behavior; a concrete floor tied to
    # the document's OWN real structure is a much stronger signal. Counts
    # ALL heading blocks regardless of depth (deliberately not the
    # min(known_depths) heuristic _split_into_branches uses -- that's a
    # split-boundary decision, this is a coverage floor, and over-counting
    # sub-headings only raises the floor, the safe direction for a coverage
    # bug). Only meaningful on the single-branch path (whole_document=True
    # there); the multi-branch loop never uses it.
    heading_count = sum(1 for b in doc.blocks if b.kind == BlockKind.HEADING)

    global_context: str | None = None
    if fits_whole_document:
        branches: list[list[Block]] = [doc.blocks] if doc.blocks else []
    else:
        branches = _split_into_branches(doc)
        if len(branches) <= 1:
            # Flat/single-section document (no heading structure, or only
            # one top-level section) that still exceeded the coverage gate
            # above -- _split_into_branches has no heading boundary to split
            # on, so without this it would fall through to the single-call
            # path below and hit the exact under-synthesis this redesign
            # fixes. Window-chunk its own blocks into coverage-sized units
            # instead, reusing _merge_branches_by_budget as a token-window
            # chunker (fed one block per "branch" -- it already greedily
            # packs adjacent items up to a token budget, seeded from the
            # first item, so this is a correct, order-preserving chunker
            # with no new primitive needed). This is what makes the fix
            # generalize to headingless documents, not just headed ones.
            flat_blocks = branches[0] if branches else doc.blocks
            branches = _merge_branches_by_budget([[b] for b in flat_blocks], coverage_budget_tokens)
        else:
            # §4: the document's own structural split alone produces one
            # branch PER heading occurrence, however small each section is --
            # greedily merge adjacent branches back together up to this
            # model's COVERAGE budget (not context budget -- see gate above)
            # before ever bounding by block count. See
            # _merge_branches_by_budget's own docstring.
            branches = _merge_branches_by_budget(branches, coverage_budget_tokens)
        # Document-structure-driven splitting alone cannot guarantee a small
        # branch (a real document can have very few, wildly unbalanced
        # top-level sections) -- bound each branch's size directly, regardless
        # of the document's own heading structure. See _bound_branch_size's own
        # docstring for why this is SURVEY-only, not applied to
        # build_baseline_tree's branches.
        branches = [
            bounded_branch for branch in branches for bounded_branch in _bound_branch_size(branch, branch_cap)
        ]
        # §3.3: the document doesn't fit in one call, so every branch's own
        # call would otherwise see ONLY its own fragment -- the exact
        # fragmentation this redesign fixes. A compact outline (headings +
        # per-section synopsis, NOT the raw full text) is threaded into every
        # branch's analyze_section call instead, giving document-wide
        # awareness without repeating the confirmed degrading pattern of
        # re-sending the same raw full document on every one of many calls.
        global_context = _build_document_outline(branches)

    kb_deps_present = user_id is not None and embed_client is not None and vector_store is not None
    doc_kb_context: str | None = None
    doc_kb_citations: list[KbCitation] = []
    retrieve_fn: Callable[[str], tuple[str | None, list[dict]]] | None = None
    list_documents_fn: Callable[[], list[str]] | None = None
    read_document_fn: Callable[[str], str | None] | None = None
    if kb_deps_present and not supports_tools:
        # Fallback path (§5c): ONE retrieve_context call for the whole
        # document, not one per branch -- the SAME resulting kb_context
        # string grounds every branch's analyze_section + scoring call.
        query_text = _document_level_query_text(doc)
        doc_kb_context, raw_doc_citations = retrieve_context(user_id, query_text, embed_client, vector_store)
        doc_kb_citations = _resolve_kb_citations(query_text, raw_doc_citations, kb_relevance_client)
    elif kb_deps_present and supports_tools:
        # Agentic path (§5c): the model pulls KB context itself via query_kb
        # during analyze_section_agentic -- retrieve_fn just executes
        # whatever query the model asks for, closing over these three deps
        # so OrchestratorLlmClient/analyze_section_agentic stay KB-agnostic.
        def retrieve_fn(query: str, _uid=user_id, _ec=embed_client, _vs=vector_store) -> tuple[str | None, list[dict]]:
            return retrieve_context(_uid, query, _ec, _vs)

        # §15: same injected-closure convention, offering the model a
        # FULL-document read (KbVectorStore.get_document/list_documents)
        # alongside query_kb's top-k snippets.
        def list_documents_fn(_uid=user_id, _vs=vector_store) -> list[str]:
            return _vs.list_documents(_uid)

        def read_document_fn(source_file: str, _uid=user_id, _vs=vector_store) -> str | None:
            return _vs.get_document(_uid, source_file)

    # §3.3: only built on the compact-outline path (global_context is set) --
    # lets a tool-capable model pull a specific OTHER section's full text on
    # demand, matching the confirmed research finding that agent-directed
    # selective retrieval beats blind full-context stuffing. IDs match the
    # 1-based numbering _build_document_outline uses so the model can refer
    # to "section 3" the same way the outline names it.
    read_other_section_fn: Callable[[str], str | None] | None = None
    if global_context is not None:
        branch_texts_by_id = {str(i + 1): render_section(b, None, None) for i, b in enumerate(branches)}

        def read_other_section_fn(section_id: str, _texts=branch_texts_by_id) -> str | None:
            return _texts.get(section_id)

    all_nodes: list[WorkItemNode] = []
    all_warnings: list[str] = []
    all_kb_citations: list[KbCitation] = list(doc_kb_citations)
    blocks_total = sum(len(b) for b in branches)
    blocks_done = 0

    # Multi-branch table/figure placement is a known, not-yet-solved gap
    # (see _build_survey_tree_for_branch's own call sites below: only the
    # single-branch path passes tables=/figures= through) -- a document that
    # goes multi-branch silently loses its tables/figures entirely, with no
    # signal to the reviewer. This was a rare corner case before the
    # coverage-safe chunking fix (§1) since most documents fit the old,
    # much larger context_budget_tokens gate; the new, much smaller
    # coverage_budget_tokens gate routes far more documents through this
    # path, making the silent loss common rather than rare. Surface it as a
    # warning (never fails the job) so it's reviewable instead of invisible
    # -- matches this module's established "never fail, always warn"
    # convention (see _referenced_attachment_warnings, the dropped-blocks
    # coverage warning, the low-grounding warning).
    if len(branches) > 1 and (doc.tables or doc.figures):
        all_warnings.append(
            f"Document has {len(doc.tables)} table(s) and {len(doc.figures)} "
            "figure(s), but was split into multiple sections for analysis -- "
            "per-branch table/figure placement is not yet supported, so this "
            "content was NOT included in any section sent to the model and "
            "will be missing from the generated work items."
        )

    if len(branches) <= 1:
        # §4: a table-only document (xlsx: doc.blocks=[], doc.tables=[one per
        # sheet]) has no headings at all, so _split_into_branches yields []
        # and this is the single/zero-branch path -- WITHOUT passing tables
        # here, this call would render an empty section (render_section([])
        # == "") and the document would silently produce an empty tree. This
        # is also the single home for ANY single-branch document's tables
        # (not just xlsx) -- a multi-branch document's tables are a separate,
        # not-yet-solved placement question (see §12, unaffected by this fix).
        branch_tree = _build_survey_tree_for_branch(
            doc.blocks, analysis_client, scoring_client,
            node_id_prefix="", customer_id=customer_id, criteria_retriever=criteria_retriever,
            tables=doc.tables, figures=doc.figures,
            supports_tools=supports_tools, retrieve_fn=retrieve_fn, kb_context=doc_kb_context,
            list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
            # True precisely when the entire document was analyzed in one
            # pass with no compact outline built (global_context is None) --
            # even a "single branch" can have global_context set if
            # _merge_branches_by_budget collapsed everything back into one
            # branch on the doesn't-fit path (§4), which is NOT the
            # whole-doc-gate's "fits in one call outright" case.
            whole_document=(global_context is None),
            topic_count=heading_count,
            branch_index=0, branch_count=1, blocks_done_before=0, blocks_total=blocks_total,
            progress_callback=progress_callback,
        )
        all_nodes.extend(branch_tree.nodes)
        all_warnings.extend(branch_tree.warnings)
        all_kb_citations.extend(branch_tree.kb_citations)
    else:
        for branch_index, branch_blocks in enumerate(branches):
            branch_tree = _build_survey_tree_for_branch(
                branch_blocks, analysis_client, scoring_client,
                node_id_prefix=f"br{branch_index}_", customer_id=customer_id, criteria_retriever=criteria_retriever,
                supports_tools=supports_tools, retrieve_fn=retrieve_fn, kb_context=doc_kb_context,
                list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
                global_context=global_context, read_other_section_fn=read_other_section_fn,
                branch_index=branch_index, branch_count=len(branches), blocks_done_before=blocks_done,
                blocks_total=blocks_total, progress_callback=progress_callback,
            )
            all_nodes.extend(branch_tree.nodes)
            all_warnings.extend(branch_tree.warnings)
            all_kb_citations.extend(branch_tree.kb_citations)
            blocks_done += len(branch_blocks)

    # kb_citations deduped across branches by source_file, keeping the
    # highest-similarity hit -- on the fallback path every branch shares the
    # SAME doc-level citations (harmless duplication, deduped here); on the
    # agentic path each branch can genuinely surface different source files.
    best_by_file: dict[str, KbCitation] = {}
    for citation in all_kb_citations:
        existing = best_by_file.get(citation.source_file)
        if existing is None or citation.similarity > existing.similarity:
            best_by_file[citation.source_file] = citation
    deduped_citations = [best_by_file[name] for name in sorted(best_by_file)]

    trace_links: list[TraceLink] = []
    if link_type_client is not None:
        catalog = link_type_catalog or []
        valid_reference_names = {entry["reference_name"] for entry in catalog}
        node_by_local_id = {node.local_id: node for node in all_nodes}
        llm_nodes = [
            {"node_id": node.local_id, "type": node.type.value, "title": node.title, "text": node.description}
            for node in all_nodes
        ]
        # Trace-link inference judges relationships between already-generated
        # nodes, not raw source text, so it isn't grounded against KB context
        # the way the other three calls are -- passing None here is a
        # deliberate simplification, not an oversight.
        if progress_callback is not None:
            progress_callback(
                LevelingProgress(
                    phase="infer_trace_links", branch_index=None, branch_count=len(branches),
                    blocks_done=blocks_total, blocks_total=blocks_total, kb_grounded=False, kb_citations=[],
                )
            )
        raw_links = link_type_client.infer_trace_links(llm_nodes, catalog, kb_context=None)
        catalog_by_ref = {entry["reference_name"]: entry.get("name", entry["reference_name"]) for entry in catalog}
        for raw_link in raw_links:
            source_node_id = raw_link.get("source_node_id")
            reference_name = raw_link.get("reference_name")
            target_ref = raw_link.get("target_ref")
            if source_node_id not in node_by_local_id:
                continue
            if catalog and reference_name not in valid_reference_names:
                continue
            if target_ref in node_by_local_id:
                trace_links.append(
                    TraceLink(
                        source_local_id=source_node_id,
                        reference_name=reference_name,
                        display_name=catalog_by_ref.get(reference_name, reference_name),
                        target_kind=TraceLinkTargetKind.INTRA_JOB,
                        target_local_id=target_ref,
                        resolution_status=TraceLinkResolutionStatus.PENDING,
                    )
                )
            elif target_ref:
                trace_links.append(
                    TraceLink(
                        source_local_id=source_node_id,
                        reference_name=reference_name,
                        display_name=catalog_by_ref.get(reference_name, reference_name),
                        target_kind=TraceLinkTargetKind.CROSS_JOB,
                        target_customer_id=target_ref,
                        resolution_status=TraceLinkResolutionStatus.PENDING,
                    )
                )

    return WorkItemTree(nodes=all_nodes, warnings=all_warnings, kb_citations=deduped_citations, trace_links=trace_links)


def _build_survey_tree_for_branch(
    blocks: list[Block],
    analysis_client: SectionAnalysisClient,
    scoring_client: BatchedScoringClient | None,
    node_id_prefix: str,
    customer_id: str | None = None,
    criteria_retriever: CriteriaRetriever | None = None,
    tables: list[Table] | None = None,
    figures: list[Figure] | None = None,
    supports_tools: bool = False,
    retrieve_fn: Callable[[str], tuple[str | None, list[dict]]] | None = None,
    list_documents_fn: Callable[[], list[str]] | None = None,
    read_document_fn: Callable[[str], str | None] | None = None,
    kb_context: str | None = None,
    global_context: str | None = None,
    read_other_section_fn: Callable[[str], str | None] | None = None,
    whole_document: bool = False,
    topic_count: int | None = None,
    branch_index: int = 0,
    branch_count: int = 1,
    blocks_done_before: int = 0,
    blocks_total: int = 0,
    progress_callback: ProgressCallback | None = None,
) -> WorkItemTree:
    """Does the actual per-branch (or, for a single-branch document, whole-
    document) SURVEY leveling via ONE holistic analyze_section /
    analyze_section_agentic call (see SectionAnalysisClient's docstring),
    replacing the old infer_hierarchy + generate_requirements_for_document
    pair -- the model returns the COMPLETE node set it decides this section
    contains, not one node per input Block. Title comes from the model's own
    'title' field on each node (a short, distinct label -- see
    _SECTION_ANALYSIS_SYSTEM_PROMPT), clamped to 256 chars via
    extract_baseline_title; a model response that omits it (schema
    non-compliance) falls back to extract_baseline_title(text) instead, same
    as before this capability existed, with a warning noting the fallback.
    fidelity_hash is computed over the description, since that's the
    content actually written to ADO and the idempotency map's key must match
    what a re-run would produce — but note this is a WEAKER guarantee than
    BASELINE's verbatim-source-span hash: temperature=0 is
    mostly-but-not-guaranteed deterministic, so a model or prompt change can
    shift this hash and produce a duplicate create on re-run. Embedding dedup
    partially backstops this; it is not a substitute.

    `node_id_prefix`: "" for a single-branch document (byte-identical
    node_ids to pre-chunking behavior); "br{N}_" for one of several
    branches in a multi-branch document. Applied to both a node's own
    local_id and its parent_local_id (never to the model-facing temp_id used
    in the analyze_section call itself — the model only ever sees this
    branch's own local temp_ids).

    **Accepted trade-off, not a silent regression:** with the old 1:1
    block<->node mapping gone, `source_ref` and `grounding_score` both
    coarsen -- every node in a branch shares the branch's representative
    source_ref (first block's, or first table's/figure's for a blocks-empty
    branch), and grounding is measured against the WHOLE rendered section
    text rather than one source block. This is an inherent consequence of
    holistic synthesis: the model can merge N input blocks into M != N
    nodes, so no exact per-node source span exists any more. True
    document-order per-node source spans are out of scope here (loader
    body-walk ordering is a separate follow-up).

    `supports_tools`/`retrieve_fn`/`kb_context` (§5c's capability gate):
    when `supports_tools` is True and `retrieve_fn` is supplied, this branch
    is analyzed via analyze_section_agentic (the model pulls KB context
    itself via query_kb); otherwise via plain analyze_section using the
    pre-computed `kb_context` (None when KB isn't configured at all).

    `global_context` (§3.3): a COMPACT document outline (headings + a short
    per-section synopsis, NOT the raw full document) prepended to this
    branch's own section text -- only populated when the whole document
    didn't fit in one call (build_survey_tree's whole-doc gate), giving every
    branch document-wide awareness without repeating the confirmed
    degrading pattern of re-sending the same raw full text on every one of
    many separate calls. `read_other_section_fn`, when supplied (tool-capable
    models only), additionally lets the model pull a specific OTHER section's
    full text on demand if the outline alone isn't enough.

    `whole_document` (True only when build_survey_tree's whole-doc gate found
    the ENTIRE document fits in one call -- i.e. global_context is None and
    this is the single branch) appends a coverage hint to the analysis
    prompt: applied once to hundreds of blocks instead of many times (once
    per branch/heading, the pre-whole-doc-gate design), the base prompt's
    synthesis-maximizing instructions otherwise drive over-consolidation --
    observed live: 82 nodes (old per-branch) vs 12-25 (new single-call,
    varying by run) for the same 679-block document. `topic_count` (the
    document's real heading count, see build_survey_tree) makes that hint
    quantitative -- confirmed live across 3 separate real runs that a
    qualitative-only hint does not change model behavior (node count stayed
    floored at 12-16 with no coverage improvement); see
    orchestrator_llm_client._whole_document_hint's own docstring."""
    section_text = render_section(blocks, tables, figures)
    if global_context:
        section_text = f"{global_context}\n\n---\n\n{section_text}"
    section_label = _derive_section_label(blocks, tables, figures)

    def _fire(phase: Phase, kb_grounded: bool, kb_citations_raw: list[dict]) -> None:
        if progress_callback is None:
            return
        progress_callback(
            LevelingProgress(
                phase=phase, branch_index=branch_index, branch_count=branch_count,
                blocks_done=blocks_done_before, blocks_total=blocks_total,
                kb_grounded=kb_grounded, kb_citations=kb_citations_raw,
                section_label=section_label,
            )
        )

    if supports_tools and retrieve_fn is not None:
        _fire("analyze_section", kb_grounded=False, kb_citations_raw=[])
        raw_nodes, raw_hits, truncated = analysis_client.analyze_section_agentic(
            section_text, retrieve_fn, list_documents_fn=list_documents_fn, read_document_fn=read_document_fn,
            read_other_section_fn=read_other_section_fn, whole_document=whole_document, topic_count=topic_count,
        )
        # The model chose to pull and use these snippets itself, so relevance
        # verification (kb_relevance_client) doesn't apply on this path --
        # mark every hit RELEVANT outright (see build_survey_tree's docstring).
        kb_citations = [
            KbCitation(source_file=hit["source_file"], similarity=hit["similarity"], relevance=KbCitationRelevance.RELEVANT)
            for hit in raw_hits
        ]
    else:
        kb_citations_raw_dicts = (
            [{"source_file": "(document-level)", "similarity": 1.0}] if kb_context else []
        )
        _fire("analyze_section", kb_grounded=bool(kb_context), kb_citations_raw=kb_citations_raw_dicts)
        raw_nodes, truncated = analysis_client.analyze_section(
            section_text, kb_context=kb_context, whole_document=whole_document, topic_count=topic_count
        )
        kb_citations = []  # doc-level citations are collected once in build_survey_tree, not per-branch

    by_temp_id = {n["temp_id"]: n for n in raw_nodes if isinstance(n, dict) and n.get("temp_id")}
    valid_tag_values = {t.value for t in RequirementTag}
    warnings: list[str] = []
    if truncated:
        warnings.append(
            "Model output was truncated by the token limit -- results may be incomplete; "
            "consider raising the model's output cap."
        )
    nodes: list[WorkItemNode] = []

    representative_source_ref = (
        blocks[0].source_ref if blocks else (tables[0].source_ref if tables else (figures[0].source_ref if figures else None))
    )

    for temp_id, entry in by_temp_id.items():
        text = entry.get("text")
        if not text:
            continue
        raw_title = entry.get("title")
        if raw_title:
            title = extract_baseline_title(raw_title)
        else:
            # Tolerant of LLM non-compliance: the schema marks 'title'
            # required, but a model can still omit it -- degrade to the
            # pre-title-distillation behavior (derive from the full
            # description text) rather than crashing the branch.
            message = f"Node {node_id_prefix}{temp_id} had no model title -- derived from description text."
            logger.warning(message)
            warnings.append(message)
            title = extract_baseline_title(text)
        tags = sorted(
            {RequirementTag(tag) for tag in entry.get("tags", []) if tag in valid_tag_values},
            key=lambda t: t.value,
        )
        try:
            node_type = WorkItemType(entry.get("type"))
        except ValueError:
            # Tolerant of LLM non-compliance: the prompt explicitly lists "one
            # of: Epic, Feature, Requirement", but a model can still
            # hallucinate an out-of-vocabulary type (observed live:
            # gemma4:e4b returned "Recommendation"). Falling back to
            # Requirement -- the safest default, since it never implies a
            # parent/child expectation the way Epic/Feature do.
            message = (
                f"Node {node_id_prefix}{temp_id} had an invalid type "
                f"({entry.get('type')!r}) from section analysis -- defaulted to Requirement."
            )
            logger.warning(message)
            warnings.append(message)
            node_type = WorkItemType.REQUIREMENT

        parent_temp_id = entry.get("parent_temp_id")
        if parent_temp_id is not None and parent_temp_id not in by_temp_id:
            message = (
                f"Node {node_id_prefix}{temp_id} referenced unknown parent_temp_id "
                f"{parent_temp_id!r} -- attached as section root."
            )
            logger.warning(message)
            warnings.append(message)
            parent_temp_id = None

        grounding_score = _grounding_score(text, section_text)
        if grounding_score < _LOW_GROUNDING_THRESHOLD:
            message = (
                f"Node {node_id_prefix}{temp_id}'s generated description has low grounding "
                f"({grounding_score:.0%} of its vocabulary traces back to the source section) -- "
                "worth reviewing for possible fabrication."
            )
            logger.warning(message)
            warnings.append(message)

        nodes.append(
            WorkItemNode(
                local_id=f"{node_id_prefix}{temp_id}",
                type=node_type,
                parent_local_id=f"{node_id_prefix}{parent_temp_id}" if parent_temp_id is not None else None,
                title=title,
                description=text,
                customer_id=customer_id,
                source_ref=representative_source_ref,
                fidelity_hash=hashlib.sha256(text.encode()).hexdigest(),
                tags=tags,
                mode=WorkItemMode.SURVEY,
                grounding_score=grounding_score,
            )
        )

    # Coverage check: since analyze_section can merge N input blocks into
    # M != N nodes, there is no 1:1 node<->block mapping left to check
    # per-block coverage against -- instead, run each INPUT block's own text
    # against the combined generated node texts as a whole (same helper the
    # old two-call design used for its own "merged, not dropped" signal).
    all_generated_texts = [node.description for node in nodes]
    dropped_blocks = [
        i
        for i, block in enumerate(blocks)
        if not _block_content_appears_in_generated_output(resolve_block_depth(block)[1], all_generated_texts)
    ]
    if dropped_blocks:
        message = (
            f"SURVEY analysis did not reference {len(dropped_blocks)} of {len(blocks)} source "
            "block(s), and their content does not appear (even paraphrased) in any generated node "
            f"-- likely dropped, not merged: {dropped_blocks[:10]}"
        )
        logger.warning(message)
        warnings.append(message)

    warnings.extend(_referenced_attachment_warnings(section_text, node_id_prefix))

    if scoring_client is not None and nodes:
        _fire("score_requirements", kb_grounded=bool(kb_context), kb_citations_raw=[])
        _apply_quality_scores(nodes, scoring_client, warnings, node_id_prefix, criteria_retriever, kb_context)

    return WorkItemTree(nodes=nodes, warnings=warnings, kb_citations=kb_citations)


def _build_criteria_context(criteria_retriever: CriteriaRetriever, nodes: list[WorkItemNode]) -> str:
    """Retrieves the top-k criteria most relevant to this BRANCH's nodes as a
    whole (one retrieve() call on the concatenated descriptions, not one per
    node -- see CriteriaRetriever's docstring for why), formatted as plain
    reference text the scoring prompt can cite. Empty string if the branch's
    nodes have no description text at all (nothing to retrieve against)."""
    combined_text = " ".join(node.description for node in nodes if node.description)
    if not combined_text.strip():
        return ""
    criteria = criteria_retriever.retrieve(combined_text)
    return "\n".join(f"- {c.issue.value}: {c.text}" for c in criteria)


def _apply_quality_scores(
    nodes: list[WorkItemNode],
    scoring_client: BatchedScoringClient,
    warnings: list[str],
    node_id_prefix: str,
    criteria_retriever: CriteriaRetriever | None = None,
    kb_context: str | None = None,
) -> None:
    """Judges every node's FINAL formalized description in ONE batched call
    (mutates `nodes` in place -- WorkItemNode is a plain, mutable pydantic
    model). Tolerant of a missing, malformed (non-int, out of 0-100 range),
    or wrongly-shaped scoring entry for one node_id -- falls back to
    quality_score=None/quality_issues=[] for that node only, never crashes
    the batch or affects sibling nodes, same philosophy as every other
    LLM-response-parsing path in this module.

    `criteria_retriever`, when supplied, grounds this call against retrieved
    reference criteria (see _build_criteria_context). `kb_context` is the
    same SharePoint/OneDrive KB context computed for this branch's other two
    calls, threaded through for consistency. Both are independent/optional;
    omitting either (or both) is byte-identical to before either capability
    existed."""
    descriptions_by_node_id = {node.local_id: node.description for node in nodes}
    criteria_context = _build_criteria_context(criteria_retriever, nodes) if criteria_retriever is not None else None
    scores_by_node_id = scoring_client.score_requirements_for_document(
        descriptions_by_node_id, criteria_context, kb_context
    )
    valid_issue_values = {i.value for i in RequirementQualityIssue}

    for node in nodes:
        entry = scores_by_node_id.get(node.local_id)
        if not isinstance(entry, dict):
            continue
        raw_score = entry.get("score")
        if isinstance(raw_score, int) and not isinstance(raw_score, bool) and 0 <= raw_score <= 100:
            node.quality_score = raw_score
        node.quality_issues = sorted(
            {
                RequirementQualityIssue(issue)
                for issue in entry.get("issues", [])
                if issue in valid_issue_values
            },
            key=lambda i: i.value,
        )

    missing_or_invalid = [node.local_id for node in nodes if node.quality_score is None]
    if missing_or_invalid:
        message = (
            f"Quality scoring returned no valid score for {len(missing_or_invalid)} node(s) in branch "
            f"'{node_id_prefix or '(root)'}': {missing_or_invalid[:10]}"
        )
        logger.warning(message)
        warnings.append(message)
