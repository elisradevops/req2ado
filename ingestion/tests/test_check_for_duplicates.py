import tempfile

from app.dedup.check_for_duplicates import check_for_duplicates
from app.dedup.vector_store import ChromaVectorStore


class FakeEmbedClient:
    """Deterministic fake embed client — maps specific input texts to fixed
    vectors so similarity can be controlled precisely in tests, matching
    Phase 6's DoD wording '0.89 keep / 0.91 skip tests' exactly."""

    def __init__(self, text_to_vector: dict[str, list[float]]) -> None:
        self._text_to_vector = text_to_vector

    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        return [self._text_to_vector[text] for text in texts]


def test_similarity_0_91_is_flagged_as_duplicate() -> None:
    # cos(theta) = 0.91 needs a specific vector pair; using two 2D unit
    # vectors at the angle where cos(theta) = 0.91 (~24.5 degrees).
    import math

    theta = math.acos(0.91)
    existing_vector = [1.0, 0.0]
    candidate_vector = [math.cos(theta), math.sin(theta)]

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", existing_vector, area_path="Project\\Area1")

        embed_client = FakeEmbedClient({"candidate text": candidate_vector})
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True
        assert result.matched_item_id == "existing-item"
        assert result.similarity == pytest_approx(0.91)


def test_similarity_0_89_is_not_flagged_as_duplicate() -> None:
    import math

    theta = math.acos(0.89)
    existing_vector = [1.0, 0.0]
    candidate_vector = [math.cos(theta), math.sin(theta)]

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", existing_vector, area_path="Project\\Area1")

        embed_client = FakeEmbedClient({"candidate text": candidate_vector})
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False
        assert result.similarity == pytest_approx(0.89)


def test_exactly_0_90_similarity_is_flagged_as_duplicate() -> None:
    # Threshold is >= 0.90, not > 0.90 — proves the boundary is inclusive.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1")

        embed_client = FakeEmbedClient(
            {"candidate text": [1.0, 0.0]}
        )  # identical -> similarity 1.0
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            threshold=1.0,  # forces the exact-boundary case: similarity == threshold
        )
        assert result.is_duplicate is True


def test_title_blend_rescues_a_match_that_description_alone_misses() -> None:
    # Mirrors the confirmed real bug (WI-647): description-alone similarity
    # was 0.755, below the fixed 0.90 threshold, even though the item was a
    # genuine duplicate. Blending in the title got it to 0.9026. Reproduced
    # here with exact math: description-only similarity is 0.65 (well
    # below 0.90); the title matches the existing item's own embedding
    # direction exactly, so the 50/50 blend lands at the angle bisector --
    # cos(theta/2) ~= 0.909, clearing 0.90 on the blend alone.
    import math

    existing_vector = [1.0, 0.0]
    theta = math.acos(0.65)
    description_vector = [math.cos(theta), math.sin(theta)]
    title_vector = [1.0, 0.0]

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", existing_vector, area_path="Project\\Area1")

        embed_client = FakeEmbedClient(
            {"candidate title": title_vector, "candidate description": description_vector}
        )
        result = check_for_duplicates(
            text="candidate description",
            title="candidate title",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True
        assert result.matched_item_id == "existing-item"
        assert result.similarity > 0.90


def test_description_alone_would_have_missed_the_same_match() -> None:
    # Sanity check on the fixture above -- confirms description-only
    # similarity really is below threshold, so the previous test is
    # actually exercising the blend's rescue, not a coincidence.
    import math

    theta = math.acos(0.65)
    assert math.cos(theta) < 0.90


def test_empty_store_never_flags_a_duplicate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False
        assert result.matched_item_id is None
        assert result.similarity is None


def test_does_not_mutate_the_vector_store() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1")
        embed_client = FakeEmbedClient({"candidate text": [1.0, 0.0]})

        check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        # Re-querying for the candidate's own vector must still only find
        # "existing-item" — check_for_duplicates must not have upserted
        # "candidate-item" into the store as a side effect.
        result = store.query_nearest([1.0, 0.0], area_path="Project\\Area1")
        assert result[0] == "existing-item"


def pytest_approx(value: float):
    import pytest

    return pytest.approx(value, abs=1e-3)


# --- X7: numeric-literal guard -----------------------------------------------
#
# A >90% embedding-similarity match must never be treated as a duplicate when
# the candidate and matched texts contain different numeric-literal(+unit)
# tokens -- protects the report's named cases: "at least 87%" vs "at least
# 93%" (plus a third source using "85%"), and "at least 500W" vs "at least
# 600W". The guard only fires when the matched item's original text was
# actually stored (vector_store.upsert's optional `document` param) -- an
# older/pre-migration item with no stored text fails open, same as every
# other dedup safety mechanism in this codebase.


def test_high_similarity_with_different_numeric_tokens_is_not_flagged_as_duplicate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        # Identical embedding (similarity 1.0, far above 0.90) but the
        # numbers in the text genuinely differ -- must not be a duplicate.
        store.upsert(
            "existing-item", [1.0, 0.0], area_path="Project\\Area1", document="at least 87%"
        )

        embed_client = FakeEmbedClient({"at least 93%": [1.0, 0.0]})
        result = check_for_duplicates(
            text="at least 93%",
            title="at least 93%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False
        # similarity is still reported -- the diff view can show why it was
        # close, it just must never be auto-skipped.
        assert result.similarity == pytest_approx(1.0)


def test_high_similarity_with_different_wattage_tokens_is_not_flagged_as_duplicate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item", [1.0, 0.0], area_path="Project\\Area1", document="at least 500W"
        )

        embed_client = FakeEmbedClient({"at least 600W": [1.0, 0.0]})
        result = check_for_duplicates(
            text="at least 600W",
            title="at least 600W",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is False


def test_high_similarity_with_identical_numeric_tokens_is_still_flagged_as_duplicate() -> None:
    # The guard must not veto legitimate duplicates -- same numbers, same
    # verdict as before this guard existed.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item", [1.0, 0.0], area_path="Project\\Area1", document="at least 87%"
        )

        embed_client = FakeEmbedClient({"efficiency of at least 87%": [1.0, 0.0]})
        result = check_for_duplicates(
            text="efficiency of at least 87%",
            title="efficiency of at least 87%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True
        assert result.matched_item_id == "existing-item"


def test_high_similarity_with_no_numbers_in_either_text_is_unaffected() -> None:
    # Nothing to veto on when neither text has a number at all -- the guard
    # is a no-op, not a regression on ordinary text-only dedup.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item",
            [1.0, 0.0],
            area_path="Project\\Area1",
            document="shall support terrestrial broadcast",
        )

        embed_client = FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]})
        result = check_for_duplicates(
            text="shall support terrestrial broadcast input",
            title="shall support terrestrial broadcast input",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True


def test_high_similarity_with_no_stored_document_fails_open_ignoring_the_guard() -> None:
    # An older/pre-migration item was upserted with no document at all
    # (matched_document is None) -- the guard must not veto on missing
    # information, matching every other fail-open dedup mechanism here.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("existing-item", [1.0, 0.0], area_path="Project\\Area1")  # no document

        embed_client = FakeEmbedClient({"at least 93%": [1.0, 0.0]})
        result = check_for_duplicates(
            text="at least 93%",
            title="at least 93%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
        )
        assert result.is_duplicate is True


# --- LLM verification pass (DuplicateJudgeClient) ----------------------------
#
# Closes a real false-positive risk: `all-minilm` (this codebase's
# configured EMBED_MODEL) is a small, general-purpose embedding -- two
# topically-adjacent but scopally distinct short phrases (e.g. "UART and
# USB Ports" vs "USB Communication") can embed above threshold with no
# numeric literal for the existing veto to catch. The judge only runs when
# the embedding+numeric-veto pipeline already says duplicate, and only
# when there's a real matched_document to judge against.


class RecordingJudgeClient:
    def __init__(self, verdict: str) -> None:
        self.verdict = verdict
        self.calls: list[tuple[str, str]] = []

    def judge_duplicate_pair(
        self, candidate_text: str, matched_text: str, user_id: str | None = None
    ) -> dict:
        self.calls.append((candidate_text, matched_text))
        return {"verdict": self.verdict}


def test_judge_client_distinct_verdict_downgrades_an_embedding_match() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item",
            [1.0, 0.0],
            area_path="Project\\Area1",
            document="BP_MEZ USB Communication protocol",
        )

        embed_client = FakeEmbedClient({"BP_MEZ UART and USB Ports": [1.0, 0.0]})
        judge_client = RecordingJudgeClient("distinct")
        result = check_for_duplicates(
            text="BP_MEZ UART and USB Ports",
            title="BP_MEZ UART and USB Ports",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is False
        assert result.judge_verdict == "distinct"
        assert judge_client.calls == [
            ("BP_MEZ UART and USB Ports", "BP_MEZ USB Communication protocol")
        ]


def test_a_match_with_no_stored_text_is_not_skipped_when_a_judge_is_configured_because_nothing_can_confirm_it() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("old-item", [1.0, 0.0], area_path="Project\\Area1")  # indexed before texts were stored
        judge_client = RecordingJudgeClient("redundant")

        result = check_for_duplicates(
            text="shall support terrestrial broadcast input",
            title="shall support terrestrial broadcast input",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]}),
            vector_store=store,
            judge_client=judge_client,
        )

        assert result.is_duplicate is False
        assert result.judge_verdict == "unverified"
        assert result.matched_item_id == "old-item"
        assert judge_client.calls == []


def test_a_later_match_with_no_stored_text_does_not_get_skipped_after_the_judge_said_distinct_to_an_earlier_one() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("judged-item", [1.0, 0.0], area_path="Project\\Area1", document="a different requirement")
        store.upsert("old-item", [0.95, 0.31], area_path="Project\\Area1")
        judge_client = RecordingJudgeClient("distinct")

        result = check_for_duplicates(
            text="shall support terrestrial broadcast input",
            title="shall support terrestrial broadcast input",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]}),
            vector_store=store,
            judge_client=judge_client,
        )

        assert result.is_duplicate is False
        assert len(judge_client.calls) == 1


def test_a_match_with_no_stored_text_still_stands_when_there_is_no_judge_at_all() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("old-item", [1.0, 0.0], area_path="Project\\Area1")

        result = check_for_duplicates(
            text="shall support terrestrial broadcast input",
            title="shall support terrestrial broadcast input",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]}),
            vector_store=store,
        )

        assert result.is_duplicate is True
        assert result.judge_verdict is None


def test_judge_client_redundant_verdict_keeps_the_duplicate_flag() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item",
            [1.0, 0.0],
            area_path="Project\\Area1",
            document="shall support terrestrial broadcast",
        )

        embed_client = FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]})
        judge_client = RecordingJudgeClient("redundant")
        result = check_for_duplicates(
            text="shall support terrestrial broadcast input",
            title="shall support terrestrial broadcast input",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is True
        assert result.judge_verdict == "redundant"


def test_judge_client_contradictory_verdict_is_not_a_duplicate_so_the_requirement_is_not_dropped() -> None:
    # A "contradictory" pair says similar things with DIFFERENT content. Skipping it as a duplicate would silently drop a requirement
    # that disagrees with an existing one, which is exactly what a reviewer needs to see. The verdict stays visible; the similarity and
    # the matched item are still reported so the reviewer can compare the two.
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item",
            [1.0, 0.0],
            area_path="Project\\Area1",
            document="efficiency at least 87%",
        )

        embed_client = FakeEmbedClient({"minimum efficiency at least 87%": [1.0, 0.0]})
        judge_client = RecordingJudgeClient("contradictory")
        result = check_for_duplicates(
            text="minimum efficiency at least 87%",
            title="minimum efficiency at least 87%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is False
        assert result.judge_verdict == "contradictory"
        assert result.matched_item_id == "existing-item"
        assert result.similarity is not None


def test_judge_client_exception_does_not_skip_the_requirement_and_is_marked_unverified(
    caplog,
) -> None:
    # Real bug this closes: a judge exception previously left judge_verdict
    # at None -- IDENTICAL to "the judge never ran at all" -- so a reviewer
    # (or the orchestrator) had no way to tell "embedding said duplicate,
    # judge confirmed it" from "embedding said duplicate, judge was DOWN and
    # this was never actually verified." is_duplicate=True still stands (the
    # embedding's own verdict), but judge_verdict must now be distinguishable
    # and the failure must be logged -- this is the one fail-open path in
    # the codebase whose unsafe direction is silently DROPPING a real
    # requirement (confirm() skips 'create' for a dedup_skip match).
    class RaisingJudgeClient:
        def judge_duplicate_pair(
            self, candidate_text: str, matched_text: str, user_id: str | None = None
        ) -> dict:
            raise RuntimeError("LLM unreachable")

    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item",
            [1.0, 0.0],
            area_path="Project\\Area1",
            document="shall support terrestrial broadcast",
        )

        embed_client = FakeEmbedClient({"shall support terrestrial broadcast input": [1.0, 0.0]})
        with caplog.at_level("WARNING"):
            result = check_for_duplicates(
                text="shall support terrestrial broadcast input",
                title="shall support terrestrial broadcast input",
                item_id="candidate-item",
                area_path="Project\\Area1",
                embed_client=embed_client,
                vector_store=store,
                judge_client=RaisingJudgeClient(),
            )
        # The judge never confirmed the match, so nothing is skipped: creating a requirement that turns out to be a duplicate is
        # visible and fixable, silently never creating a real one is not.
        assert result.is_duplicate is False
        assert result.judge_verdict == "judge_failed"
        assert result.matched_item_id == "existing-item"
        assert any("judge" in record.message.lower() for record in caplog.records)


def test_judge_client_is_never_called_when_the_embedding_itself_says_not_duplicate() -> None:
    import math

    theta = math.acos(0.89)
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item", [1.0, 0.0], area_path="Project\\Area1", document="unrelated text"
        )

        embed_client = FakeEmbedClient({"candidate text": [math.cos(theta), math.sin(theta)]})
        judge_client = RecordingJudgeClient("distinct")
        result = check_for_duplicates(
            text="candidate text",
            title="candidate text",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is False
        assert result.judge_verdict is None
        assert judge_client.calls == []


def test_judge_client_is_never_called_when_the_numeric_veto_already_downgraded_the_match() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert(
            "existing-item", [1.0, 0.0], area_path="Project\\Area1", document="at least 87%"
        )

        embed_client = FakeEmbedClient({"at least 93%": [1.0, 0.0]})
        judge_client = RecordingJudgeClient("redundant")
        result = check_for_duplicates(
            text="at least 93%",
            title="at least 93%",
            item_id="candidate-item",
            area_path="Project\\Area1",
            embed_client=embed_client,
            vector_store=store,
            judge_client=judge_client,
        )
        assert result.is_duplicate is False
        assert judge_client.calls == []


# --- what a proposed item is compared against: same kind, in scope, and more than the single nearest --------------------------


class ScriptedJudge:
    """Answers per matched text: {matched_text: verdict}; an Exception value is raised."""

    def __init__(self, verdicts: dict[str, object]) -> None:
        self.verdicts = verdicts
        self.calls: list[str] = []

    def judge_duplicate_pair(self, candidate_text: str, matched_text: str, user_id: str | None = None) -> dict:
        self.calls.append(matched_text)
        verdict = self.verdicts[matched_text]
        if isinstance(verdict, Exception):
            raise verdict
        return {"verdict": verdict}


def _check(store, judge=None, area_path="Proj\\A", text="shall do the thing", **kwargs):
    return check_for_duplicates(
        text=text,
        title=text,
        item_id="candidate",
        area_path=area_path,
        embed_client=FakeEmbedClient({text: [1.0, 0.0]}),
        vector_store=store,
        judge_client=judge,
        **kwargs,
    )


def _vec(similarity: float) -> list[float]:
    import math

    return [similarity, math.sqrt(1 - similarity * similarity)]


def test_a_requirement_is_not_called_a_duplicate_of_a_feature_with_the_same_words() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("feature-1", [1.0, 0.0], "Proj\\A", document="shall do the thing", type_category="Feature")

        result = _check(store, type_category="Requirement")

        assert result.is_duplicate is False


def test_the_same_kind_in_a_sub_area_is_found_by_default_and_a_sibling_area_only_by_a_project_wide_search() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("in-child", [1.0, 0.0], "Proj\\A\\Child", document="shall do the thing", type_category="Requirement")
        store.upsert("in-sibling", [1.0, 0.0], "Proj\\B", document="shall do the thing", type_category="Requirement")

        by_area = _check(store, type_category="Requirement", scope="area_path")
        by_project = _check(store, type_category="Requirement", scope="project")

        assert by_area.is_duplicate and by_area.matched_item_id == "in-child"
        assert by_project.is_duplicate  # one of the two, both are exact matches


def test_when_the_nearest_match_is_vetoed_the_next_one_is_still_considered() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        # nearest: differs by a number, so vetoed; second: a real restatement just under it
        store.upsert("nearest", [1.0, 0.0], "Proj\\A", document="shall do the thing within 5 s", type_category="Requirement")
        store.upsert("second", _vec(0.97), "Proj\\A", document="shall do the thing", type_category="Requirement")

        # the candidate has no number: the nearest one ("5 s") differs by a number and is vetoed, the second is a plain restatement
        embed = FakeEmbedClient({"shall do the thing": [1.0, 0.0]})
        result = check_for_duplicates(
            text="shall do the thing",
            title="shall do the thing",
            item_id="candidate",
            area_path="Proj\\A",
            embed_client=embed,
            vector_store=store,
            type_category="Requirement",
        )

        assert result.is_duplicate is True
        assert result.matched_item_id == "second"


def test_the_judge_is_asked_about_each_close_candidate_in_turn_and_only_a_restatement_skips() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("a", _vec(0.99), "Proj\\A", document="text a", type_category="Requirement")
        store.upsert("b", _vec(0.96), "Proj\\A", document="text b", type_category="Requirement")
        store.upsert("c", _vec(0.93), "Proj\\A", document="text c", type_category="Requirement")
        judge = ScriptedJudge({"text a": "distinct", "text b": "contradictory", "text c": "redundant"})

        result = _check(store, judge, type_category="Requirement")

        assert judge.calls == ["text a", "text b", "text c"]
        assert result.is_duplicate is True
        assert result.matched_item_id == "c"
        assert result.judge_verdict == "redundant"


def test_when_no_candidate_is_confirmed_the_item_is_kept_and_the_best_candidate_is_still_reported() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("a", _vec(0.99), "Proj\\A", document="text a", type_category="Requirement")
        store.upsert("b", _vec(0.95), "Proj\\A", document="text b", type_category="Requirement")
        judge = ScriptedJudge({"text a": "distinct", "text b": "distinct"})

        result = _check(store, judge, type_category="Requirement")

        assert result.is_duplicate is False
        assert result.matched_item_id == "a"
        assert result.similarity is not None and result.similarity > 0.98
        assert result.judge_verdict == "distinct"


def test_a_judge_that_fails_stops_the_search_and_nothing_is_skipped() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("a", _vec(0.99), "Proj\\A", document="text a", type_category="Requirement")
        store.upsert("b", _vec(0.95), "Proj\\A", document="text b", type_category="Requirement")
        judge = ScriptedJudge({"text a": RuntimeError("LLM down"), "text b": "redundant"})

        result = _check(store, judge, type_category="Requirement")

        assert judge.calls == ["text a"]  # no further calls into a judge that is down
        assert result.is_duplicate is False
        assert result.judge_verdict == "judge_failed"


def test_only_the_closest_few_candidates_cost_a_judge_call() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        words = ["alpha", "bravo", "charlie", "delta", "echo"]  # no digits: a number in the text would trip the numeric guard
        for word, similarity in zip(words, [0.99, 0.98, 0.97, 0.96, 0.95]):
            store.upsert(f"i-{word}", _vec(similarity), "Proj\\A", document=f"text {word}", type_category="Requirement")
        judge = ScriptedJudge({f"text {word}": "distinct" for word in words})

        result = _check(store, judge, type_category="Requirement")

        assert len(judge.calls) == 3
        assert result.is_duplicate is False


def test_candidates_under_the_threshold_are_never_judged_or_skipped() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = ChromaVectorStore(persist_path=tmp)
        store.upsert("far", _vec(0.80), "Proj\\A", document="text far", type_category="Requirement")
        judge = ScriptedJudge({"text far": "redundant"})

        result = _check(store, judge, type_category="Requirement")

        assert judge.calls == []
        assert result.is_duplicate is False
