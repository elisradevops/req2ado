"""Model sizing by facts, not names: how a model on the proxy (`OpenAI/gpt-5.4`, `claude-sonnet-4-6`, a model that
appears next month) is sized for a job, and what answer budget its calls get."""
import json

import httpx
import pytest

import app.leveling.model_caps as caps_module
from app.leveling.model_caps import (
    DEFAULT_OUTPUT_TOKEN_BUDGET,
    _LIVE_MAX_OUTPUT,
    _LIVE_MODEL_CAPS_CACHE,
    _ModelCaps,
    _resolve_caps,
    family_facts,
    normalize_model_name,
    output_token_budget,
)
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

FRONTIER_SHORTCUT = _ModelCaps(100_000, 150_000, 150_000, True)  # claude-opus* / gpt-5*, as sent: unchanged
DEFAULT = _ModelCaps(200, 28_000, 10_000, False)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setattr(caps_module.settings, "model_profiles", "")
    monkeypatch.setattr(caps_module.settings, "tools_from_model_info", False)
    monkeypatch.setattr(caps_module.settings, "tools_for_known_families", False)
    _LIVE_MODEL_CAPS_CACHE.clear()
    _LIVE_MAX_OUTPUT.clear()
    yield
    _LIVE_MODEL_CAPS_CACHE.clear()
    _LIVE_MAX_OUTPUT.clear()


class _Proxy:
    """A caps client whose answer (or failure) is fixed."""

    def __init__(self, answer=None, error=None):
        self.answer, self.error, self.calls = answer, error, 0

    def show_model(self, model, user_id=None):
        self.calls += 1
        if self.error:
            raise self.error
        return self.answer


# -- names ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("OpenAI/gpt-5.4", "gpt-5.4"),
        ("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
        ("OpenAI/gpt-chat-latest", "gpt-chat-latest"),
        ("azure_ai/mistral-document-ai", "mistral-document-ai"),
        ("gpt-4.1-2025-04-14", "gpt-4.1"),
        ("  Claude-Opus-5 ", "claude-opus-5"),
        ("", ""),
        (None, ""),
    ],
)
def test_names_lose_the_provider_prefix_and_date_suffix(raw, expected) -> None:
    assert normalize_model_name(raw) == expected


# -- the documented families ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "context", "input_tokens", "output", "reasoning"),
    [
        ("claude-opus-4-8", 1_000_000, 1_000_000, 128_000, True),
        ("claude-opus-4-7", 1_000_000, 1_000_000, 128_000, True),
        ("claude-opus-5", 1_000_000, 1_000_000, 128_000, True),
        ("claude-opus-5-5", 1_000_000, 1_000_000, 128_000, True),
        ("claude-sonnet-4-6", 1_000_000, 1_000_000, 128_000, True),
        ("claude-sonnet-5", 1_000_000, 1_000_000, 128_000, True),
        ("claude-sonnet-5-5", 1_000_000, 1_000_000, 128_000, True),
        ("claude-fable-5-1", 1_000_000, 1_000_000, 128_000, True),
        ("claude-mythos-5-1", 1_000_000, 1_000_000, 128_000, True),
        ("claude-sonnet-4-5", 200_000, 200_000, 64_000, False),
        ("claude-haiku-4-5", 200_000, 200_000, 64_000, False),
        ("claude-haiku-4-5-20251001", 200_000, 200_000, 64_000, False),
        ("claude-opus-4-1", 200_000, 200_000, 32_000, False),
        ("claude-3-5-sonnet-20241022", 200_000, 200_000, 4_096, False),
        ("OpenAI/gpt-4.1", 1_047_576, 1_047_576, 32_768, False),
        ("OpenAI/gpt-5", 400_000, 272_000, 128_000, True),
        ("OpenAI/gpt-5-mini", 400_000, 272_000, 128_000, True),
        ("OpenAI/gpt-5.2-codex", 400_000, 272_000, 128_000, True),
        ("OpenAI/gpt-5.4", 1_050_000, 922_000, 128_000, True),
        ("OpenAI/gpt-5.4-mini", 400_000, 272_000, 128_000, True),
        ("OpenAI/gpt-5.5", 1_050_000, 922_000, 128_000, True),
        ("OpenAI/gpt-5.6-terra", 1_050_000, 922_000, 128_000, True),
        ("gpt-6-astra", 1_050_000, 922_000, 128_000, True),
        ("gpt-6.1-sol", 1_050_000, 922_000, 128_000, True),
        ("OpenAI/gpt-oss-120b", 131_072, 131_072, 131_072, True),
        ("OpenAI/gpt-chat-latest", 128_000, 111_616, 16_384, True),
        ("gpt-5.1-chat", 128_000, 111_616, 16_384, True),
    ],
)
def test_a_documented_family_is_recognised_by_generation(name, context, input_tokens, output, reasoning) -> None:
    facts = family_facts(name)
    assert facts is not None
    assert (facts.context_tokens, facts.input_tokens, facts.max_output_tokens, facts.reasoning) == (context, input_tokens, output, reasoning)


@pytest.mark.parametrize("name", ["gemma4:26b", "qwen3:4b", "condor_x", "contracts-ai-poc", "mistral-document-ai", "", None, "gpt", "claude"])
def test_anything_else_is_not_guessed_at(name) -> None:
    assert family_facts(name) is None


# -- resolution order -------------------------------------------------------------------------------------------


def test_the_models_already_proven_in_prod_resolve_exactly_as_before() -> None:
    assert _resolve_caps("claude-opus-4-8") == FRONTIER_SHORTCUT
    assert _resolve_caps("gpt-5.5") == FRONTIER_SHORTCUT
    assert _resolve_caps("gpt-5-mini") == FRONTIER_SHORTCUT
    assert _resolve_caps("qwen3:4b") == caps_module._MODEL_CAPS["qwen3:4b"]
    assert _resolve_caps("gemma4:26b") == DEFAULT
    assert _resolve_caps(None) == DEFAULT


def test_provider_prefixed_and_other_cloud_models_get_frontier_budgets_but_no_tools() -> None:
    # `OpenAI/gpt-5.4` used to fall through to the 28k default because only names STARTING with gpt-5 matched.
    for name in ("OpenAI/gpt-5.4", "OpenAI/gpt-4.1", "claude-sonnet-4-6", "claude-sonnet-5-5", "gpt-6-astra"):
        assert _resolve_caps(name) == _ModelCaps(100_000, 150_000, 150_000, False), name
    assert _resolve_caps("OpenAI/gpt-oss-120b") == _ModelCaps(100_000, 78_643, 78_643, False)  # 0.6 x its 131,072 window
    # Any name that STARTS with claude-opus / gpt-5 keeps the proven shortcut (tools on), as before.
    assert _resolve_caps("claude-opus-5-5") == FRONTIER_SHORTCUT


def test_tools_for_a_recognised_family_follow_the_deployment_switch(monkeypatch) -> None:
    monkeypatch.setattr(caps_module.settings, "tools_for_known_families", True)
    assert _resolve_caps("OpenAI/gpt-5.4").supports_tools is True
    assert _resolve_caps("claude-sonnet-4-6").supports_tools is True
    assert _resolve_caps("gemma4:26b").supports_tools is False  # not a recognised family: still the conservative default
    assert _resolve_caps("mystery-model").supports_tools is False


def test_a_smaller_window_gets_the_prompt_share_of_it() -> None:
    assert _resolve_caps("claude-haiku-4-5") == _ModelCaps(100_000, 120_000, 120_000, False)  # 0.6 x 200k
    assert _resolve_caps("OpenAI/gpt-chat-latest") == _ModelCaps(100_000, 66_969, 66_969, False)  # 0.6 x 111,616


def test_a_live_proxy_answer_sizes_the_model_and_is_cached() -> None:
    proxy = _Proxy({"context_length": 200_000, "capabilities": ["vision", "tools"], "max_output_tokens": 64_000, "source": "litellm"})

    first = _resolve_caps("some-new-model", proxy)
    second = _resolve_caps("some-new-model", proxy)

    assert first == second == _ModelCaps(100_000, 120_000, 120_000, False)
    assert proxy.calls == 1


def test_tools_from_the_proxy_count_only_once_the_deployment_has_turned_that_on(monkeypatch) -> None:
    answer = {"context_length": 922_000, "capabilities": ["tools"], "source": "litellm"}
    assert _resolve_caps("m1", _Proxy(answer)).supports_tools is False
    monkeypatch.setattr(caps_module.settings, "tools_from_model_info", True)
    assert _resolve_caps("m2", _Proxy(answer)).supports_tools is True
    assert _resolve_caps("m3", _Proxy({**answer, "capabilities": ["vision"]})).supports_tools is False


def test_a_proxy_that_states_no_limit_falls_through_to_the_family_rule_and_is_not_cached_as_unknown() -> None:
    proxy = _Proxy({"context_length": None, "capabilities": [], "source": "litellm"})

    assert _resolve_caps("OpenAI/gpt-chat-latest", proxy) == _ModelCaps(100_000, 66_969, 66_969, False)
    assert "OpenAI/gpt-chat-latest" not in _LIVE_MODEL_CAPS_CACHE


def test_an_unknown_model_the_proxy_does_not_state_gets_the_conservative_default() -> None:
    assert _resolve_caps("mystery", _Proxy({"context_length": None, "capabilities": [], "source": "litellm"})) == DEFAULT


def test_an_ollama_answer_is_read_as_before() -> None:
    caps = _resolve_caps("llama3.2:1b", _Proxy({"context_length": 32_768, "capabilities": ["completion", "tools"]}))
    assert caps == _ModelCaps(200, 32_768, 10_000, True)
    big = _resolve_caps("big-local", _Proxy({"context_length": 262_144, "capabilities": ["completion"]}))
    assert big == _ModelCaps(100_000, 262_144, 262_144, False)


def test_a_lookup_that_fails_never_blocks_the_job() -> None:
    assert _resolve_caps("gemma4:26b", _Proxy(error=RuntimeError("proxy down"))) == DEFAULT
    # a recognised family still gets its documented sizing when the lookup is down
    assert _resolve_caps("OpenAI/gpt-5.4", _Proxy(error=httpx.ConnectError("down"))).context_budget_tokens == 150_000
    assert "gemma4:26b" not in _LIVE_MODEL_CAPS_CACHE  # a failure is retried next time, not remembered


# -- operator overrides -----------------------------------------------------------------------------------------


def test_a_model_profile_beats_every_other_source(monkeypatch) -> None:
    profiles = {"OpenAI/gpt-5.4": {"context_budget_tokens": 60_000, "supports_tools": True}, "claude-opus-4-8": {"branch_cap": 50}}
    monkeypatch.setattr(caps_module.settings, "model_profiles", json.dumps(profiles))

    assert _resolve_caps("openai/GPT-5.4") == _ModelCaps(100_000, 60_000, 60_000, True)
    assert _resolve_caps("gpt-5.4") == _ModelCaps(100_000, 60_000, 60_000, True)  # matched on the normalised name too
    assert _resolve_caps("claude-opus-4-8") == _ModelCaps(50, 150_000, 150_000, True)  # partial entry: the rest is kept
    assert _resolve_caps("claude-sonnet-4-6") == _ModelCaps(100_000, 150_000, 150_000, False)  # unlisted: unchanged


@pytest.mark.parametrize("bad", ["not json", "[1, 2]", '{"m": 5}', '{"m": {"context_budget_tokens": -1, "supports_tools": "yes"}}'])
def test_a_bad_profile_is_ignored_rather_than_breaking_sizing(monkeypatch, bad) -> None:
    monkeypatch.setattr(caps_module.settings, "model_profiles", bad)
    assert _resolve_caps("m") == DEFAULT


# -- answer budget ----------------------------------------------------------------------------------------------


def test_the_answer_budget_is_the_default_unless_the_model_has_a_lower_ceiling(monkeypatch) -> None:
    assert output_token_budget("claude-opus-4-8") == DEFAULT_OUTPUT_TOKEN_BUDGET
    assert output_token_budget("OpenAI/gpt-5.4") == DEFAULT_OUTPUT_TOKEN_BUDGET
    assert output_token_budget("claude-haiku-4-5") == DEFAULT_OUTPUT_TOKEN_BUDGET  # 64k ceiling is above the default
    assert output_token_budget("gemma4:26b") == DEFAULT_OUTPUT_TOKEN_BUDGET
    assert output_token_budget(None) == DEFAULT_OUTPUT_TOKEN_BUDGET
    assert output_token_budget("OpenAI/gpt-chat-latest") == 16_384
    assert output_token_budget("claude-3-5-sonnet-20241022") == 4_096


def test_the_proxys_stated_output_ceiling_and_an_override_both_lower_the_budget(monkeypatch) -> None:
    _resolve_caps("new-model", _Proxy({"context_length": 500_000, "capabilities": [], "max_output_tokens": 8_192, "source": "litellm"}))
    assert output_token_budget("new-model") == 8_192
    monkeypatch.setattr(caps_module.settings, "model_profiles", json.dumps({"new-model": {"max_output_tokens": 4_000}}))
    assert output_token_budget("new-model") == 4_000


def test_a_client_sends_its_models_budget_on_every_keyed_call() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"content": json.dumps({"r1": {"title": "T", "tags": []}})})

    for model, expected in (("OpenAI/gpt-chat-latest", 16_384), ("claude-opus-4-8", 20_000), (None, 20_000)):
        seen.clear()
        client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t", model=model)
        client._transport = httpx.MockTransport(handler)
        client.title_and_tags_for_rows({"r1": "The unit shall do X."})
        assert seen[0]["maxTokens"] == expected, model


class _ListingCapsClient:
    """What the orchestrator now answers for a Claude entry of the model listing (captured shape, 19 Oct)."""

    def show_model(self, model: str, user_id: str | None = None) -> dict:
        return {"context_length": 1_000_000, "capabilities": [], "max_output_tokens": 64_000, "source": "litellm"}


def test_the_stated_listing_limits_size_sonnet_exactly_like_the_family_rule_so_nothing_shifts() -> None:
    from_listing = _resolve_caps("claude-sonnet-4-6", caps_client=_ListingCapsClient())
    _LIVE_MODEL_CAPS_CACHE.clear()
    _LIVE_MAX_OUTPUT.clear()
    from_family = _resolve_caps("claude-sonnet-4-6", caps_client=None)
    assert from_listing == from_family == _ModelCaps(100_000, 150_000, 150_000, False)


def test_the_stated_output_ceiling_is_remembered_and_only_ever_lowers_the_answer_budget() -> None:
    _resolve_caps("claude-sonnet-4-6", caps_client=_ListingCapsClient())
    assert _LIVE_MAX_OUTPUT["claude-sonnet-4-6"] == 64_000
    assert output_token_budget("claude-sonnet-4-6") == DEFAULT_OUTPUT_TOKEN_BUDGET  # 64,000 is above the default
