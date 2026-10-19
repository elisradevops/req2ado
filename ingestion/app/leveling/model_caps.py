# app/leveling/model_caps.py
"""Per-model branch-size cap, context-token budget, and tool-calling
capability resolution (S12 -- extracted out of llm_leveling.py, whose
build_survey_tree is the sole real caller alongside app.main's /level route,
which resolves the SAME caps for num_ctx before constructing its
OrchestratorLlmClient)."""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import NamedTuple, Protocol

from app.config import settings
from app.leveling.live_context import notice

logger = logging.getLogger(__name__)

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


# --- Models by facts, not by name ----------------------------------------------------------------------------
# The proxy in front of the models lists them as `Provider/name` (`OpenAI/gpt-5.4`) and new models appear without a
# release of this service. Sizing therefore comes from (in order) an operator override, what the proxy states about
# the deployment, and a generation-based rule built from the vendors' documentation -- never from a fixed name list.

# Ceiling on any derived budget: the frontier ceiling already used for `claude-opus`/`gpt-5`. A 1M-token window is
# real, but one prompt that large is neither faster nor better, and the share below keeps room for the answer.
_FRONTIER_BUDGET_CEILING = 150_000
_CONTEXT_SHARE_FOR_PROMPT = 0.6
# Default answer budget; a model with a lower documented ceiling gets that instead.
DEFAULT_OUTPUT_TOKEN_BUDGET = 20_000

_PROVIDER_PREFIX = re.compile(r"^[^/]+/")
_DATE_SUFFIX = re.compile(r"-(?:\d{8}|\d{4}-\d{2}-\d{2})$")


def normalize_model_name(model: str | None) -> str:
    """`OpenAI/gpt-5.4` -> `gpt-5.4`, `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`, lower-cased."""
    if not model:
        return ""
    return _DATE_SUFFIX.sub("", _PROVIDER_PREFIX.sub("", model.strip())).lower()


@dataclass(frozen=True)
class FamilyFacts:
    """What the vendors document about a model family (not measured here)."""

    context_tokens: int
    input_tokens: int | None
    max_output_tokens: int
    reasoning: bool


_CLAUDE = re.compile(r"^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?")
_GPT = re.compile(r"^gpt-(\d+)(?:\.(\d+))?")


def family_facts(model: str | None) -> FamilyFacts | None:
    """Documented limits for a model recognised by its generation, or None. Sources: Anthropic models overview and
    context-window pages (Opus 4.6+/Sonnet 4.6+/5.x/Fable/Mythos: 1M context, 128k output; Sonnet 4.5 and Haiku 4.5:
    200k, 64k), Azure OpenAI model tables (gpt-4.1 1,047,576/32,768; gpt-5 line 400k with 272k input; gpt-5.4+ and
    gpt-6 1.05M with 922k input; all 128k output; `-chat` aliases 128k/16,384; gpt-oss 131,072/131,072)."""
    name = normalize_model_name(model)
    if not name:
        return None
    claude = _CLAUDE.match(name)
    if claude:
        tier, major, minor = claude.group(1), int(claude.group(2)), int(claude.group(3) or 0)
        if tier in ("fable", "mythos") or major >= 5:
            return FamilyFacts(1_000_000, 1_000_000, 128_000, True)
        if major == 4 and minor >= 6 and tier != "haiku":
            # Opus 4.6+ answers up to 128k tokens; Sonnet 4.6 up to 64k (the proxy's own model listing states 64,000).
            return FamilyFacts(1_000_000, 1_000_000, 128_000 if tier == "opus" else 64_000, True)
        if tier == "haiku":
            return FamilyFacts(200_000, 200_000, 64_000, False)
        return FamilyFacts(200_000, 200_000, 32_000 if tier == "opus" else 64_000, False)
    if name.startswith("claude-3"):
        return FamilyFacts(200_000, 200_000, 4_096, False)
    if name.startswith("gpt-oss"):
        return FamilyFacts(131_072, 131_072, 131_072, True)
    if name == "gpt-chat-latest" or re.match(r"^gpt-\d+(?:\.\d+)?-chat", name):
        return FamilyFacts(128_000, 111_616, 16_384, True)
    gpt = _GPT.match(name)
    if gpt:
        major, minor = int(gpt.group(1)), int(gpt.group(2) or 0)
        if major == 4 and minor == 1:
            return FamilyFacts(1_047_576, 1_047_576, 32_768, False)
        if major == 4:
            return FamilyFacts(128_000, 128_000, 16_384, False)
        if major >= 6 or (major == 5 and minor >= 4):
            small = major == 5 and minor == 4 and ("mini" in name or "nano" in name)
            return FamilyFacts(400_000, 272_000, 128_000, True) if small else FamilyFacts(1_050_000, 922_000, 128_000, True)
        if major == 5:
            return FamilyFacts(400_000, 272_000, 128_000, True)
    return None


def _prompt_budget(window_tokens: int) -> int:
    return min(_FRONTIER_BUDGET_CEILING, int(window_tokens * _CONTEXT_SHARE_FOR_PROMPT))


def _frontier_caps(window_tokens: int, supports_tools: bool) -> _ModelCaps:
    budget = _prompt_budget(window_tokens)
    return _ModelCaps(100_000, budget, budget, supports_tools)


def _profile_for(model: str | None) -> dict | None:
    """The operator's MODEL_PROFILES entry for this model, matched as sent, then normalised, case-insensitively."""
    if not model or not settings.model_profiles.strip():
        return None
    try:
        profiles = json.loads(settings.model_profiles)
    except ValueError:
        logger.warning("MODEL_PROFILES is not valid JSON; ignoring it")
        return None
    if not isinstance(profiles, dict):
        return None
    # A profile key matches the model as sent or with the provider prefix and date suffix removed, whichever form
    # the operator wrote.
    lowered: dict[str, dict] = {}
    for key, value in profiles.items():
        if isinstance(value, dict):
            lowered.setdefault(str(key).lower(), value)
            lowered.setdefault(normalize_model_name(str(key)), value)
    return lowered.get(model.lower()) or lowered.get(normalize_model_name(model))


def _apply_profile(caps: _ModelCaps, profile: dict) -> _ModelCaps:
    budget = profile.get("context_budget_tokens")
    budget = budget if isinstance(budget, int) and budget > 0 else caps.context_budget_tokens
    cap = profile.get("branch_cap")
    cap = cap if isinstance(cap, int) and cap > 0 else caps.branch_cap
    tools = profile.get("supports_tools")
    return _ModelCaps(cap, budget, budget if budget != caps.context_budget_tokens else caps.coverage_budget_tokens,
                      tools if isinstance(tools, bool) else caps.supports_tools)


# What the proxy stated about each model, remembered with the caps so the answer budget can use the model's own
# output ceiling without a second lookup (a client is built right after caps are resolved).
_LIVE_MAX_OUTPUT: dict[str, int] = {}


def output_token_budget(model: str | None) -> int:
    """The answer budget (`maxTokens`) for calls on this model: the default, or the model's stated ceiling when that
    is lower (an operator override first, then what the proxy reported, then the family's documented ceiling). Never
    larger than the default: a model that is not cut off needs no more, and one that is cut off by hidden reasoning is
    retried with more by the orchestrator."""
    profile = _profile_for(model)
    ceiling = profile.get("max_output_tokens") if profile else None
    if not isinstance(ceiling, int) or ceiling <= 0:
        ceiling = _LIVE_MAX_OUTPUT.get(model or "")
    if not ceiling:
        facts = family_facts(model)
        ceiling = facts.max_output_tokens if facts else None
    return min(DEFAULT_OUTPUT_TOKEN_BUDGET, ceiling) if ceiling else DEFAULT_OUTPUT_TOKEN_BUDGET


def _derive_caps_from_live_lookup(
    model: str, caps_client: ModelCapsClient, user_id: str | None = None,
) -> _ModelCaps | None:
    """Real caps from a live lookup instead of the blanket conservative guess. Two kinds of answer:

    * Ollama /api/show (no `source`): context length from the model's architecture key, tools from its capabilities
      -- unchanged from before, for local models.
    * A LiteLLM proxy (`source == "litellm"`): `context_length` is the deployment's stated INPUT limit; the budget is
      the prompt share of it, capped at the frontier ceiling. Tool support from the proxy only counts once
      TOOLS_FROM_MODEL_INFO is on. Returns None when the proxy states no limit (an alias it does not know), so the
      caller falls through to the family rule instead of caching "unknown".

    Any exception (network error, no such route, malformed response) is caught by the CALLER (_resolve_caps), never
    here -- this function's job is only the derivation, not the fail-open fallback."""
    info = caps_client.show_model(model, user_id=user_id)
    context_length = info.get("context_length")
    context_length = context_length if isinstance(context_length, int) and context_length > 0 else None
    capabilities = info.get("capabilities") or []
    max_output = info.get("max_output_tokens")
    if isinstance(max_output, int) and max_output > 0:
        _LIVE_MAX_OUTPUT[model] = max_output
    if info.get("source") == "litellm":
        if context_length is None:
            return None
        return _frontier_caps(context_length, "tools" in capabilities and settings.tools_from_model_info)
    context_budget_tokens = context_length if context_length is not None else 28_000
    supports_tools = "tools" in capabilities
    if context_budget_tokens >= _FRONTIER_SCALE_CONTEXT_THRESHOLD:
        return _ModelCaps(100_000, context_budget_tokens, context_budget_tokens, supports_tools)
    return _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, context_budget_tokens, _COVERAGE_BUDGET_TOKENS, supports_tools)


def _resolve_caps(
    model: str | None, caps_client: ModelCapsClient | None = None, user_id: str | None = None,
) -> _ModelCaps:
    """Resolves a model name to its branch-size cap, context-token budget, and tool-calling support, in this order:

    1. the hand-measured `_MODEL_CAPS` table (local models; never second-guessed);
    2. the `claude-opus*` / `gpt-5*` frontier shortcut on the name AS SENT (unchanged, proven in prod; tools on);
    3. a live lookup through `caps_client` (the proxy's model info, or Ollama /api/show), cached per process;
    4. the generation-based family rule (`family_facts`) on the normalised name -- `OpenAI/gpt-5.4`,
       `claude-sonnet-4-6`, `gpt-6-astra`, ... -- frontier-sized, tools only if TOOLS_FOR_KNOWN_FAMILIES is on;
    5. the conservative default.
    A MODEL_PROFILES entry for the model overrides whatever 1-5 produced. Never raises, never blocks a job."""
    caps = _resolve_base_caps(model, caps_client, user_id)
    profile = _profile_for(model)
    return _apply_profile(caps, profile) if profile else caps


def _resolve_base_caps(model: str | None, caps_client: ModelCapsClient | None, user_id: str | None) -> _ModelCaps:
    if model and model in _MODEL_CAPS:
        return _MODEL_CAPS[model]
    if model and model.startswith(("claude-opus", "gpt-5")):
        return _ModelCaps(100_000, 150_000, 150_000, True)
    if model and model in _LIVE_MODEL_CAPS_CACHE:
        return _LIVE_MODEL_CAPS_CACHE[model]
    if model and caps_client is not None:
        try:
            derived = _derive_caps_from_live_lookup(model, caps_client, user_id=user_id)
        except Exception:  # noqa: BLE001 -- fail open to the rules below; an unreachable lookup must never block a job
            derived = None
        if derived is not None:
            _LIVE_MODEL_CAPS_CACHE[model] = derived
            return derived
    facts = family_facts(model)
    if facts is not None:
        return _frontier_caps(facts.input_tokens or facts.context_tokens, settings.tools_for_known_families)
    static_default = _ModelCaps(_MAX_SURVEY_BRANCH_BLOCK_COUNT, 28_000, _COVERAGE_BUDGET_TOKENS, False)
    if model:
        notice("context_assumed", once_key=model, tokens=static_default.context_budget_tokens)
    return static_default
