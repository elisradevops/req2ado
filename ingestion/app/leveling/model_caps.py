# app/leveling/model_caps.py
"""Per-model branch-size cap, context-token budget, and tool-calling
capability resolution (S12 -- extracted out of llm_leveling.py, whose
build_survey_tree is the sole real caller alongside app.main's /level route,
which resolves the SAME caps for num_ctx before constructing its
OrchestratorLlmClient)."""
from __future__ import annotations

from typing import NamedTuple, Protocol

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
# Live model roster verified against the actual deployed Open WebUI instance
# (screenshot, 2026-08-05): qwen3.6:35b (default), qwen2.5:32b-instruct,
# qwen3:4b, qwen2.5:1.5b, gemma4:e4b, llama3.2:1b, all-minilm (embed-only,
# never a chat model), Arena Model (an Open WebUI virtual multi-model
# construct, not a real Ollama model -- see openwebui.client.ts's
# showModel() guard). qwen2.5:1.5b/llama3.2:1b are present but deliberately
# left OUT of the table below rather than given fabricated entries -- no
# real /api/show-verified capability data exists for either yet (unlike
# every entry that IS below, each backed by a live-tested comment). They
# correctly fall through to the conservative unknown-model default
# (supports_tools=False, 28k budget), which is a reasonable floor for
# 1.2B-1.5B-class models regardless. Add real entries once actually
# verified against /api/show, not before.
_MODEL_CAPS: dict[str, _ModelCaps] = {
    "qwen3:4b": _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 28_000, _COVERAGE_BUDGET_TOKENS, True),
    "gemma4:e4b": _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 90_000, _COVERAGE_BUDGET_TOKENS, True),
    # qwen2.5:32b-instruct -- empirically tested live against the same real
    # 682-block AirPro ICD at coverage_budget_tokens=10_000 (the shared local-
    # model default) vs 20_000: the larger budget roughly HALVED the dropped-
    # block rate (45% -> 23% of blocks unreferenced by any generated node),
    # produced MORE nodes (50 -> 56, not fewer -- ruling out the over-
    # consolidation concern a bigger budget usually risks), and ran FASTER
    # overall (33min -> 17min, fewer round-trips outweighing each call's
    # larger prompt). Confirms a bigger/more-capable model genuinely tolerates
    # a higher coverage budget before the lost-in-the-middle under-synthesis
    # this constant guards against kicks in -- NOT a blanket assumption from
    # parameter count or context-window size alone. context_budget_tokens=
    # 32_000 is this model's real native window (confirmed via /api/show).
    "qwen2.5:32b-instruct": _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 32_000, 20_000, True),
    # qwen3.6:35b -- MoE architecture (qwen35moe family, 36B total weights,
    # only a fraction active per token), confirmed live via /api/show:
    # tools + vision + thinking, 256K real context. Empirically tested
    # against the same 682-block AirPro ICD at coverage_budget_tokens=10_000
    # vs 20_000 (both with the mandatory `think: False` -- see
    # orchestrator_llm_client.py's analyze_section/analyze_section_agentic
    # doc comments -- since this model's hidden reasoning otherwise costs
    # 3-10x wall time for zero observed accuracy gain on this task): 20_000
    # was marginally better on every metric (270.8s vs 280.1s, same 75
    # nodes, 11% vs 12% dropped-block rate) and dominates qwen2.5:32b-
    # instruct outright at either budget (~4x faster, more nodes, roughly a
    # quarter the drop rate) -- the new shipped default.
    "qwen3.6:35b": _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 32_000, 20_000, True),
}


class ModelCapsClient(Protocol):
    """Optional, narrow LLM capability: a live per-model capability lookup
    (Ollama's real /api/show endpoint, proxied through the orchestrator's
    /llm/show route) for any model NOT in `_MODEL_CAPS` below. Every entry
    in that table was populated by a human manually running /api/show ONCE
    per model and hardcoding the result -- an unknown model previously got
    the same blanket conservative guess regardless of what it actually is.
    This closes that gap for the fallback case only; a model already in
    `_MODEL_CAPS` is never second-guessed by a live lookup (see
    _resolve_caps's own docstring for why the static table stays
    authoritative where it exists: those numbers reflect real empirical
    coverage-quality tuning a generic derivation can't replicate)."""

    def show_model(self, model: str, user_id: str | None = None) -> dict: ...


# Process-lifetime cache -- a live show_model() call is a real HTTP round
# trip; the same unknown model name resolving repeatedly within one
# ingestion process (e.g. many jobs against the same non-cataloged model)
# should only ever pay that cost once.
_LIVE_MODEL_CAPS_CACHE: dict[str, _ModelCaps] = {}

# Same order of magnitude as this module's own hardcoded frontier entries
# (gpt-5.5, and the claude-opus/gpt-5 prefix fallback below) -- replaces
# NAME-PREFIX matching with a REAL measured threshold for an unrecognized
# model: at or above this, treat it as frontier-shaped (coverage budget ==
# full context, no lost-in-the-middle guard); below it, keep today's
# conservative local-model defaults, since no empirical A/B data exists
# for an arbitrary unknown local model the way it does for every entry
# already in _MODEL_CAPS.
_FRONTIER_SCALE_CONTEXT_THRESHOLD = 100_000


def _derive_caps_from_live_lookup(
    model: str, caps_client: ModelCapsClient, user_id: str | None = None,
) -> _ModelCaps:
    """Real gap closed here: an unknown model previously got the same
    blanket `context=28_000, coverage=_COVERAGE_BUDGET_TOKENS,
    supports_tools=False` guess regardless of what it actually is. Derives
    real caps from a live Ollama /api/show lookup instead -- context
    length from the model's own reported architecture context length,
    tool support from its own reported capabilities array. Any exception
    (network error, non-Ollama backend with no /api/show at all,
    malformed response) is caught by the CALLER (_resolve_caps), never
    here -- this function's job is only the derivation, not the fail-open
    fallback."""
    info = caps_client.show_model(model, user_id=user_id)
    context_length = info.get("context_length")
    context_budget_tokens = context_length if isinstance(context_length, int) and context_length > 0 else 28_000
    capabilities = info.get("capabilities") or []
    supports_tools = "tools" in capabilities
    if context_budget_tokens >= _FRONTIER_SCALE_CONTEXT_THRESHOLD:
        return _ModelCaps(100_000, context_budget_tokens, context_budget_tokens, supports_tools)
    return _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, context_budget_tokens, _COVERAGE_BUDGET_TOKENS, supports_tools)


def _resolve_caps(
    model: str | None, caps_client: ModelCapsClient | None = None, user_id: str | None = None,
) -> _ModelCaps:
    """Resolves a model name to its branch-size cap, context-token budget, and
    tool-calling support. Frontier models (production target, see
    build_survey_tree's docstring) get much larger caps/budgets since they run
    huge context windows.

    `caps_client` (optional, default None -- byte-identical to before this
    param existed, zero I/O) only ever applies to a model NOT already in
    `_MODEL_CAPS` and not matching the frontier name-prefix check: when
    supplied, a genuinely unknown model gets a REAL live-derived measurement
    (see _derive_caps_from_live_lookup) instead of the old blanket
    conservative guess, cached for the rest of this process's lifetime.
    Any failure from the live lookup (unreachable orchestrator, non-Ollama
    backend, malformed response) falls straight through to exactly today's
    static default -- this must never raise, never block a job."""
    if model and model in _MODEL_CAPS:
        return _MODEL_CAPS[model]
    if model and model.startswith(("claude-opus", "gpt-5")):
        return _ModelCaps(100_000, 150_000, 150_000, True)
    static_default = _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 28_000, _COVERAGE_BUDGET_TOKENS, False)
    if not model or caps_client is None:
        return static_default
    if model in _LIVE_MODEL_CAPS_CACHE:
        return _LIVE_MODEL_CAPS_CACHE[model]
    try:
        derived = _derive_caps_from_live_lookup(model, caps_client, user_id=user_id)
    except Exception:
        return static_default
    _LIVE_MODEL_CAPS_CACHE[model] = derived
    return derived
