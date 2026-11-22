# ingestion/app/survey/orchestrator_llm_client.py
from __future__ import annotations

import json
import logging
import re
import socket
import sys
import threading
import time
from collections.abc import Callable
from typing import Any, Literal

import httpx
from json_repair import repair_json
from opentelemetry import trace

from app.config import settings
from app.job_cancel import (
    BUDGET_REASON,
    JobCancelled,
    LlmBudgetExceeded,
    current_token,
    raise_if_cancelled,
)
from app.kb.profile import RubricText
from app.language_policy import (
    LanguagePolicy,
    checked_obligation_forms,
    dominant_script,
    script_name,
    writes_in_script,
)
from app.leveling.live_context import current_stage_counter, live_emitter_for, notice
from app.leveling.live_stream import DraftingDisplay
from app.leveling.llm_call_gate import gated
from app.leveling.model_caps import output_token_budget
from app.leveling.score_levels import (
    COMPLETENESS,
    STANDARD_REQUIREMENTS,
    builtin_categories,
    entry_from_votes,
    findings_for,
)
from app.logging_context import current_job_id
from app.otel import get_tracer
from app.prompts import resolve_version
from app.prompts.assembly import DataBlock, Fragment, PromptCall, PromptIdentity, build_call
from app.request_identity import user_scope
from app.survey._response_schemas import (
    CONFORMANCE_VERDICTS,
    acceptance_criteria_schema,
    checklist_definitions_schema,
    checklist_extraction_schema,
    document_study_schema,
    duplicate_pair_verdict_schema,
    file_rules_document_schema,
    file_rules_table_schema,
    kb_category_consolidation_schema,
    kb_document_profile_schema,
    kb_document_relevance_schema,
    obligation_forms_schema,
    root_group_names_schema,
    rule_conformance_schema,
    score_explanation_schema,
    sheet_study_schema,
    standard_requirements_schema,
    trace_links_schema,
)
from app.survey.keyed_calls import (
    KeyedEntries,
    KeyedMode,
    answered_by,
    describe_output,
    drop_possibly_cut_last_entry,
    mode_for,
    note_answered_by,
    output_lead,
    run_keyed,
    schema_for,
    wrap_scalar_entries,
)
from app.survey.keyed_specs import (
    AUTHOR_CONTENT_SPEC,
    KB_RELEVANCE_SPEC,
    PAIR_VERDICTS,
    PARAMETER_PAIR_SPEC,
    PARENT_SUMMARY_SPEC,
    SCORING_SPEC,
    SYNTHESIS_SPEC,
    TITLE_TAGS_SPEC,
)
from app.survey.llm_cache import LlmResponseCache, payload_key
from app.workitem.model import MODEL_KEY, PROMPT_KEY, RequirementTag

logger = logging.getLogger(__name__)
_tracer = get_tracer()

_NATIVE_ADO_LINK_PREFIXES = ("System.", "Microsoft.VSTS.")
# From this infer_trace_links version on, the answer names a node target and a cited identifier in separate fields.
_SPLIT_TARGET_VERSION = 5
# From this judge_rule_conformance version on, the verdict may say the rule does not apply to an item.
_NOT_APPLICABLE_VERSION = 2


def _is_native_ado_link_type(reference_name: str) -> bool:
    return reference_name.startswith(_NATIVE_ADO_LINK_PREFIXES)


_JSON_FENCE_PATTERN = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```$", re.DOTALL)
# Same fence shape, NOT anchored to the whole string -- confirmed live (real
# job failure, qwen3.6:35b via analyze_section_agentic): unlike the other
# schema-constrained calls in this module, the agentic tool-calling path
# gets a free-form conversational reply, so nothing stops the model from
# prefacing the fence with prose ("Based on the analysis... here is the
# synthesized work-item tree:\n\n```json\n{...}\n```") -- the anchored
# pattern above never matches that shape at all, and the caller's
# subsequent raw_decode() then fails on the leading prose, crashing the
# whole SURVEY job.
_JSON_FENCE_ANYWHERE_PATTERN = re.compile(r"```(?:json)?\s*\n?(.*?)\n?```", re.DOTALL)
# A reasoning model's thinking put in front of the reply text: `<think>...</think>` (Ollama/qwen without a separate reasoning field) or Open WebUI's
# `<details type="reasoning">...</details>`. It can hold braces of its own, so the bracket search below would start inside it; only LEADING blocks
# are removed, so a JSON value that merely mentions such a tag is untouched.
_LEADING_REASONING_PATTERN = re.compile(
    r"^\s*(?:<think>.*?</think>|<details\b[^>]*\btype=[\"']reasoning[\"'][^>]*>.*?</details>)", re.DOTALL | re.IGNORECASE
)

# httpx's default timeout (5s total) is far too short for a real local LLM —
# observed directly: a 12b-class Ollama model took several minutes to over
# ten minutes for a single cold-start inference depending on GPU/CPU
# contention on this box (subsequent warm calls are much faster, but the
# first call in a job's lifetime is not guaranteed warm, and Ollama evicts
# an idle model from memory after a few minutes by default).
#
# Sourced from settings (config.py) rather than a bare literal so it can be
# tuned per-deployment without a code change -- same numeric default as
# before this was configurable. See config.py's own doc comment for this
# rung's place in the wider SURVEY call ladder.
_LLM_REQUEST_TIMEOUT_SECONDS = settings.llm_request_timeout_seconds
# Returned by _chat_json_streaming when the call must be made the plain way.
_NOT_STREAMED = object()


# extract_quality_checklist: a checklist definition is a small,
# self-contained part of a document (a table or short list), not something
# that needs whole-document comprehension -- caps worst-case input size for
# this structured-extraction call. ~12,000 chars covers several pages of
# real checklist content with margin.
_CHECKLIST_EXTRACTION_MAX_CHARS = 12_000

# extract_quality_checklist's own output sanity bounds -- a real checklist
# is a short, named list of categories, not prose. Guards two distinct
# failure modes at once: (1) untrusted KB document text steering the
# extraction into returning something huge/garbled (security-adjacent --
# this stored value is replayed verbatim into every future scoring prompt
# for documents citing this KB source), and (2) a nonsense extraction (too
# few/many items) silently corrupting every later scoring call, since
# _parse_category_scores only validates score VALUES, never that the KEYS
# are sensible.
_CHECKLIST_MIN_ITEMS = 2
_CHECKLIST_MAX_ITEMS = 30
_CHECKLIST_MIN_ITEM_CHARS = 2
# extract_quality_checklist_definitions's own per-item bound -- a stated
# definition/pass-condition is prose, not a bare category name, so this is
# deliberately much larger than _CHECKLIST_MAX_ITEM_CHARS below (which
# bounds the NAME used verbatim as a categoryScores key -- see that
# method's own docstring for why names must stay short). Over-length
# values are TRUNCATED, not dropped (see _sanitize_checklist_definitions),
# since a trimmed real quote is still useful, unlike a malformed score.
_CHECKLIST_DEFINITION_MAX_CHARS = 280
_CHECKLIST_MAX_ITEM_CHARS = 60

# Retry policy for a TRANSIENT /llm/chat failure only (429/5xx) -- confirmed
# real gap: a single 500 from the LLM backend (observed live, host under
# memory pressure) previously killed an entire multi-hour SURVEY job
# outright, with zero retry anywhere in the whole chain (orchestrator's own
# OpenAI client has maxRetries:0 by deliberate design -- see
# openwebui.client.ts's own comment on why a non-idempotent, multi-minute
# call must never be blindly retried at that layer). This is NOT that same
# mistake: retries are bounded (2 extra attempts, not a storm), scoped to
# 429/5xx only (never a successful-but-slow response), and
# sit ABOVE the per-chunk fail-open safety nets in scoring.py/id_tree_builder.py
# -- most transient blips should never even reach those nets now.
#
# One exception: a 429 the orchestrator marks as already retried is NOT retried again here. The orchestrator waits out the provider's
# Retry-After and repeats a rate-limited call itself (upstream-negotiation.ts), and only marks the 429 it still got after its last repeat;
# sending that call a third and fourth time multiplied every rate-limited call (up to 3 x 3 sends) and spent a token quota faster.
# A 429 without the mark was given up on early (no time or attempts left), so it is still retried here.
_RETRYABLE_CHAT_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
# The text the orchestrator puts in front of such a 429 (orchestrator upstream-negotiation.ts RATE_LIMIT_EXHAUSTED_CODE).
_RATE_LIMIT_RETRIED_CODE = "RATE_LIMIT_RETRIED"
_MAX_CHAT_RETRY_ATTEMPTS = 3
# How long the orchestrator may spend on one document-study window, its output-limit raises included (ms): inside the study's own budgets.
_STUDY_CALL_DEADLINE_MS = 600_000
_CHAT_RETRY_BACKOFF_SECONDS = (2.0, 8.0)
# A retryable status that arrives only AFTER the call has already run this
# long is not a transient blip: it is a call that hung (an upstream that
# returned an empty reply or dropped the connection around the ~300 s mark --
# prod job 0b9a134f lost ~15 minutes per scoring batch re-sending an identical
# request three times, twice). Re-sending the same request only multiplies the
# wait, so the failure is returned to the caller, which can split the work
# into smaller calls instead. Fast failures keep the 2 s / 8 s backoff.
_SLOW_FAILURE_SECONDS = 120.0


def _strip_json_fence(content: str) -> str:
    """Local models (Ollama included — the golden test's real target) often
    wrap JSON in markdown fences despite being explicitly told not to. Strip
    a single leading/trailing fence if present; otherwise return unchanged.
    Cheap insurance against a single fenced response failing an entire job.
    Leading reasoning blocks are removed first (see _LEADING_REASONING_PATTERN)."""
    stripped = content
    while (reasoning := _LEADING_REASONING_PATTERN.match(stripped)) is not None:
        stripped = stripped[reasoning.end() :]
    stripped = stripped.strip()
    match = _JSON_FENCE_PATTERN.match(stripped)
    if match:
        return match.group(1).strip()
    match = _JSON_FENCE_ANYWHERE_PATTERN.search(stripped)
    if match:
        return match.group(1).strip()
    # Confirmed real failure, live (infer_trace_links, qwen3.6:35b, the
    # largest single-call payload in this module -- 554 nodes serialized):
    # the model prefaced its reply with bare prose and NO markdown fence at
    # all ("Based on the provided nodes..."), so neither fence pattern
    # above matches, and the caller's raw_decode() then fails at position 0
    # on the word "Based" -- crashing trace-link inference for the whole
    # job. Same "no prose" instruction violation the fence-anywhere pattern
    # already tolerates, just without the fence. If the content doesn't
    # already start with a JSON value, find the first '[' or '{' and slice
    # from there -- if no bracket exists anywhere, return unchanged so
    # _parse_json_object still raises its own honest error rather than
    # silently returning something meaningless.
    if stripped[:1] not in ("[", "{"):
        bracket_positions = [i for i in (stripped.find("["), stripped.find("{")) if i != -1]
        if bracket_positions:
            return stripped[min(bracket_positions) :].strip()
    return stripped


def _parse_json_object(content: str):
    """Local models occasionally append stray trailing content after an
    otherwise complete, valid JSON value (observed live: qwen3:4b emitting
    one extra closing brace). A plain `json.loads` rejects the whole
    response even though the actual JSON value is intact. `raw_decode`
    parses only the first valid JSON value and reports where it stopped,
    so trailing garbage after a genuinely complete value no longer fails
    the whole job. A response that's malformed from the start (e.g. cut off
    mid-value) still raises -- this is tolerance for trailing noise, not a
    truncation fix.

    One further tolerance, confirmed live and deterministic at
    temperature=0 against a real 679-block AirPro document: an
    object-wrapped-array `responseSchema` (section_analysis_schema, see
    analyze_section) can make Ollama's grammar-constrained decoder stop
    generation exactly ONE character short of complete valid JSON -- the
    "nodes" array itself closes correctly, but the outer object's own
    final closing brace is never emitted. Appending a single '}' and
    retrying recovers the full, otherwise well-formed response (verified:
    all 19 nodes parsed correctly once appended). This is a targeted
    tolerance for this ONE confirmed failure shape, not a general
    auto-repair engine -- a response malformed for any other reason still
    raises exactly as before.

    A third tolerance, also confirmed live and deterministic at
    temperature=0 against a real AirPro branch: the same grammar-constrained
    decoder can omit a single NODE object's own closing brace right before
    the "nodes" array's closing bracket -- e.g. `..."tags": [...]\n  ]\n}`
    instead of `..."tags": [...]\n  }\n  ]\n}`. `json.JSONDecodeError.pos`
    marks exactly where this happens: parsing the node's object hits the
    array's closing `]` where a `,` or `}` was expected. Narrowly scoped to
    this exact shape -- only retried when the error message is literally
    "Expecting ',' delimiter" AND the offending character is `]` -- inserting
    a single '}' at that position closes the truncated node object and lets
    the rest of the response parse correctly.

    A final, general-purpose fallback (json_repair, only reached once every
    narrower tolerance above has already failed): confirmed live against a
    real AirPro job that a model can embed bare, unescaped double quotes
    INSIDE a string value for emphasis -- e.g. `"...storing the "Power-ON"
    Event..."` -- which breaks the string mid-value and produces the same
    "Expecting ',' delimiter" message as the third tolerance above, but at a
    position no single-character positional fix can repair (the string
    needs re-escaping, not a missing brace). Rather than writing a new
    narrow, positional heuristic for every fresh malformation shape a local
    model happens to produce (the pattern the three tolerances above
    already show), a mature, purpose-built repair library is used as the
    LAST resort -- deliberately last, since it's a general fixer rather
    than a confirmed, understood failure shape. Its output is validated
    (must be a dict or list) before being trusted; anything else still
    raises exactly as before."""
    try:
        obj, _end = json.JSONDecoder().raw_decode(content)
    except json.JSONDecodeError as exc:
        try:
            obj, _end = json.JSONDecoder().raw_decode(content + "}")
        except json.JSONDecodeError:
            if exc.msg == "Expecting ',' delimiter" and content[exc.pos : exc.pos + 1] == "]":
                repaired = content[: exc.pos] + "}" + content[exc.pos :]
                try:
                    obj, _end = json.JSONDecoder().raw_decode(repaired)
                    return obj
                except json.JSONDecodeError:
                    pass
            try:
                obj = repair_json(content, return_objects=True)
            except Exception:
                raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
            if not isinstance(obj, (dict, list)):
                raise ValueError(f"malformed JSON in LLM response content: {content!r}") from exc
            return obj
    return obj


# Scoring asks each batch twice (app.leveling.score_levels.entry_from_votes); the second vote sees the same items in reverse order, so at
# temperature 0 the two are still independent readings: an item whose levels change with its place in the batch is a low-confidence score.
SCORING_VOTES = 2


def _scoring_category_names(category_checklist: list[str]) -> list[str]:
    """The category names the scoring call's <category_names> block lists: the organization's checklist plus the completeness check, which
    is always judged (a model that follows the list literally drops a category that is only mentioned in prose). Never twice."""
    names = list(category_checklist)
    if not any(name.strip().casefold() == COMPLETENESS for name in names):
        names.append(COMPLETENESS)
    return names


# fragment_scoring_levels_{builtin,derived} from v2 on take the built-in categories from code: only those the organization's standard
# requires (app.leveling.score_levels.STANDARD_REQUIREMENTS). An older file names all five itself, so deleting v2 rolls back cleanly.
_STANDARD_LEVELS_VERSION = 2


def _and_list(names: list[str]) -> str:
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def _scoring_category_fragment(
    category_checklist: list[str] | None,
    kb_context: str | None,
    requires: frozenset[str] = frozenset(),
) -> Fragment:
    """The `categories` paragraph of the requirement-scoring prompt, a fragment prompt file per source of the category names, in priority
    order:
    1. `category_checklist` -- a FIXED, pre-extracted list (genuinely deterministic across runs), listed in the <category_names> block;
    2. `kb_context` present but no stored checklist -- best-effort live derivation from that material (NOT guaranteed identical across
       runs -- a live judgment call);
    3. neither -- the built-in categories.
    Each one ends with the completeness_as_requirement anchors, which are always judged. `requires`: what the organization's standard
    requires; a built-in category it does not require is not asked for."""
    completeness = Fragment("fragment_scoring_completeness")
    if category_checklist:
        count = len(_scoring_category_names(category_checklist))
        return Fragment(
            "fragment_scoring_levels_checklist",
            {"entry_count": str(count), "completeness": completeness},
        )
    builtin = list(builtin_categories(requires))
    if kb_context:
        if resolve_version("fragment_scoring_levels_derived") < _STANDARD_LEVELS_VERSION:
            return Fragment("fragment_scoring_levels_derived", {"completeness": completeness})
        return Fragment(
            "fragment_scoring_levels_derived",
            {"builtin_names": _and_list(builtin), "completeness": completeness},
        )
    if resolve_version("fragment_scoring_levels_builtin") < _STANDARD_LEVELS_VERSION:
        return Fragment("fragment_scoring_levels_builtin", {"completeness": completeness})
    anchors: dict[str, str | Fragment] = {
        f"{category}_anchor": Fragment(f"fragment_scoring_anchor_{category}") if name in requires else ""
        for name, (category, _issue) in STANDARD_REQUIREMENTS.items()
    }
    return Fragment(
        "fragment_scoring_levels_builtin",
        {
            "entry_count": str(len(builtin) + 1),
            "category_names": _and_list([*builtin, COMPLETENESS]),
            **anchors,
            "completeness": completeness,
        },
    )


def _text_of(value: object) -> str:
    """Every string inside a payload entry, one per line: the source text an answer about that entry was written from."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return "\n".join(_text_of(v) for v in value.values())
    if isinstance(value, list):
        return "\n".join(_text_of(v) for v in value)
    return ""


def _in_source_script(
    label: str, source_of: Callable[[str], str], fields: tuple[str, ...]
) -> Callable[[str, object], bool]:
    """A keyed call's `accept` check (app.survey.keyed_calls.run_keyed): every text field of the entry is written in the script of the
    source it was written from (app.language_policy.writes_in_script). A refused entry is asked once more; refused again, the caller
    keeps its own text, and this log line is all that is said about it."""

    def accept(node_id: str, entry: object) -> bool:
        if not isinstance(entry, dict):
            return True
        source = source_of(node_id)
        ok = all(
            writes_in_script(entry[f], source) for f in fields if isinstance(entry.get(f), str)
        )
        if not ok:
            logger.warning(
                "%s: the answer for %s is not written in its source's script; not used", label, node_id
            )
        return ok

    return accept


def _tag_prompt(entries: object, identity: PromptIdentity | None, model: str | None) -> None:
    """Tags every answer entry with the prompt that produced it and the model that answered (app.workitem.model.record_prompt reads the
    tag where an answer is applied to a work item). The model is the one the entry notes (MODEL_KEY: one, or several for an entry built
    from several answers), else the one a router named for this thread's last call, else `model`, the one the call asked for."""
    if not isinstance(entries, dict):
        return
    default = answered_by() or model
    for entry in entries.values():
        if not isinstance(entry, dict):
            continue
        noted = entry.pop(MODEL_KEY, None)
        if identity is None:
            continue
        models = noted if isinstance(noted, list) else [noted or default]
        tags = [{**identity.as_dict(), **({"model": by} if by else {})} for by in dict.fromkeys(models)]
        entry[PROMPT_KEY] = tags[0] if len(tags) == 1 else tags


def _routed_model_of(body: object) -> str | None:
    """The model a router (the gateway's `Auto`) sent the call to, from the orchestrator's `routing` field; None when it named none."""
    routing = body.get("routing") if isinstance(body, dict) else None
    model = routing.get("model") if isinstance(routing, dict) else None
    return model if isinstance(model, str) and model else None


def _routed_model(response: httpx.Response) -> str | None:
    try:
        return _routed_model_of(response.json())
    except ValueError:  # not JSON: the caller reports that answer itself
        return None


def _abort_in_flight(client: httpx.Client) -> None:
    """Ends a request another thread is blocked on. `Client.close()` alone does not: closing a socket does not wake a thread already
    reading from it, so the call would sit until the model answered. Shutting the socket down does, and the orchestrator then sees its
    caller go. Reaches into the transport's pool (httpx has no public way to do this); anything unexpected there falls back to close()."""
    try:
        for connection in list(client._transport._pool.connections):  # type: ignore[attr-defined]
            stream = getattr(getattr(connection, "_connection", None), "_network_stream", None)
            sock = stream.get_extra_info("socket") if stream is not None else None
            if sock is not None:
                sock.shutdown(socket.SHUT_RDWR)
    except Exception:  # noqa: BLE001 -- a connection that already ended, or a transport without a pool (a test double)
        pass
    client.close()


# The text the orchestrator puts in front of a budget refusal (orchestrator upstream-negotiation.ts BUDGET_EXCEEDED_CODE).
_BUDGET_CODE = "LLM_BUDGET_EXCEEDED"


def _budget_detail(response: httpx.Response) -> str:
    """The refusal's own wording (it starts with the code), from the orchestrator's JSON error body or the raw text."""
    try:
        message = response.json().get("message")
    except Exception:  # noqa: BLE001 -- not JSON: the text is still the answer
        message = None
    text = message if isinstance(message, str) else response.text
    return " ".join(text.split())[:500]


def _ledger_stage() -> str:
    """The pipeline stage a /llm/chat call belongs to, for the orchestrator's per-job token ledger: the name of the nearest
    public OrchestratorLlmClient method on the call stack (`score_requirements_for_document`, `propose_acceptance_criteria`, ...).
    Read from the stack so no call site has to name its stage; "other" when the call did not come from such a method."""
    frame = sys._getframe(1)
    while frame is not None:
        code = frame.f_code
        # The method itself, not a helper nested inside it (those also see `self`), so compare against the class's own code object.
        if not code.co_name.startswith("_") and getattr(
            getattr(OrchestratorLlmClient, code.co_name, None), "__code__", None
        ) is code:
            return code.co_name
        frame = frame.f_back
    return "other"


class OrchestratorLlmClient:
    """SURVEY mode's real LLM client. Calls the orchestrator's POST
    /llm/chat proxy — NEVER calls Open WebUI/Ollama directly, per the
    'backend proxy, redact-first' architecture boundary in
    docs/architecture.md's Locked Decisions.

    Every method's system prompt instructs the model to return strict JSON;
    a malformed response raises ValueError rather than silently returning
    an empty/wrong result, since a caller acting on invalid LLM output is
    worse than a loud failure."""

    def __init__(
        self,
        base_url: str,
        bearer_token: str,
        model: str | None = None,
        num_ctx: int | None = None,
        top_k: int | None = None,
        min_p: float | None = None,
        # Defaults to a fixed value (unlike num_ctx/top_k/min_p above, which
        # default to None/opt-in) -- pinning the sampler's RNG has no
        # downside/cost tradeoff the way a larger context window or a
        # model-specific repetition mitigation does, so every construction
        # site gets it automatically rather than needing to opt in one by
        # one. Real gap this closes: NO call site anywhere in this module
        # set a seed before this, and temperature=0 alone does not give
        # run-to-run determinism under llama.cpp/Ollama (batch/KV-cache
        # nondeterminism + tie-breaking) -- confirmed via the orchestrator's
        # own openwebui.client.ts, which already forwards `seed` into the
        # request but had nothing upstream of it ever supplying one. Pass
        # seed=None explicitly to opt OUT for a caller that genuinely wants
        # varied sampling (none exists today).
        seed: int | None = 42,
        # S11: caches analyze_section/score_requirements_for_document --
        # see LlmResponseCache's own
        # docstring. None (the default) disables caching entirely, matching
        # pre-cache behavior exactly -- every existing construction site
        # (module-level singletons in main.py that never touch these three
        # methods, and any test not exercising caching) is unaffected.
        cache: LlmResponseCache | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        # Per-job model override (see /level's `model` query param) -- when
        # unset, the orchestrator's own /llm/chat proxy falls back to its
        # configured LLM_CHAT_MODEL default, matching pre-model-selection
        # behavior exactly.
        self._model = model
        # The Open WebUI file the file-conventions study attaches to its calls (set by the /prestudy route for the one request); None attaches nothing.
        self.study_file_id: str | None = None
        # Set by the /prestudy route when the user asked to read the file again: the study asks the model afresh instead of reusing kept answers.
        self.study_fresh = False
        # The answer budget for this model: the default, or its stated output ceiling when that is lower (e.g. the
        # 16,384-token `-chat` aliases). See app.leveling.model_caps.output_token_budget.
        self._max_output_tokens = output_token_budget(model)
        # Ollama's actual runtime context window (§6 of the whole-document
        # redesign) -- originally forwarded only on analyze_section/
        # analyze_section_agentic, the two calls the §3 whole-document gate
        # actually depends on being backed by a real, large-enough context
        # window. Confirmed missing (a real bug, not a deliberate omission)
        # on score_requirements_for_document/infer_trace_links/
        # judge_kb_relevance -- without it, Ollama silently truncates any
        # of those calls' input to its own small default regardless of
        # actual size, very likely the real cause of the "Quality scoring
        # returned no valid score for N node(s)" warning class. Now
        # forwarded on all five real LLM calls in this module. Sized by the
        # caller (app.main's /level route) from the SAME _resolve_caps(model)
        # budget build_survey_tree itself gates on. None (the default) omits
        # the field entirely, matching pre-num_ctx behavior exactly.
        self._num_ctx = num_ctx
        # Gemma4 repetition-collapse mitigation (confirmed upstream bug,
        # ollama/ollama#15502/#15783 -- see orchestrator's
        # LlmChatOptions.topK/minP doc comment for the full citation and why
        # repeat_penalty does NOT work as a substitute). Forwarded on the
        # same two calls as num_ctx above -- the long free-text holistic
        # analysis is exactly where the collapse was observed live. None
        # (the default) omits both fields entirely, matching pre-mitigation
        # behavior exactly.
        self._top_k = top_k
        self._min_p = min_p
        self._seed = seed
        # Set by /level when the user's KB profile has content (app.kb.profile.render_authoring_standard); None leaves every
        # prompt that writes an item exactly as it was.
        self.authoring_standard: str | None = None
        # Set by /level for the job (app.language_policy): the document's main script and how its requirements state an obligation.
        self.language_policy = LanguagePolicy()
        # The prompt of the last call this thread made through _chat_json, for tagging a keyed call's answers (_run_keyed_by_script).
        # Per thread: a job's chunks run in parallel on one client.
        self._last_call = threading.local()
        # Set from the user's KB profile (app.kb.profile.standard_requires): what the organization's standard requires beyond the
        # built-in scoring categories. Empty: no standard, so neither the active voice nor a rationale is judged.
        self.standard_requires: frozenset[str] = frozenset()
        self._cache = cache
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam
        # How long one call waits for the orchestrator's answer. None: the configured LLM_REQUEST_TIMEOUT_SECONDS (a job's calls run
        # for minutes). An on-demand call whose caller stops waiting sets it just past its own cap, so the connection ends with it
        # instead of the call running on with its answer thrown away.
        self.request_timeout_seconds: float | None = None

    @property
    def model(self) -> str | None:
        """Public read-only accessor for the per-job model override -- exists
        purely so llm_leveling.py's narration (`_fire`/`getattr(client,
        'model', None)`) can surface which model is doing the work on the
        running page, without this class needing to know narration exists."""
        return self._model

    def _standard_blocks(self) -> list[DataBlock]:
        """The organization's authoring standard (app.kb.profile.render_authoring_standard) as a data block, for a prompt that writes a
        work item's title or description; none when the user's KB profile has no content."""
        return [DataBlock("org_standard", self.authoring_standard)] if self.authoring_standard else []

    def _language(
        self, obligations: bool = False, script: str | None = None
    ) -> tuple[list[Fragment], list[DataBlock]]:
        """The output-language policy of a prompt that writes text (app.language_policy): the rule fragment, and for a prompt that writes
        requirements (`obligations`) the obligation form. The form is the organization's or the document's own words, so it travels as a
        data block with that authority, never inside the instructions. `script`: the script of the text this call rewrites, when it has
        one; otherwise the job's (a section in another language than most of the document is written in its own)."""
        policy = self.language_policy
        script = script or policy.script
        after = [
            Fragment("fragment_output_language", {"script": script_name(script)})
            if script
            else Fragment("fragment_output_language_unknown")
        ]
        blocks: list[DataBlock] = []
        forms, forms_from = policy.forms_for(script)
        if obligations and forms:
            from_kb = forms_from == "kb"
            after.append(
                Fragment(
                    "fragment_obligation_form",
                    {
                        "forms_from": "the organization's standard"
                        if from_kb
                        else "this document's own usage"
                    },
                )
            )
            blocks.append(
                DataBlock(
                    "org_standard" if from_kb else "source",
                    "\n".join(forms),
                    tag="obligation_forms",
                )
            )
        return after, blocks

    def _params(
        self,
        schema: dict | None = None,
        max_tokens: int | None = None,
        budget_kind: Literal["study"] | None = None,
        file_id: str | None = None,
    ) -> dict:
        """Everything in a /llm/chat body except the messages: the model and its parameters, the schema and the limits."""
        return {
            "temperature": 0,
            **({"model": self._model} if self._model else {}),
            **({"responseSchema": schema} if schema is not None else {}),
            # An Open WebUI file the orchestrator uploaded for this call (the pre-study's hybrid route): the model reads the file's full text beside the
            # profile in the message. Only the file-conventions study sets it.
            **({"fileId": file_id} if file_id else {}),
            # Structured extraction over text already in the prompt, not open-ended reasoning: hidden reasoning cost 3-10x the wall clock with no
            # accuracy benefit (confirmed live on every call in this module).
            "think": False,
            "maxTokens": self._max_output_tokens if max_tokens is None else max_tokens,
            **(
                {"budgetKind": budget_kind, "deadlineMs": _STUDY_CALL_DEADLINE_MS}
                if budget_kind
                else {}
            ),
            # Without numCtx, Ollama silently truncates the input to its own small default (see LlmChatOptions.numCtx).
            **({"numCtx": self._num_ctx} if self._num_ctx else {}),
            **({"topK": self._top_k} if self._top_k else {}),
            **({"minP": self._min_p} if self._min_p else {}),
            **({"seed": self._seed} if self._seed is not None else {}),
        }

    def _post_chat(self, call: PromptCall, params: dict, user_id: str | None) -> httpx.Response:
        """POSTs `call` with `params` to /llm/chat with a short, bounded retry for a transient
        backend error (429/5xx) only -- see _RETRYABLE_CHAT_STATUS_CODES'
        own module-level doc comment for why this exists and why it's safe
        (bounded, status-gated, layered above the existing per-chunk
        fail-open nets rather than replacing them). Every one of this
        class's /llm/chat call sites should route through this instead of
        constructing its own httpx.Client + raw post -- callers still call
        `.raise_for_status()` themselves afterward, unchanged.

        `user_id` -- the orchestrator now requires an X-Req2Ado-User-Id
        header identifying which user's vaulted Open WebUI credential to
        use (no shared/global fallback credential exists any more); a
        request with a valid bearer token but a missing/unknown header is
        rejected with 401. MUST be a per-call parameter, never stored on
        `self` -- this class is constructed as a module-level singleton
        shared across every concurrent request the process handles (see
        main.py's _dedup_judge_client/_checklist_client), so storing it on
        the instance would leak one user's identity into a concurrent
        request from a different user. Omitted from the header entirely
        when falsy, mirroring how every other optional field in this
        module is conditionally included -- never sent as an empty
        string."""
        payload = call.payload(params)
        logger.info("/llm/chat call: prompt=%s", call.identity)
        trace.get_current_span().set_attribute("req2ado.prompt", str(call.identity))
        response: httpx.Response | None = None
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        if user_id:
            headers["X-Req2Ado-User-Id"] = user_id
        # Names the job and stage so the orchestrator can add this call's token usage to the job's ledger. Only sent inside a job.
        job_id = current_job_id()
        if job_id:
            headers["X-Req2Ado-Job-Id"] = job_id
            headers["X-Req2Ado-Stage"] = _ledger_stage()
        for attempt in range(_MAX_CHAT_RETRY_ATTEMPTS):
            raise_if_cancelled()  # a job whose caller is gone makes no further model calls
            with gated():  # a lease (when a gate is set) covers this one attempt, not the back-off sleep below; the wait for it is not "elapsed"
                started = time.monotonic()
                with httpx.Client(
                    transport=self._transport,
                    timeout=self.request_timeout_seconds or _LLM_REQUEST_TIMEOUT_SECONDS,
                ) as client:
                    # A cancelled run closes this connection, so the orchestrator sees its caller go and stops the upstream request: a window
                    # already sent no longer keeps the model (and its lease) busy for minutes after the job was cancelled.
                    token = current_token()
                    unregister = (
                        token.on_cancel(lambda: _abort_in_flight(client))
                        if token is not None
                        else (lambda: None)
                    )
                    try:
                        response = client.post(
                            f"{self._base_url}/llm/chat",
                            json=payload,
                            headers=headers,
                        )
                    except Exception:
                        raise_if_cancelled()  # the closed connection surfaces as a transport error: report it as the cancel it is
                        raise
                    finally:
                        unregister()
            if response.status_code == 402 and _BUDGET_CODE in response.text:
                # The provider's token budget is used up (the orchestrator already stopped at the first refusal). Every further call of
                # this run would be refused too, so the run is stopped: its token is cancelled with this reason and /level answers 402.
                # Outside a run (no token: chat, a rescore) the response goes back as it was and the caller reports the 402.
                token = current_token()
                if token is not None:
                    detail = _budget_detail(response)
                    token.cancel(BUDGET_REASON, detail)
                    raise LlmBudgetExceeded(detail)
                return response
            if response.status_code not in _RETRYABLE_CHAT_STATUS_CODES:
                if response.is_success:
                    note_answered_by(_routed_model(response))
                return response
            if response.status_code == 429 and _RATE_LIMIT_RETRIED_CODE in response.text:
                return response  # already waited out and repeated by the orchestrator: the callers' own rate-limit handling takes it from here
            if payload.get("budgetKind") == "study" and response.status_code == 504:
                return response  # the study reads a 504 as an overloaded backend and leaves that window unread; another identical request only adds to the load
            elapsed = time.monotonic() - started
            if elapsed >= _SLOW_FAILURE_SECONDS:
                logger.warning(
                    "/llm/chat returned %d after %.0fs -- not re-sending an identical request that already ran "
                    "that long (the caller can split it into smaller calls)",
                    response.status_code,
                    elapsed,
                )
                return response
            if attempt < _MAX_CHAT_RETRY_ATTEMPTS - 1:
                logger.warning(
                    "/llm/chat returned %d (attempt %d/%d) -- retrying after %.0fs",
                    response.status_code,
                    attempt + 1,
                    _MAX_CHAT_RETRY_ATTEMPTS,
                    _CHAT_RETRY_BACKOFF_SECONDS[attempt],
                )
                notice("server_retry", status=response.status_code)
                time.sleep(_CHAT_RETRY_BACKOFF_SECONDS[attempt])
        assert response is not None  # loop always runs >=1 iteration
        return response

    def _chat_json_streaming(
        self,
        call: PromptCall,
        params: dict,
        user_id: str | None,
        display: DraftingDisplay,
    ) -> Any:
        """Same call as `_chat_json`'s plain path, read as a stream so the screen
        can show what the model is writing (job transparency, B7). The text it
        collects is parsed by the very same `_strip_json_fence` +
        `_parse_json_object` the plain path uses, so the result is identical; the
        observer only feeds the display.

        Returns `_NOT_STREAMED` (the caller then makes the ordinary call, which
        keeps its own retry ladder) when streaming was not possible: the request
        failed or was refused before any output arrived, the stream broke part
        way (the lane is cleared first), or it ended without the terminal line
        that proves the answer is complete."""
        raise_if_cancelled()
        logger.info("/llm/chat/stream call: prompt=%s", call.identity)
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        if user_id:
            headers["X-Req2Ado-User-Id"] = user_id
        parts: list[str] = []
        finished = False
        got_output = False
        finish_reason: str | None = None
        try:
            timeout = self.request_timeout_seconds or _LLM_REQUEST_TIMEOUT_SECONDS
            with httpx.Client(transport=self._transport, timeout=timeout) as client:
                with client.stream(
                    "POST",
                    f"{self._base_url}/llm/chat/stream",
                    json={**call.payload(params), "includeDone": True},
                    headers=headers,
                ) as response:
                    if response.is_error:
                        notice("stream_fallback", reason="refused")
                        return _NOT_STREAMED
                    for line in response.iter_lines():
                        if not line:
                            continue
                        got_output = True
                        message = json.loads(line)
                        if message.get("done"):
                            finished = True
                            finish_reason = message.get("finishReason")
                            note_answered_by(_routed_model_of(message))
                            if message.get("finishReason") == "length":
                                logger.warning(
                                    "Streamed structured LLM call ended with finishReason=length -- the answer may be incomplete"
                                )
                                notice(
                                    "output_limit_reached",
                                    "warning",
                                    with_last_item=True,
                                    step="drafting",
                                )
                            continue
                        delta = message.get("delta")
                        if delta:
                            parts.append(delta)
                            display.feed(delta)
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Streamed /llm/chat/stream call failed, using the plain call: %s", exc)
            notice("stream_fallback", reason="stream_error")
            if got_output:
                display.reset()
            return _NOT_STREAMED
        if not finished:
            logger.warning("Streamed call ended without its terminal line, using the plain call")
            notice("stream_fallback", reason="no_terminal_line")
            display.reset()
            return _NOT_STREAMED
        parsed = _parse_json_object(_strip_json_fence("".join(parts)))
        return drop_possibly_cut_last_entry(parsed) if finish_reason == "length" else parsed

    def _chat_json(
        self,
        call: PromptCall,
        params: dict,
        *,
        user_id: str | None = None,
        stream_inputs: dict[str, str | None] | None = None,
        stream_stage: str | None = None,
    ) -> Any:
        """Sends a built call and parses its JSON answer: the shared request + response-parsing shape for this class's simple,
        single-shot structured-extraction calls (schema in, JSON object/array out, no caching, no tracing span, no truncation
        tracking). `schema=None` omits `responseSchema` entirely (see infer_trace_links's own comment on the array-schema
        grammar-cost cliff this supports). `user_id` -- see _post_chat's own docstring; forwarded straight through, never stored.

        `stream_inputs` (row id -> the owner's text for it) marks a drafting
        call that may be streamed for the live screen: it is, only when both
        LIVE_PROGRESS and LLM_STREAM_DRAFTING are on and the job has a live
        emitter. Otherwise this is exactly the plain call it always was. `params` comes from `_params`, built once by the caller
        so a cached call's key (`payload_key`) covers exactly the body sent."""
        self._last_call.identity = call.identity
        emitter = (
            live_emitter_for(current_job_id())
            if stream_inputs is not None and settings.live_progress and settings.llm_stream_drafting
            else None
        )
        if emitter is not None:
            display = DraftingDisplay(
                emitter,
                stream_inputs or {},
                stage=stream_stage,
                counter=current_stage_counter(),
            )
            try:
                display.start()
                parsed = self._chat_json_streaming(call, params, user_id, display)
            finally:
                display.end()
            if parsed is not _NOT_STREAMED:
                return parsed
        response = self._post_chat(call, params, user_id)
        response.raise_for_status()
        body = response.json()
        finish_reason = body.get("finishReason")
        if finish_reason and finish_reason not in ("stop", "tool_calls"):
            # A normal answer ends "stop". Anything else (typically "length")
            # means the output may be incomplete -- logged so an empty or
            # partial keyed answer is no longer unexplained.
            logger.warning(
                "Structured LLM call ended with finishReason=%s -- the answer may be incomplete",
                finish_reason,
            )
        if params.get("budgetKind") == "study" and finish_reason == "length":
            # Never read a cut-off study answer as a studied window: the caller splits it (partial) or skips it (empty).
            from app.leveling.document_study import StudyLengthCutoff

            raise StudyLengthCutoff(empty=not (body.get("content") or "").strip())
        content = _strip_json_fence(body["content"])
        parsed = _parse_json_object(content)
        return drop_possibly_cut_last_entry(parsed) if finish_reason == "length" else parsed

    def infer_trace_links(
        self,
        nodes: list[dict],
        link_type_catalog: list[dict],
        kb_context: str | None = None,
        user_id: str | None = None,
    ) -> list[dict]:
        sorted_catalog = sorted(
            link_type_catalog,
            key=lambda entry: not _is_native_ado_link_type(entry["reference_name"]),
        )
        catalog_lines = "\n".join(
            f'- {entry["reference_name"]} ("{entry["name"]}")'
            + (f": {entry['semantic_hint']}" if entry.get("semantic_hint") else "")
            for entry in sorted_catalog
        )
        # The link-type names and hints come from the organization's ADO process (and its KB), so they are data: a block, not the prompt.
        call = build_call(
            "infer_trace_links",
            blocks=[
                *([DataBlock("reference", kb_context)] if kb_context is not None else []),
                DataBlock("source", catalog_lines, tag="link_types"),
                DataBlock("source", json.dumps(nodes, ensure_ascii=False)),
            ],
        )
        # Now schema-constrained via trace_links_schema() -- wrapped in an
        # object ({"links": [...]}), not a top-level array, to avoid the
        # same grammar-cost cliff documented in _response_schemas.py's
        # module docstring (a maxItems-bounded top-level array wedged the
        # server for 10+ minutes on a real ~200-item branch; this schema
        # has no maxItems, same as section_analysis_schema()). numCtx IS
        # forwarded (via _chat_json, when configured) -- this call
        # serializes EVERY node in the whole tree (the source block above), the
        # largest single payload in this module, making it the most
        # exposed call to Ollama's silent prompt truncation without an
        # explicit num_ctx (see LlmChatOptions.numCtx's own doc comment).
        # think=False: relationship inference over already-generated nodes
        # is structured extraction, not open-ended reasoning -- same
        # confirmed-live finding (3-10x wall-clock cost, no accuracy
        # benefit) as analyze_section/analyze_section_agentic and
        # score_requirements_for_document.
        # v5 asks for the node target and the cited identifier in separate fields; the schema follows the prompt version (rollback-safe).
        split_target = resolve_version("infer_trace_links") >= _SPLIT_TARGET_VERSION
        result = self._chat_json(
            call, self._params(schema=trace_links_schema(split_target)), user_id=user_id
        )
        return result.get("links", []) if isinstance(result, dict) else []

    def score_requirements_for_document(
        self,
        descriptions_by_node_id: dict[str, str],
        criteria_context: str | None = None,
        kb_context: str | None = None,
        category_checklist: list[str] | None = None,
        user_id: str | None = None,
        standard_requires: frozenset[str] | None = None,
    ) -> dict[str, dict]:
        """Batched quality scoring: every node's FINAL description judged in one call per vote. The model returns a level (0-4, anchored
        in the prompt) per category with the words that support it, and the problems it finds with the words they concern; code turns
        that into the entry the scoring code reads ({"score", "issues", "categoryScores", "confidence"}), see
        app.leveling.score_levels.entry_from_votes. A node no vote answered is absent.

        `kb_context` is either the organization's own rubric (app.kb.profile.RubricText, from its profile), sent as a `rubric` block the
        prompt makes authoritative, or knowledge-base chunks retrieved for the document, sent as `reference`. `criteria_context` (see
        app.quality.criteria_retrieval.CriteriaRetriever) is retrieved reference criteria. `category_checklist` (see
        app.kb.checklist_extraction or the profile), when supplied, is a FIXED list of category names -- a cross-run determinism
        guarantee (the SAME document run 4 times must yield the SAME categories). The job's obligation form
        (app.language_policy) tells the completeness judgment how this text states an obligation, in any language.
        `standard_requires` is what the organization's standard requires beyond the built-in categories
        (app.leveling.score_levels.STANDARD_REQUIREMENTS); None: the client's own (set from the user's KB profile).

        Each vote's raw answer is response-cached on its own exact request (a complete answer only), and the scores are computed after
        the cache, so a change to how code scores never serves an old result."""
        spec = SCORING_SPEC
        if standard_requires is None:
            standard_requires = self.standard_requires
        is_rubric = isinstance(kb_context, RubricText)
        policy = self.language_policy
        forms = policy.obligation_forms
        from_kb = policy.forms_from == "kb"

        def build(descriptions: dict, mode: KeyedMode) -> tuple[PromptCall, dict]:
            if kb_context is None:
                before: list[str] = []
            elif is_rubric:
                before = ["fragment_scoring_rubric"]
            else:
                before = [
                    "fragment_kb_scoring_rubric_fixed"
                    if category_checklist
                    else "fragment_kb_scoring_rubric"
                ]
            after: list[str | Fragment] = [
                *(["fragment_scoring_criteria"] if criteria_context else []),
                *(
                    [
                        Fragment(
                            "fragment_scoring_obligation_form",
                            {"forms_from": "the organization's standard" if from_kb else "this document"},
                        )
                    ]
                    if forms
                    else []
                ),
            ]
            call = build_call(
                "score_requirements_for_document",
                markers={
                    "output_lead": output_lead(spec, mode),
                    "category_instruction": _scoring_category_fragment(
                        category_checklist, kb_context, standard_requires
                    ),
                    "findings": ", ".join(findings_for(standard_requires)),
                    "node_count": str(len(descriptions)),
                },
                before=before,
                after=after,
                blocks=[
                    *(
                        [DataBlock("rubric" if is_rubric else "reference", kb_context)]
                        if kb_context is not None
                        else []
                    ),
                    *(
                        [DataBlock("reference", criteria_context, tag="criteria")]
                        if criteria_context
                        else []
                    ),
                    *(
                        [
                            DataBlock(
                                "source",
                                json.dumps(
                                    _scoring_category_names(category_checklist), ensure_ascii=False
                                ),
                                tag="category_names",
                            )
                        ]
                        if category_checklist
                        else []
                    ),
                    *(
                        [
                            DataBlock(
                                "org_standard" if from_kb else "source",
                                "\n".join(forms),
                                tag="obligation_forms",
                            )
                        ]
                        if forms
                        else []
                    ),
                    DataBlock("source", json.dumps(descriptions, ensure_ascii=False)),
                ],
            )
            # think=False (in _params): a reasoning-capable model (qwen3.6:35b) burned hidden chain-of-thought tokens before ANY output,
            # for every item in one call, with no accuracy benefit on this structured-extraction task. numCtx (in _params): without it
            # Ollama silently truncates the input, so the tail of a large batch is never seen.
            return call, self._params(schema=schema_for(spec, mode))

        def send(descriptions: dict, mode: KeyedMode) -> object:
            call, params = build(descriptions, mode)
            # Wall time + payload size per call, so a real job's logs show whether call duration scales with chunk size.
            request_chars = len(json.dumps(call.payload(params)))
            started_at = time.monotonic()
            with _tracer.start_as_current_span("score_requirements_for_document") as span:
                span.set_attribute("gen_ai.request.model", self._model or "default")
                span.set_attribute("gen_ai.operation.name", "chat")
                span.set_attribute("req2ado.node_count", len(descriptions))
                response = self._post_chat(call, params, user_id)
                elapsed_seconds = time.monotonic() - started_at
                logger.info(
                    "score_requirements_for_document: %d node(s), %d request char(s), %.1fs wall time",
                    len(descriptions),
                    request_chars,
                    elapsed_seconds,
                )
                response.raise_for_status()
                body = response.json()
                parsed = _parse_json_object(_strip_json_fence(body["content"]))
            if body.get("finishReason") == "length":
                # The entry the token limit cut off may parse but be wrong; it is treated as not scored.
                parsed = drop_possibly_cut_last_entry(parsed)
            return parsed

        def vote(number: int) -> dict:
            ordered = list(descriptions_by_node_id.items())
            batch = dict(reversed(ordered) if number % 2 else ordered)
            key = None
            if self._cache is not None:
                # The key is the request this vote sends first (the whole batch, in its order and in the mode it starts in).
                first_call, first_params = build(batch, mode_for(spec, self._model))
                key = payload_key(first_call.payload(first_params), "vote", number)
                cached = self._cache.get(key)
                if isinstance(cached, dict):
                    logger.info("score_requirements_for_document: vote %d cache hit", number)
                    return cached
            entries = run_keyed(send, batch, spec, model=self._model)
            # Only a complete answer is reused: a cached partial one would repeat the same gap on every re-run.
            if key is not None and not entries.missing:
                self._cache.set(key, dict(entries))
            return dict(entries)

        votes: list[dict] = []
        for number in range(SCORING_VOTES):
            try:
                votes.append(vote(number))
            except JobCancelled:
                raise
            except Exception:
                if number == 0:
                    raise  # the first vote failing is the call failing: the caller's split-and-retry handles it
                logger.warning(
                    "score_requirements_for_document: vote %d failed; confidence comes from one vote",
                    number,
                    exc_info=True,
                )
        identity = build(descriptions_by_node_id, mode_for(spec, self._model))[0].identity
        result: dict[str, dict] = {}
        for node_id, text in descriptions_by_node_id.items():
            entry = entry_from_votes(
                [v.get(node_id) for v in votes],
                text,
                requires=standard_requires,
                builtin=not category_checklist,
            )
            if entry is not None:
                # One tag per model whose vote went into the entry: votes a router sent to different models are both recorded.
                entry[MODEL_KEY] = [
                    vote.get(MODEL_KEY) or self._model for vote in (v.get(node_id) for v in votes) if isinstance(vote, dict)
                ]
                result[node_id] = entry
        _tag_prompt(result, identity, self._model)
        return result

    def extract_quality_checklist(
        self, document_text: str, user_id: str | None = None
    ) -> list[str]:
        """Runs ONCE per document, at KB ingestion time (see
        app.kb.ingest_service), never per scoring call -- the real fix for a
        confirmed real determinism gap (user-reported): asking the scoring
        model to "derive" categoryScores key names live, per call, is not a
        cross-run guarantee even at temperature=0. Extracting the checklist
        ONCE and storing it (KbVectorStore.upsert_chunk's quality_checklist
        param) makes the category set a genuine property of the ingested
        document -- every later scoring call reads the stored value instead
        of ever re-deriving it, so the SAME document run any number of times
        yields the SAME categories, guaranteed.

        Returns [] (not None) when the document genuinely defines no
        checklist -- a real, storable "checked, found nothing" signal,
        distinct from extraction never having run at all (see
        KbVectorStore.get_quality_checklist's own docstring for why that
        distinction matters). Capped input length: a checklist definition
        is a small, self-contained part of a document; this is structured
        extraction, not whole-document comprehension."""
        source = document_text[:_CHECKLIST_EXTRACTION_MAX_CHARS]
        call = build_call("extract_quality_checklist", blocks=[DataBlock("source", source)])
        parsed = self._chat_json(
            call,
            self._params(schema=checklist_extraction_schema(), max_tokens=2000),
            user_id=user_id,
        )
        # The schema asks for {"categories": [...]}; a model that still answers with the bare array is accepted.
        if isinstance(parsed, dict) and isinstance(parsed.get("categories"), list):
            parsed = parsed["categories"]
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return self._sanitize_checklist(parsed)

    def _sanitize_checklist(self, raw_items: list[str]) -> list[str]:
        """Strips/dedups/bounds a structurally-valid (list-of-strings)
        checklist extraction before it's stored and replayed into every
        future scoring prompt. Returns [] -- the module's existing "checked,
        found nothing" signal -- when the sanitized result falls outside a
        sane checklist shape, rather than raising: a bad extraction should
        degrade the same way "this document defines no checklist" already
        does, not fail the KB ingestion job it's part of. An empty input
        (the model's own genuine "no checklist here" response) returns []
        immediately, without a warning -- that is the correct, expected
        outcome, not a sanitization failure."""
        if not raw_items:
            return []
        seen_lower: set[str] = set()
        cleaned: list[str] = []
        for raw_item in raw_items:
            item = " ".join(
                raw_item.split()
            )  # strips whitespace, collapses/rejects embedded newlines
            if not (_CHECKLIST_MIN_ITEM_CHARS <= len(item) <= _CHECKLIST_MAX_ITEM_CHARS):
                continue
            item_lower = item.lower()
            if item_lower in seen_lower:  # case-insensitive dedup, first-seen casing/order kept
                continue
            seen_lower.add(item_lower)
            cleaned.append(item)
        if not (_CHECKLIST_MIN_ITEMS <= len(cleaned) <= _CHECKLIST_MAX_ITEMS):
            logger.warning(
                "extract_quality_checklist produced %d usable item(s) after sanitization "
                "(raw count %d) -- outside the sane [%d, %d] range, treating as "
                "'no checklist found': %r",
                len(cleaned),
                len(raw_items),
                _CHECKLIST_MIN_ITEMS,
                _CHECKLIST_MAX_ITEMS,
                cleaned[:3],
            )
            return []
        return cleaned

    def extract_quality_checklist_definitions(
        self,
        document_text: str,
        category_names: list[str],
        user_id: str | None = None,
    ) -> dict[str, str]:
        """Best-effort SECOND extraction pass, run once at KB ingestion time
        immediately AFTER extract_quality_checklist (see
        app.kb.ingest_service), never replacing it and never run on its
        own -- `category_names` is that method's own already-sanitized,
        cross-run-deterministic output (the FIXED categoryScores key list,
        see score_requirements_for_document's own docstring for why those
        names are used VERBATIM as dict keys downstream). This pass asks the
        SAME document for whatever definition/explanation/pass-condition
        text it states for each of those ALREADY-DECIDED names -- it does
        NOT attempt to name the categories itself -- specifically so the
        returned dict's keys line up with category_names by construction,
        instead of risking a second, independent extraction drifting to
        slightly different wording for the same category (e.g.
        "Unambiguous" vs "Unambiguity") and silently failing to match up
        with the scores the reviewer actually sees.

        Returns {} (not None) for "ran, found no stated definition text for
        any of these categories" -- a document that lists only bare
        category names with no separate explanation is a genuine, common,
        EXPECTED outcome (org checklists vary widely in how much they
        write per category), not a failure. A category absent from the
        returned dict falls back to QualityGauge's generic description on
        the frontend, indistinguishable from a genuine no-checklist-at-all
        case -- see app.leveling.scoring._match_category_checklist."""
        if not category_names:
            return {}
        # The category names were extracted from the same knowledge-base document, so they are data, not instructions.
        call = build_call(
            "extract_quality_checklist_definitions",
            blocks=[
                DataBlock("source", json.dumps(category_names, ensure_ascii=False), tag="category_names"),
                DataBlock("source", document_text[:_CHECKLIST_EXTRACTION_MAX_CHARS]),
            ],
        )
        parsed = self._chat_json(
            call,
            self._params(schema=checklist_definitions_schema(), max_tokens=2000),
            user_id=user_id,
        )
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return self._sanitize_checklist_definitions(parsed, category_names)

    def _sanitize_checklist_definitions(
        self, raw: dict, category_names: list[str]
    ) -> dict[str, str]:
        """Tolerant of a model returning extra/misspelled keys (dropped,
        never trusted -- see extract_quality_checklist_definitions's own
        docstring for why matching against the FIXED category_names,
        case-insensitively, is safer than trusting the model's own key
        spelling verbatim) or a non-string value (dropped, same tolerant
        philosophy as _parse_category_scores). Values are TRUNCATED to
        _CHECKLIST_DEFINITION_MAX_CHARS, not dropped when over-length -- a
        trimmed real quote is still useful. An empty (whitespace-only)
        value is dropped, same as a missing one -- both mean "no real
        definition text for this category"."""
        valid_lower = {name.strip().lower(): name for name in category_names}
        result: dict[str, str] = {}
        if not isinstance(raw, dict):
            return result
        for key, value in raw.items():
            if not isinstance(key, str) or not isinstance(value, str):
                continue
            canonical_name = valid_lower.get(key.strip().lower())
            if canonical_name is None:
                continue
            definition = " ".join(value.split())  # strips whitespace, collapses embedded newlines
            if not definition:
                continue
            result[canonical_name] = definition[:_CHECKLIST_DEFINITION_MAX_CHARS]
        return result

    def _by_script(
        self, payload: dict[str, Any], source_of: Callable[[str], str]
    ) -> list[tuple[str | None, dict[str, Any]]]:
        """`payload` split by the script each entry's own source is written in (its dominant script; the job's when it has no counted
        words), in a fixed order. A batched prompt names one output language, so a document with sections in two languages asks once
        per language; a single-language document is one group, and its request is the same as before."""
        groups: dict[str | None, dict[str, Any]] = {}
        for key, item in payload.items():
            script = dominant_script(source_of(key)) or self.language_policy.script
            groups.setdefault(script, {})[key] = item
        return sorted(groups.items(), key=lambda group: group[0] or "")

    def _run_keyed_by_script(
        self,
        send: Callable[[dict, KeyedMode, str | None], object],
        payload: dict[str, Any],
        spec: Any,
        source_of: Callable[[str], str],
        fields: tuple[str, ...],
    ) -> KeyedEntries:
        """run_keyed once per script group (_by_script), each asked in its group's language and checked against its own source's
        script; the groups' entries are returned as one result over every requested id."""
        accept = _in_source_script(spec.name, source_of, fields)
        results = []
        for script, group in self._by_script(payload, source_of):
            used: list[PromptIdentity] = []

            def sent(part: dict, mode: KeyedMode, script: str | None = script) -> object:
                answer = send(part, mode, script)
                used.append(self._last_call.identity)
                return answer

            result = run_keyed(sent, group, spec, model=self._model, accept=accept)
            _tag_prompt(result, used[0] if used else None, self._model)
            results.append(result)
        if len(results) == 1:
            return results[0]
        merged: dict[str, Any] = {}
        for result in results:
            merged.update(result)
        return KeyedEntries(
            merged,
            list(payload),
            mode=results[-1].mode,
            degraded=any(result.degraded for result in results),
        )

    def title_and_tags_for_rows(
        self,
        texts_by_row_id: dict[str, str],
        user_id: str | None = None,
    ) -> dict[str, dict]:
        """Backs the TitleTagClient protocol (id_tree_builder.py) -- the
        deterministic-hierarchy path's optional per-document title/tag
        enhancement pass. Confirmed real gap: `main.py`'s /level call site
        never actually constructed and passed a real TitleTagClient, so
        every deterministically-built node kept its raw
        extract_baseline_title-derived title (e.g. "The P." from "The P. S
        shall include electronic fuses...") and empty tags in production,
        even though `_apply_title_tag_pass` was fully built and tested.

        `texts_by_row_id` maps each deterministic leaf's own id to its
        (verbatim, unsynthesized) description text. Returns row_id ->
        {'title': str, 'tags': list[str]} -- a short, scannable title and
        zero or more RequirementTag values. Purely an enhancement:
        `_apply_title_tag_pass` already fails open on any exception or
        malformed/partial response, keeping the deterministic title/empty
        tags exactly as constructed."""
        spec = TITLE_TAGS_SPEC

        def send(payload: dict, mode: KeyedMode, script: str | None) -> object:
            # The output-format sentence and the strict schema are both generated from `spec`
            # (app.survey.keyed_calls), so the prompt and the schema cannot drift; a retry of
            # omitted ids re-enters here with just those ids.
            after, language_blocks = self._language(script=script)
            call = build_call(
                "title_and_tags_for_rows",
                markers={
                    "tag_vocabulary": ", ".join(t.value for t in RequirementTag),
                    "row_count": str(len(payload)),
                    "output_format": describe_output(spec, mode),
                },
                blocks=[
                    *self._standard_blocks(),
                    *language_blocks,
                    DataBlock("source", json.dumps(payload, ensure_ascii=False)),
                ],
                after=after,
            )
            return self._chat_json(
                call,
                self._params(schema=schema_for(spec, mode)),
                user_id=user_id,
                stream_inputs=dict(payload),
                stream_stage="improve",
            )

        return self._run_keyed_by_script(
            send, texts_by_row_id, spec, lambda row_id: _text_of(texts_by_row_id[row_id]), ("title",)
        )

    def summarize_parent_nodes(
        self,
        nodes_by_id: dict[str, dict],
        user_id: str | None = None,
    ) -> dict[str, dict]:
        """Backs the ParentSummaryClient protocol (id_tree_builder.py) --
        the deterministic-hierarchy path's Epic/Feature title+description
        enhancement pass. Confirmed real gap, live: an Epic/Feature's
        title AND description were both `extract_baseline_title(heading_text)`
        -- a verbatim copy of the source document's own section heading,
        identical to each other (e.g. both "Over 28V VDC input"), never
        touched by any LLM call -- TitleTagClient only ever reaches
        Requirement leaves.

        `nodes_by_id` maps each Epic/Feature node's own id to
        {'title': str (its current, possibly-verbatim title),
        'requirement_titles': list[str], 'requirement_descriptions':
        list[str]} -- EVERY descendant Requirement leaf's text, however
        deeply nested underneath this node (NOT just direct children --
        see _collect_descendant_requirement_texts's own docstring for
        why: the spec allows a Requirement nested under another
        Requirement, or an Epic nested under another Epic, and this
        node's real scope is everything underneath it, not just its
        immediate children). Returns node_id -> {'title': str,
        'description': str} -- title framed as
        ADO's own Epic ("large portfolio-level strategic goal") or Feature
        ("capability delivering direct user value") definition, description
        a DISTINCT 1-2 sentence summary of what the children collectively
        deliver, never identical to title. Purely an enhancement:
        `_apply_parent_summary_pass` already fails open on any exception or
        malformed/partial response, keeping the verbatim heading title and
        description exactly as constructed."""
        spec = PARENT_SUMMARY_SPEC

        def send(payload: dict, mode: KeyedMode, script: str | None) -> object:
            after, language_blocks = self._language(script=script)
            call = build_call(
                "summarize_parent_nodes",
                markers={
                    "node_count": str(len(payload)),
                    "output_format": describe_output(spec, mode),
                },
                blocks=[
                    *self._standard_blocks(),
                    *language_blocks,
                    DataBlock("source", json.dumps(payload, ensure_ascii=False)),
                ],
                after=after,
            )
            return self._chat_json(
                call,
                self._params(schema=schema_for(spec, mode)),
                user_id=user_id,
                stream_inputs={
                    k: v.get("title") if isinstance(v, dict) else None for k, v in payload.items()
                },
                stream_stage="summarize",
            )

        return self._run_keyed_by_script(
            send,
            nodes_by_id,
            spec,
            lambda node_id: _text_of(nodes_by_id[node_id]),
            ("title", "description"),
        )

    def synthesize_leaf_requirements(
        self,
        items_by_id: dict[str, dict],
        user_id: str | None = None,
    ) -> dict[str, dict]:
        """Backs the SynthesisClient protocol (id_tree_builder.py) -- the
        actual quality fix for the deterministic-hierarchy path's
        fragment-as-requirement problem (confirmed real, live: raw
        spec-table cells and headings like "Size: 3U 1\"" or "Over-current"
        were being emitted as standalone Requirement work items with zero
        synthesis). Reuses the exact instruction already proven in
        `_SECTION_ANALYSIS_SYSTEM_PROMPT` for the LLM-analysis path
        ("bullet/spec lists, tables synthesize into coherent requirements,
        NOT one requirement per line") -- this is the one place the
        deterministic path currently skips that synthesis entirely.

        `items_by_id` maps each flagged leaf's own id to {'text': its
        verbatim source text, 'context': a " > "-joined string of its
        parent chain's titles, root first -- informational only, not
        itself part of what gets judged}. Returns id -> {'title': str,
        'text': str, 'tags': list[str]} -- a synthesized, properly-formed
        requirement statement plus a short title and zero or more
        RequirementTag values. Purely an enhancement:
        `_apply_synthesis_pass` already fails open on any exception or
        malformed/partial response, keeping the flagged leaf's verbatim
        source text exactly as constructed."""
        spec = SYNTHESIS_SPEC

        def send(payload: dict, mode: KeyedMode, script: str | None) -> object:
            # The tag vocabulary is part of the generated output-format sentence (it comes from the same
            # field list as the schema), so it is not passed as a separate marker.
            after, language_blocks = self._language(obligations=True, script=script)
            call = build_call(
                "synthesize_leaf_requirements",
                markers={
                    "row_count": str(len(payload)),
                    "output_format": describe_output(spec, mode),
                },
                blocks=[
                    *self._standard_blocks(),
                    *language_blocks,
                    DataBlock("source", json.dumps(payload, ensure_ascii=False)),
                ],
                after=after,
            )
            return self._chat_json(
                call,
                self._params(schema=schema_for(spec, mode)),
                user_id=user_id,
                stream_inputs={
                    k: v.get("text") if isinstance(v, dict) else None for k, v in payload.items()
                },
                stream_stage="draft",
            )

        return self._run_keyed_by_script(
            send, items_by_id, spec, lambda row_id: _text_of(items_by_id[row_id]), ("title", "text")
        )

    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict:
        """Backs the job-document study (app.leveling.document_study): what one window states about its glossary, unresolved-value
        markers, verification wording, cited standards, table roles and list lead-ins. Returns the raw object; the caller drops every
        entry the window text does not contain. Not cached here: the per-user app.leveling.study_store keeps what a run studied."""
        source = json.dumps({"text": window_text}, ensure_ascii=False)
        call = build_call("study_document", blocks=[DataBlock("source", source)])
        parsed = self._chat_json(
            call,
            self._params(schema=document_study_schema(), max_tokens=3000, budget_kind="study"),
            user_id=user_id,
        )
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return parsed

    def study_spreadsheet(self, sample: dict, user_id: str | None = None) -> dict:
        """Backs app.leveling.sheet_study: how one sheet is laid out (which rows are headings, which column holds the id, the title, the
        text, the sections), from a bounded sample of it. Returns the model's answer as a dict; the caller checks every number in it
        against the sheet, so an answer is never trusted for its columns, only used once they fit."""
        call = build_call(
            "study_spreadsheet", blocks=[DataBlock("source", json.dumps(sample, ensure_ascii=False))]
        )
        params = self._params(schema=sheet_study_schema(), max_tokens=1500)
        key = None
        if self._cache is not None and user_id:  # a call without a user id shares no cached answer
            key = payload_key(call.payload(params), user_scope(user_id))
            cached = self._cache.get(key)
            if cached is not None:
                return cached
        parsed = self._chat_json(call, params, user_id=user_id)
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        if key is not None:
            self._cache.set(key, parsed)
        return parsed

    def _study_file_rules(
        self,
        name: str,
        schema: dict,
        required: str,
        sample: dict,
        user_id: str | None,
        vote: int,
        accept: Callable[[dict], bool] | None,
    ) -> dict:
        """One ask of the file-conventions pre-study (study/model_rules.py). `vote` only keeps repeated asks of one sample apart in the response
        cache, so each vote is a real second opinion; it is never sent to the model. The caller checks every number and value in the answer against
        the file, so an answer is used only once it fits; `accept` is that check, and only an answer it accepts is kept for reuse (a refused answer
        is asked again next time, not replayed). `study_fresh` skips the kept answer. `required` is the answer's first key: a reply that wraps the
        answer in a single outer key ({"result": {...}}) is unwrapped."""
        call = build_call(name, blocks=[DataBlock("source", json.dumps(sample, ensure_ascii=False))])
        # A study call: an answer cut off at the output limit is raised once by the orchestrator, and one still cut off raises StudyLengthCutoff
        # (this vote fails, reported) instead of being read as a partial answer.
        params = self._params(
            schema=schema, max_tokens=2000, budget_kind="study", file_id=self.study_file_id
        )
        key = None
        if self._cache is not None and user_id:  # a call without a user id shares no cached answer
            key = payload_key(call.payload(params), user_scope(user_id), vote)
            cached = None if self.study_fresh else self._cache.get(key)
            if isinstance(cached, dict) and accept is not None and accept(cached):
                return cached
        parsed = self._chat_json(call, params, user_id=user_id)
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        if required not in parsed and len(parsed) == 1:
            inner = next(iter(parsed.values()))
            if isinstance(inner, dict) and required in inner:
                parsed = inner
        if key is not None and accept is not None and accept(parsed):
            self._cache.set(key, parsed)
        return parsed

    def study_file_rules_table(
        self, sample: dict, user_id: str | None = None, vote: int = 0, accept: Callable[[dict], bool] | None = None
    ) -> dict:
        """Backs app.study.model_rules: how one table states its items' types, levels, parents and fields, from a bounded sample of it."""
        return self._study_file_rules(
            "study_file_rules_table", file_rules_table_schema(), "sheet_kind", sample, user_id, vote, accept
        )

    def study_file_rules_document(
        self, sample: dict, user_id: str | None = None, vote: int = 0, accept: Callable[[dict], bool] | None = None
    ) -> dict:
        """Backs app.study.model_rules: how a document's headings state their item types, from a bounded outline of it."""
        return self._study_file_rules(
            "study_file_rules_document", file_rules_document_schema(), "type_source", sample, user_id, vote, accept
        )

    def propose_acceptance_criteria(
        self,
        items_by_id: dict[str, dict],
        user_id: str | None = None,
        background: str | None = None,
    ) -> dict[str, dict]:
        """Backs app.leveling.acceptance_criteria: proposed criteria (with assumptions, or "needs author input") for requirements the
        scorer flagged as lacking them. Returns {node_id: entry}; entries for ids that were not asked about are dropped, a missing id
        is simply absent (the caller leaves that description alone). `background` is the job's context primer: a background block,
        context only, never a source of values. A document with requirements in two languages is asked once per language
        (_by_script)."""
        result: dict[str, dict] = {}
        for script, group in self._by_script(items_by_id, lambda node_id: _text_of(items_by_id[node_id].get("text"))):
            result.update(self._propose_acceptance_criteria_in(script, group, user_id, background))
        return result

    def _propose_acceptance_criteria_in(
        self, script: str | None, items_by_id: dict[str, dict], user_id: str | None, background: str | None
    ) -> dict[str, dict]:
        after, language_blocks = self._language(script=script)
        call = build_call(
            "propose_acceptance_criteria",
            blocks=[
                *([DataBlock("background", background)] if background else []),
                *language_blocks,
                DataBlock("source", json.dumps(items_by_id, ensure_ascii=False)),
            ],
            after=after,
        )
        params = self._params(schema=acceptance_criteria_schema(), max_tokens=4000)
        identity = call.identity
        key = None
        if self._cache is not None and user_id:  # a call without a user id shares no cached answer
            key = payload_key(call.payload(params), user_scope(user_id))
            cached = self._cache.get(key)
            if cached is not None:
                return cached
        parsed = self._chat_json(call, params, user_id=user_id)
        entries = parsed.get("items") if isinstance(parsed, dict) else None
        if not isinstance(entries, list):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        result = {
            entry["id"]: entry
            for entry in entries
            if isinstance(entry, dict)
            and isinstance(entry.get("id"), str)
            and entry["id"] in items_by_id
        }
        _tag_prompt(result, identity, self._model)
        if key is not None and len(result) == len(items_by_id):
            self._cache.set(key, result)
        return result

    def find_obligation_forms(self, sample: str, user_id: str | None = None) -> list[str]:
        """How the document's own requirements state an obligation (app.language_policy.obligation_sample is the text read): at most
        three phrases, each one the sample really contains. Asked only when the organization's profile states no obligation form.
        Response-cached on the exact request, so the same document gets the same answer and every later prompt stays the same."""
        call = build_call("find_obligation_forms", blocks=[DataBlock("source", sample)])
        params = self._params(schema=obligation_forms_schema(), max_tokens=1000)
        key = None
        if self._cache is not None and user_id:  # a call without a user id shares no cached answer
            key = payload_key(call.payload(params), user_scope(user_id))
            cached = self._cache.get(key)
            if isinstance(cached, list):
                return cached
        parsed = self._chat_json(call, params, user_id=user_id)
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        forms = checked_obligation_forms(parsed.get("obligation_forms"), sample)
        if key is not None:
            self._cache.set(key, forms)
        return forms

    def judge_duplicate_pair(
        self,
        candidate_text: str,
        matched_text: str,
        user_id: str | None = None,
    ) -> dict:
        """Backs the DuplicateJudgeClient protocol
        (check_for_duplicates.py) -- verifies a >=threshold embedding
        match against ADO's own vector store before trusting it as a real
        duplicate. Real gap closed here: `all-minilm` (this codebase's
        configured EMBED_MODEL) is a small, general-purpose sentence
        embedding -- confirmed real false-positive risk for two
        topically-adjacent but SCOPALLY DISTINCT short phrases (e.g. "UART
        and USB Ports" vs "USB Communication", both about "USB" but
        different requirement scope). Only 'redundant' confirms the match: the
        candidate restates the ADO item, so it is skipped. 'distinct' (a
        genuinely different requirement, only topically similar) and
        'contradictory' (similar wording, different content) both mean the
        candidate is kept -- skipping a contradictory one would silently
        drop a requirement that disagrees with an existing one."""
        source = json.dumps(
            {"candidate": candidate_text, "existing": matched_text}, ensure_ascii=False
        )
        call = build_call("judge_duplicate_pair", blocks=[DataBlock("source", source)])
        return self._chat_json(
            call,
            self._params(schema=duplicate_pair_verdict_schema()),
            user_id=user_id,
        )

    def judge_parameter_pairs(
        self, pairs_by_id: dict[str, dict[str, str]], user_id: str | None = None
    ) -> dict[str, dict]:
        """Backs the ConflictJudgeClient protocol (app.leveling.conflict_detection): per pair of similar statements {"a", "b"}, is it
        the same parameter, and do the values agree -- each "yes", "no" or "uncertain". Returns pair id -> entry for every pair that
        came back with both answers in that vocabulary (one bounded retry of the rest); the caller reports any pair still absent.
        Code decides the conflict wherever it can compare the values itself; values_agree is read only where it cannot."""
        spec = PARAMETER_PAIR_SPEC

        def send(payload: dict, mode: KeyedMode) -> object:
            call = build_call(
                "judge_parameter_pairs",
                markers={
                    "pair_count": str(len(payload)),
                    "output_format": describe_output(spec, mode),
                },
                blocks=[DataBlock("source", json.dumps(payload, ensure_ascii=False))],
            )
            return self._chat_json(call, self._params(schema=schema_for(spec, mode)), user_id=user_id)

        def answered(_pair_id: str, entry: object) -> bool:
            return isinstance(entry, dict) and all(
                entry.get(name) in PAIR_VERDICTS for name in spec.fields
            )

        return run_keyed(send, pairs_by_id, spec, model=self._model, accept=answered)

    def judge_kb_document_relevance(
        self, name: str, excerpt: str, user_id: str | None = None
    ) -> dict:
        """Backs the KB profile's relevance step (app.kb.profile): does this document help create work-item hierarchies?
        Returns {"relevant": bool, "reason": str}; raises ValueError on an answer without a boolean verdict."""
        source = json.dumps({"file_name": name, "excerpt": excerpt}, ensure_ascii=False)
        call = build_call("kb_document_relevance", blocks=[DataBlock("source", source)])
        parsed = self._chat_json(
            call,
            self._params(schema=kb_document_relevance_schema(), max_tokens=400),
            user_id=user_id,
        )
        if not isinstance(parsed, dict) or not isinstance(parsed.get("relevant"), bool):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return {"relevant": parsed["relevant"], "reason": str(parsed.get("reason") or "")}

    def extract_kb_document_profile(
        self, name: str, window_text: str, user_id: str | None = None
    ) -> dict:
        """Backs the KB profile's map step: what one window of a KB document states about quality categories, type
        definitions, writing rules, glossary terms and obligation forms. Malformed entries are dropped, never trusted, and an obligation form
        the window does not contain is dropped."""
        source = json.dumps({"file_name": name, "text": window_text}, ensure_ascii=False)
        call = build_call("extract_kb_document_profile", blocks=[DataBlock("source", source)])
        parsed = self._chat_json(
            call,
            self._params(schema=kb_document_profile_schema(), max_tokens=4000),
            user_id=user_id,
        )
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")

        def objects(key: str, *fields: str) -> list[dict]:
            return [
                {f: str(item[f]) for f in fields}
                for item in (parsed.get(key) or [])
                if isinstance(item, dict) and all(isinstance(item.get(f), str) for f in fields)
            ]

        return {
            "categories": [
                c for c in objects("categories", "name", "pass_condition") if c["name"].strip()
            ],
            "type_definitions": [
                d
                for d in objects("type_definitions", "item_type", "text")
                if d["item_type"] in ("epic", "feature", "requirement") and d["text"].strip()
            ],
            "rules": [r for r in (parsed.get("rules") or []) if isinstance(r, str) and r.strip()],
            "glossary": [g for g in objects("glossary", "term", "definition") if g["term"].strip()],
            "obligation_forms": checked_obligation_forms(parsed.get("obligation_forms"), window_text),
        }

    def consolidate_kb_categories(
        self,
        categories: list[dict],
        max_categories: int,
        user_id: str | None = None,
        preferred_names: list[str] | None = None,
    ) -> list[dict]:
        """Backs the KB profile's category merge (app.kb.profile): the same quality named differently by several documents
        (Testable / Testability) becomes one entry. Returns [{name, pass_condition, merged_from}]; malformed entries are
        dropped, an answer without a category list raises ValueError."""
        source = json.dumps(
            {
                "max_categories": max_categories,
                "categories": categories,
                **({"preferred_names": preferred_names} if preferred_names else {}),
            },
            ensure_ascii=False,
        )
        call = build_call("consolidate_kb_categories", blocks=[DataBlock("source", source)])
        parsed = self._chat_json(
            call,
            self._params(schema=kb_category_consolidation_schema(), max_tokens=3000),
            user_id=user_id,
        )
        if not isinstance(parsed, dict) or not isinstance(parsed.get("categories"), list):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        groups = []
        for item in parsed["categories"]:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("name"), str)
                or not item["name"].strip()
            ):
                continue
            members = [
                m for m in (item.get("merged_from") or []) if isinstance(m, str) and m.strip()
            ]
            if members:
                groups.append(
                    {
                        "name": " ".join(item["name"].split()),
                        "pass_condition": " ".join(str(item.get("pass_condition") or "").split()),
                        "merged_from": members,
                    }
                )
        return groups

    def find_standard_requirements(
        self, rules: list[str], categories: list[dict], user_id: str | None = None
    ) -> dict[str, str]:
        """Backs the KB profile's standard requirements (app.kb.profile.find_standard_requires): whether the organization's rules and
        quality criteria require the active voice and a stated rationale. Returns {name: quote} for each one answered as required with
        a non-empty quote; the caller keeps only a quote its material contains. An answer that is not an object raises ValueError."""
        source = json.dumps({"rules": rules, "categories": categories}, ensure_ascii=False)
        call = build_call("find_standard_requirements", blocks=[DataBlock("source", source)])
        parsed = self._chat_json(
            call, self._params(schema=standard_requirements_schema(), max_tokens=1000), user_id=user_id
        )
        if not isinstance(parsed, dict):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        found = {}
        for name in STANDARD_REQUIREMENTS:
            answer = parsed.get(name)
            if isinstance(answer, dict) and answer.get("required") is True:
                quote = answer.get("quote")
                if isinstance(quote, str) and quote.strip():
                    found[name] = " ".join(quote.split())
        return found

    def explain_category_scores(
        self,
        item: dict,
        context_text: str | None,
        categories: list[dict],
        basis: str,
        user_id: str | None = None,
    ) -> list[dict]:
        """Why an item got the scores it did, one short reason per category asked about (see app.kb.explain for the basis). Entries that are
        not {category, reason} strings are dropped; an answer without an explanation list raises ValueError."""
        source = json.dumps(
            {
                "item": item,
                "context": context_text,
                "categories": categories,
                "reasons_language": "the language the item's description is written in",
            },
            ensure_ascii=False,
        )
        # `basis` is code's own paragraph (app.kb.explain.basis_for), never knowledge-base text, so it stays an instruction.
        call = build_call(
            "explain_category_scores", markers={"basis": basis}, blocks=[DataBlock("source", source)]
        )
        parsed = self._chat_json(
            call,
            self._params(schema=score_explanation_schema(), max_tokens=1500),
            user_id=user_id,
        )
        if not isinstance(parsed, dict) or not isinstance(parsed.get("explanations"), list):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        return [
            {"category": e["category"], "reason": e["reason"]}
            for e in parsed["explanations"]
            if isinstance(e, dict)
            and isinstance(e.get("category"), str)
            and isinstance(e.get("reason"), str)
        ]

    def judge_rule_conformance(
        self, rule: str, items: dict[str, str], user_id: str | None = None
    ) -> dict[str, str]:
        """Backs the KB conformance report (app.kb.conformance): does each item follow one stated writing rule? Returns
        {item id: "conforms" | "violates" | "not_applicable"} for the ids the model answered about; ids it skipped are absent, malformed
        entries dropped. Before prompt v2 the answer was a boolean (a rule that does not apply counted as followed): read as conforms or
        violates. The schema follows the prompt version, so removing v2 rolls back cleanly."""
        not_applicable = resolve_version("judge_rule_conformance") >= _NOT_APPLICABLE_VERSION
        source = json.dumps({"rule": rule, "items": items}, ensure_ascii=False)
        call = build_call("judge_rule_conformance", blocks=[DataBlock("source", source)])
        parsed = self._chat_json(
            call,
            self._params(schema=rule_conformance_schema(not_applicable), max_tokens=2000),
            user_id=user_id,
        )
        verdicts = parsed.get("verdicts") if isinstance(parsed, dict) else None
        if not isinstance(verdicts, list):
            raise ValueError(f"malformed JSON in LLM response content: {parsed!r}")
        found: dict[str, str] = {}
        for entry in verdicts:
            if not isinstance(entry, dict) or str(entry.get("id")) not in items:
                continue
            verdict = entry.get("verdict")
            if verdict not in CONFORMANCE_VERDICTS:
                conforms = entry.get("conforms")
                verdict = ("conforms" if conforms else "violates") if isinstance(conforms, bool) else None
            if verdict is not None:
                found[str(entry["id"])] = verdict
        return found

    def name_root_groups(
        self, titles_by_group_id: dict[str, list[str]], user_id: str | None = None
    ) -> dict[str, str]:
        """Names groups that were already decided by a fixed rule (root_regrouping.deterministic_root_groups). The
        model only chooses wording: it cannot move, add or remove a member, so it cannot change any count. Returns
        {group_id: title}; a group the model skipped is simply absent (the caller supplies a fallback title)."""
        after, language_blocks = self._language()
        call = build_call(
            "name_root_groups",
            blocks=[*language_blocks, DataBlock("source", json.dumps(titles_by_group_id, ensure_ascii=False))],
            after=after,
        )
        result = self._chat_json(
            call,
            self._params(schema=root_group_names_schema()),
            user_id=user_id,
        )
        names = result.get("names") if isinstance(result, dict) else None
        if not isinstance(names, list):
            return {}
        return {
            str(entry["group_id"]): " ".join(str(entry["title"]).split())
            for entry in names
            if isinstance(entry, dict)
            and "group_id" in entry
            and isinstance(entry.get("title"), str)
            and entry["title"].strip()
        }

    def show_model(self, model: str, user_id: str | None = None) -> dict:
        """Backs the ModelCapsClient protocol (llm_leveling.py) -- a live
        Ollama /api/show lookup, proxied through the orchestrator's own
        /llm/show route (OpenWebUiClient.showModel), for a model NOT
        already in llm_leveling.py's hand-maintained `_MODEL_CAPS` table.
        Real gap closed here: every entry in that table was populated by a
        human manually running /api/show ONCE per model and hardcoding
        the result -- an unrecognized model previously got the exact same
        blanket conservative guess regardless of what it actually is.

        Returns {'context_length': int | None, 'capabilities': list[str]}
        -- `context_length` is None when the orchestrator's own lookup
        couldn't find the model's architecture-prefixed context-length
        key (an unrecognized architecture, or a non-Ollama backend that
        still answered but with no real model_info). This is a narrow
        read-only capability probe, NOT a /llm/chat call -- no
        system_prompt, no responseSchema, no model-generation cost at
        all; `_resolve_caps` (the sole caller) already fails open on any
        exception this raises, so this method itself stays a thin,
        undecorated passthrough."""
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        if user_id:
            headers["X-Req2Ado-User-Id"] = user_id
        with httpx.Client(
            transport=self._transport,
            timeout=self.request_timeout_seconds or _LLM_REQUEST_TIMEOUT_SECONDS,
        ) as client:
            response = client.post(
                f"{self._base_url}/llm/show",
                json={"model": model},
                headers=headers,
            )
        response.raise_for_status()
        body = response.json()
        return {
            "context_length": body.get("contextLength"),
            "capabilities": body.get("capabilities") or [],
            # Present when the orchestrator got the answer from a LiteLLM proxy (limits stated per deployment).
            "max_output_tokens": body.get("maxOutputTokens"),
            "source": body.get("source"),
        }

    def judge_kb_relevance(
        self,
        branch_content: str,
        snippets: list[dict],
        user_id: str | None = None,
    ) -> dict[str, str]:
        """Verifies whether each KB snippet OFFERED to a branch's grounded
        calls was actually relevant to that branch's real content -- being
        above the retrieval similarity cutoff and pasted into a prompt
        (see app.kb.retrieval.retrieve_context) is not proof the model
        found it relevant, only that it was provided. `snippets` is a list
        of {source_file, text} dicts, addressed by 0-based index as a
        string key in the response (mirroring infer_hierarchy's node_id
        convention). Returns a dict mapping index -> 'relevant'/
        'not_relevant'; an index missing from the response (e.g. a
        malformed/degraded reply) is the caller's responsibility to treat
        as unknown, not a hard failure -- KB relevance judgment is an
        enhancement, never a hard dependency for a SURVEY job."""
        snippets_by_index = {
            str(i): {"source_file": s["source_file"], "text": s["text"]}
            for i, s in enumerate(snippets)
        }
        spec = KB_RELEVANCE_SPEC

        # Confirmed missing before this used _chat_json: this was the ONE
        # call in this module with no output cap at all -- the exact
        # unbounded-hidden-reasoning exposure _MAX_OUTPUT_TOKENS's own doc
        # comment documents (a reasoning model observed generating 40+ minute
        # single calls with no cap in place). Output here is a tiny
        # index->enum map, so _chat_json's default maxTokens is pure
        # downside-bounding, not a real content constraint. think=False
        # (also via _chat_json's default): binary relevant/not_relevant
        # judgment per snippet is structured classification, not open-ended
        # reasoning -- same confirmed-live finding as every other
        # non-conversational call in this module.
        def send(payload: dict, mode: KeyedMode) -> object:
            # A retry of omitted indices re-enters here with just those snippets.
            call = build_call(
                "judge_kb_relevance",
                markers={"output_format": describe_output(spec, mode)},
                blocks=[
                    DataBlock(
                        "source",
                        json.dumps(
                            {"section_content": branch_content, "snippets": payload}, ensure_ascii=False
                        ),
                    )
                ],
            )
            parsed = self._chat_json(
                call,
                self._params(schema=schema_for(spec, mode)),
                user_id=user_id,
            )
            # The prompt-only / legacy answer is {index: verdict}; read it as {index: {"verdict": ...}}.
            return wrap_scalar_entries(parsed, "verdict")

        entries = run_keyed(send, snippets_by_index, spec, model=self._model)
        return {index: entry["verdict"] for index, entry in entries.items()}

    def author_content(
        self,
        section_text: str,
        skeleton_nodes: dict[str, dict],
        kb_context: str | None = None,
        user_id: str | None = None,
    ) -> tuple[dict[str, dict], bool]:
        """Writes each node's description and tags on a tree that is already FIXED (app.leveling.content_authoring): the prompt
        states that no node may be added, dropped, re-typed, re-parented or renamed.

        `skeleton_nodes` maps each node's own id to {'type', 'title', 'parent_id'}; 'parent_id' is context only.

        Returns ({node_id: {'description', 'tags'}}, truncated). `truncated` is surfaced, not swallowed: a long branch's full text is
        the payload most likely to hit the output cap. A node the response omits, or answers in another script, is absent; the caller
        keeps its source wording.

        Response-cached (see this class's `cache` param). The key is computed from the request itself (llm_cache.payload_key), so it
        covers every input that can change the answer, the prompt included."""
        spec = AUTHOR_CONTENT_SPEC
        truncated = False

        def build(nodes: dict, mode: KeyedMode) -> tuple[PromptCall, dict]:
            # The language of the section being written, which the script check below also requires.
            after, language_blocks = self._language(
                obligations=True, script=dominant_script(section_text)
            )
            call = build_call(
                "author_content",
                markers={
                    "tag_vocabulary": ", ".join(t.value for t in RequirementTag),
                    "node_count": str(len(nodes)),
                    "output_format": describe_output(spec, mode),
                },
                blocks=[
                    *self._standard_blocks(),
                    *([DataBlock("reference", kb_context)] if kb_context is not None else []),
                    *language_blocks,
                    DataBlock(
                        "source",
                        json.dumps({"section": section_text, "nodes": nodes}, ensure_ascii=False),
                    ),
                ],
                after=after,
            )
            return call, self._params(schema=schema_for(spec, mode))

        key = None
        if self._cache is not None:
            # The key is the request this call sends (the whole tree, in the mode it starts in): the prompt, the section, the
            # already-decided tree, the standard, the grounding context and every model parameter.
            first_call, first_params = build(skeleton_nodes, mode_for(spec, self._model))
            key = payload_key(first_call.payload(first_params))
            cached = self._cache.get(key)
            if cached is not None:
                logger.info("author_content: cache hit, skipping LLM call")
                return cached["content"], cached["truncated"]

        def send(nodes: dict, mode: KeyedMode) -> object:
            nonlocal truncated
            call, params = build(nodes, mode)
            with _tracer.start_as_current_span("author_content") as span:
                span.set_attribute("gen_ai.request.model", self._model or "default")
                span.set_attribute("gen_ai.operation.name", "chat")
                response = self._post_chat(call, params, user_id)
                response.raise_for_status()
                body = response.json()
                content = _strip_json_fence(body["content"])
                parsed = _parse_json_object(content)
                span.set_attribute(
                    "gen_ai.response.node_count", len(parsed) if isinstance(parsed, dict) else 0
                )
            if body.get("finishReason") == "length":
                truncated = True
                # The entry the token limit cut off may have been repaired into something that parses but is
                # wrong; it is treated as not answered (the caller already degrades for an absent node).
                parsed = drop_possibly_cut_last_entry(parsed)
            return parsed

        # No retry of omitted nodes: a long branch's full text is exactly what hits the output cap, so
        # repeating it would pay twice for the same cut-off, and the caller already decides what an
        # absent node means (see app.leveling.content_authoring).
        result = run_keyed(
            send,
            skeleton_nodes,
            spec,
            model=self._model,
            retry=False,
            accept=_in_source_script(spec.name, lambda _node_id: section_text, ("description",)),
        )
        _tag_prompt(result, build(skeleton_nodes, mode_for(spec, self._model))[0].identity, self._model)
        if truncated:
            notice("output_limit_reached", "warning", with_last_item=True, step="write")
        logger.warning(
            "author_content result: requested=%d returned=%d truncated=%s",
            len(skeleton_nodes),
            len(result),
            truncated,
        )
        # Never cache a truncated result -- same reasoning as analyze_section's
        # own identical guard.
        if key is not None and not truncated:
            self._cache.set(key, {"content": dict(result), "truncated": truncated})
        return dict(result), truncated
