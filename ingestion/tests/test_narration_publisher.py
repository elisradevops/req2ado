import json
from typing import get_args

from app.leveling.narration_publisher import (
    _PHASE_MESSAGES,
    LevelingProgress,
    NarrationPublisher,
    Phase,
)


class _FakeRedis:
    def __init__(self, raises: Exception | None = None) -> None:
        self._raises = raises
        self.rpush_calls: list[tuple] = []
        self.ltrim_calls: list[tuple] = []
        self.expire_calls: list[tuple] = []
        self.publish_calls: list[tuple] = []

    def rpush(self, key, value):
        if self._raises:
            raise self._raises
        self.rpush_calls.append((key, value))

    def ltrim(self, key, start, end):
        self.ltrim_calls.append((key, start, end))

    def expire(self, key, seconds):
        self.expire_calls.append((key, seconds))

    def publish(self, channel, payload):
        self.publish_calls.append((channel, payload))


def _progress(**overrides) -> LevelingProgress:
    defaults = dict(
        phase="analyze_section",
        branch_index=0,
        branch_count=3,
        blocks_done=10,
        blocks_total=50,
        kb_grounded=False,
        kb_citations=[],
    )
    defaults.update(overrides)
    return LevelingProgress(**defaults)


def test_publish_appends_to_a_bounded_narration_log_and_publishes_to_channel() -> None:
    # Real gap this closes: previously a single SET-overwritten key meant a
    # reconnecting client could only ever replay the LATEST narration event,
    # losing all prior activity-log history on any page reload even though
    # the job kept progressing server-side.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress())

    assert redis_client.rpush_calls[0][0] == "job-events:job-1:narration-log"
    assert redis_client.ltrim_calls[0][0] == "job-events:job-1:narration-log"
    assert redis_client.ltrim_calls[0][1:] == (-50, -1)  # same cap JobDetail.tsx keeps client-side
    assert redis_client.expire_calls[0][0] == "job-events:job-1:narration-log"
    assert redis_client.publish_calls[0][0] == "job-events:job-1"
    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["type"] == "narration"
    assert payload["phase"] == "analyze_section"
    assert payload["branchIndex"] == 0
    assert payload["branchCount"] == 3
    assert payload["blocksDone"] == 10
    assert payload["blocksTotal"] == 50
    assert payload["kbGrounded"] is False
    assert payload["kbCitations"] == []
    assert "message" in payload


def test_publish_includes_kb_citations_in_camelcase_when_grounded() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(kb_grounded=True, kb_citations=[{"source_file": "doc.docx", "similarity": 0.9}])
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["kbGrounded"] is True
    assert payload["kbCitations"] == [{"sourceFile": "doc.docx", "similarity": 0.9}]
    assert "grounded with 1 KB file" in payload["message"]


def test_publish_never_raises_when_redis_fails() -> None:
    redis_client = _FakeRedis(raises=RuntimeError("redis unavailable"))
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress())  # must not raise


def test_publish_message_includes_branch_position_when_branch_index_is_set() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(branch_index=2, branch_count=5))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert "section 3 of 5" in payload["message"]


def test_publish_message_omits_branch_position_when_branch_index_is_none() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="infer_trace_links", branch_index=None))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert "section" not in payload["message"]


def test_publish_includes_section_label_in_camelcase_and_the_message() -> None:
    # Without this, the UI could only ever show an anonymous "Section N of
    # M" -- no way to tell WHICH real content a job was analyzing/failed on.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(section_label="Backplane Power Budget"))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["sectionLabel"] == "Backplane Power Budget"
    assert "Backplane Power Budget" in payload["message"]


def test_publish_section_label_is_null_when_not_supplied() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress())

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["sectionLabel"] is None


def test_publish_includes_model_name_in_camelcase_and_the_message() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(model="llama3.1:70b-instruct"))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["model"] == "llama3.1:70b-instruct"
    assert "model: llama3.1:70b-instruct" in payload["message"]


def test_publish_model_is_null_when_not_supplied() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress())

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["model"] is None
    assert "model:" not in payload["message"]


def test_publish_score_requirements_message_uses_draft_count_not_raw_block_counter() -> None:
    # Without this, "scoring" reads the same frozen "N of Total blocks" text
    # as every other phase, even though the real draft count is already
    # known by the time scoring starts.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="score_requirements", draft_count=12))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["draftCount"] == 12
    assert "scoring 12 drafted requirement(s)" in payload["message"]
    assert "of 50 blocks" not in payload["message"]


def test_publish_score_requirements_done_message_reports_issues_found() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="score_requirements_done", issues_found=3))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["issuesFound"] == 3
    assert "3 quality issue(s) flagged" in payload["message"]


def test_publish_score_requirements_message_includes_batch_progress_when_chunk_fields_are_set() -> None:
    # Unlike figure/table totals, the whole document's requirement count is
    # known upfront -- chunk_index/chunk_count is real progress, not a guess.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="score_requirements", draft_count=150, chunk_index=1, chunk_count=4))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["chunkIndex"] == 1
    assert payload["chunkCount"] == 4
    assert "batch 2 of 4" in payload["message"]


def test_publish_score_requirements_done_message_includes_batch_progress() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="score_requirements_done", issues_found=2, chunk_index=0, chunk_count=2))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["chunkIndex"] == 0
    assert payload["chunkCount"] == 2
    assert "batch 1 of 2" in payload["message"]


def test_publish_score_requirements_message_omits_batch_progress_when_chunk_fields_are_absent() -> None:
    # A single-chunk document (the common case) never sets chunk_index/
    # chunk_count -- the message must not show a stray "batch" fragment.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="score_requirements", draft_count=12))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["chunkIndex"] is None
    assert payload["chunkCount"] is None
    assert "batch" not in payload["message"]


def test_publish_describe_figure_reports_a_running_count_not_a_fraction_when_no_total_known() -> None:
    # Without a figure_count (no pre-count ran ahead of this walk -- see
    # main.py's /ingest), this stays a running count ("figure 5 so far"),
    # not "5 of N" -- see the sibling test below for the case where a
    # pre-count DID run.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        LevelingProgress(
            phase="describe_figure",
            branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
            kb_grounded=False, kb_citations=[], figure_index=5,
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["figureIndex"] == 5
    assert "figure 5 so far" in payload["message"]
    # Must not fall through to the section-position/block-counter logic --
    # there is no section context at all during parse.
    assert "section" not in payload["message"]
    assert "blocks" not in payload["message"]


def test_publish_describe_figure_reports_a_real_total_when_a_precount_ran() -> None:
    # Real gap this closes (user-reported live): when main.py's /ingest ran a
    # structural pre-count ahead of the real walk, figure_count is known
    # up front -- the message should show "figure 5 of 39", not the
    # open-ended "figure 5 so far" the sibling test above covers.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        LevelingProgress(
            phase="describe_figure",
            branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
            kb_grounded=False, kb_citations=[], figure_index=5, figure_count=39,
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["figureCount"] == 39
    assert "figure 5 of 39" in payload["message"]
    assert "so far" not in payload["message"]


def test_publish_describe_figure_with_a_caption_shows_the_real_result_not_the_generic_counter() -> None:
    # Once the vision call returns, the SECOND describe_figure event (this
    # one) must show the actual caption text, not repeat the generic
    # "figure N so far" line -- that repetition (identical rows for every
    # figure) is exactly what made per-figure debugging impossible.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        LevelingProgress(
            phase="describe_figure",
            branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
            kb_grounded=False, kb_citations=[],
            figure_index=3, figure_caption="A schematic showing the power rail connections between PSU and backplane.",
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["figureCaption"] == "A schematic showing the power rail connections between PSU and backplane."
    assert payload["message"] == "Figure 3: A schematic showing the power rail connections between PSU and backplane."
    assert "so far" not in payload["message"]


def test_publish_describe_figure_with_an_empty_caption_falls_back_to_honest_wording_not_a_blank_line() -> None:
    # Real gap this closes (user-reported, live): a real vision-model reply
    # that's an empty string (distinct from None -- "in flight") previously
    # produced a bare "Figure N: " with nothing after the colon, a genuinely
    # blank-looking activity-log line.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        LevelingProgress(
            phase="describe_figure",
            branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
            kb_grounded=False, kb_citations=[],
            figure_index=38, figure_caption="",
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["message"] == "Figure 38: no useful caption returned"
    assert not payload["message"].endswith(": ")


def test_publish_preparing_analysis_carries_a_real_message() -> None:
    # Real gap this closes (user-reported, live): a multi-minute silent
    # window between parse_done and the first analyze_section event
    # previously left the UI showing nothing newer than "Finished parsing
    # the document", which made the "Reading document" step look
    # permanently stuck even though the pipeline had moved on.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        LevelingProgress(
            phase="preparing_analysis",
            branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
            kb_grounded=False, kb_citations=[],
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["phase"] == "preparing_analysis"
    assert "Preparing analysis" in payload["message"]
    assert "0 of 0" not in payload["message"]  # no bogus block-count suffix, blocksTotal isn't known yet


def test_publish_describe_figure_caption_is_truncated_in_the_message_but_not_in_the_raw_field() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")
    long_caption = "A" * 300

    publisher.publish(
        LevelingProgress(
            phase="describe_figure",
            branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
            kb_grounded=False, kb_citations=[],
            figure_index=1, figure_caption=long_caption,
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["figureCaption"] == long_caption  # full text preserved on the wire
    assert len(payload["message"]) < len(long_caption) + 20  # message itself is capped
    assert payload["message"].endswith("…")


def test_publish_parse_done_reports_block_table_and_figure_counts() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        LevelingProgress(
            phase="parse_done",
            branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
            kb_grounded=False, kb_citations=[],
            block_count=682, table_count=5, figure_count=39,
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["blockCount"] == 682
    assert payload["tableCount"] == 5
    assert payload["figureCount"] == 39
    assert "682 block(s), 5 table(s), 39 figure(s)" in payload["message"]


def test_publish_section_complete_carries_camelcased_section_nodes_and_a_count_message() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(
            phase="section_complete",
            section_nodes=[
                {"type": "Requirement", "title": "HDR support", "text": "The display shall support HDR.", "quality_score": 87, "customer_id": "P-SENSOR-001#"},
                {"type": "Feature", "title": "Display", "text": "The system shall handle: Display", "quality_score": None, "customer_id": None},
            ],
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["sectionNodes"] == [
        {"type": "Requirement", "title": "HDR support", "text": "The display shall support HDR.", "qualityScore": 87, "customerId": "P-SENSOR-001#"},
        {"type": "Feature", "title": "Display", "text": "The system shall handle: Display", "qualityScore": None, "customerId": None},
    ]
    assert "2 item(s) drafted" in payload["message"]


def test_publish_section_nodes_is_null_when_not_supplied() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress())

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["sectionNodes"] is None


def test_publish_detect_conflicts_and_regroup_roots_carry_a_real_message() -> None:
    # These two whole-tree passes previously had no narration phase at all --
    # confirmed live, a multi-minute silent gap between the last
    # score_requirements_done event and infer_trace_links on a large
    # document, exactly where these two LLM-calling passes run.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="detect_conflicts", branch_index=None))
    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["phase"] == "detect_conflicts"
    assert "conflict" in payload["message"].lower()

    publisher.publish(_progress(phase="regroup_roots", branch_index=None))
    payload = json.loads(redis_client.publish_calls[1][1])
    assert payload["phase"] == "regroup_roots"
    assert "topic" in payload["message"].lower()


def test_every_phase_has_a_message_template() -> None:
    # Permanent exhaustiveness guard. `_PHASE_MESSAGES` is a plain dict
    # literal, so -- unlike the frontend's `Record<Phase, ...>` maps, which
    # the TypeScript compiler refuses to build with a member missing -- adding
    # a member to the `Phase` Literal above and forgetting the matching entry
    # here type-checks, imports and passes every other test in this file
    # cleanly, then throws KeyError at `_format_message`'s unguarded subscript
    # the first time that phase actually fires in a real job. That is exactly
    # what happened to 'build_skeleton'/'map_scope': the subscript runs inside
    # publish()'s json.dumps(...) argument, i.e. BEFORE the try/except that
    # guarantees "narration must never fail a SURVEY job", so the KeyError
    # propagated out of the very first branch's very first narration event and
    # failed every SURVEY job outright.
    #
    # 'chunk_warning' is the ONE legitimate exclusion: _format_message
    # early-returns the caller's own already-complete warning string for it,
    # before reaching this dict at all.
    assert set(get_args(Phase)) - {"chunk_warning"} <= set(_PHASE_MESSAGES)


def test_publish_build_skeleton_carries_a_real_message() -> None:
    # Goes through the REAL publisher (not a raw progress_callback lambda) on
    # purpose: B5 added 'build_skeleton' to the Phase Literal and wired all
    # three frontend Records, but never added a _PHASE_MESSAGES entry, and its
    # own tests only ever collected LevelingProgress objects from a lambda --
    # which never formats a message, so the KeyError this asserts against
    # stayed invisible through three green suites.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="build_skeleton"))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["phase"] == "build_skeleton"
    assert payload["message"] == (
        "Deciding this section's work-item structure (section 1 of 3) -- 10 of 50 blocks"
    )


def test_publish_map_scope_carries_a_real_message() -> None:
    # Same real-publisher reasoning as build_skeleton above. map_scope is a
    # whole-document phase (branch_index=None, same convention
    # detect_conflicts/regroup_roots/infer_trace_links use), so its message
    # carries no "(section N of M)" prefix -- just the block tally every other
    # whole-document tail phase reports.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="map_scope", branch_index=None, blocks_done=50))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["phase"] == "map_scope"
    assert payload["message"] == "Mapping figures and tables to their work items -- 50 of 50 blocks"


def test_publish_deterministic_subtree_carries_index_count_and_label() -> None:
    # Real gap this closes: _detect_deterministic_subtrees ran immediately
    # after preparing_analysis with zero narration of its own -- confirmed
    # live as a genuine 20+ minute silent window on a document with many
    # ID-hierarchy rows.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(
            phase="deterministic_subtree", branch_index=None, branch_count=0,
            subtree_index=1, subtree_count=3, subtree_label="Table t2",
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["subtreeIndex"] == 1
    assert payload["subtreeCount"] == 3
    assert payload["subtreeLabel"] == "Table t2"
    assert "2 of 3" in payload["message"]
    assert "Table t2" in payload["message"]


def test_publish_table_detected_reports_row_count_and_qualifying_status() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(
            phase="table_detected", branch_index=None, branch_count=0,
            table_id="t1", table_row_count=42, table_qualifies=True,
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["tableId"] == "t1"
    assert payload["tableRowCount"] == 42
    assert payload["tableQualifies"] is True
    assert "t1" in payload["message"]
    assert "42 row" in payload["message"]
    assert "qualifies" in payload["message"].lower()


def test_publish_table_detected_reports_position_and_total() -> None:
    # table_detected fires from a post-parse loop over the full table list,
    # so index/total are always known -- unlike figures, no pre-count is
    # needed for this one.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(
            phase="table_detected", branch_index=None, branch_count=0,
            table_id="t1", table_row_count=42, table_qualifies=True,
            table_index=2, table_count=5,
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["tableIndex"] == 2
    assert payload["tableCount"] == 5
    assert "table 2 of 5" in payload["message"]


def test_publish_table_detected_reports_non_qualifying_tables_honestly() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(
            phase="table_detected", branch_index=None, branch_count=0,
            table_id="t2", table_row_count=0, table_qualifies=False,
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert "not id-shaped" in payload["message"].lower()


def test_publish_score_requirements_message_includes_sample_titles() -> None:
    # Previously only a bare count ("150 drafted requirement(s)") -- no way
    # to tell which actual items were being scored.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(
            phase="score_requirements", draft_count=2,
            sample_titles=["12V Compliance Standards", "3.3V Aux Compliance Standards"],
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["sampleTitles"] == ["12V Compliance Standards", "3.3V Aux Compliance Standards"]
    assert "12V Compliance Standards" in payload["message"]


def test_publish_job_failed_reports_error_type_message_elapsed_and_last_phase() -> None:
    # Real gap this closes: a job that failed deep inside build_survey_tree
    # previously surfaced nothing beyond a flattened one-line AuditEntry
    # ("Pipeline failed: Ingestion /level request failed: timed out") -- no
    # phase, no elapsed time, no real exception type.
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(
            phase="job_failed", branch_index=None, branch_count=0,
            error_type="ReadTimeout", error_message="timed out",
            elapsed_seconds=1523.4, last_phase="score_requirements",
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["errorType"] == "ReadTimeout"
    assert payload["errorMessage"] == "timed out"
    assert payload["elapsedSeconds"] == 1523.4
    assert payload["lastPhase"] == "score_requirements"
    assert "timed out" in payload["message"]
    assert "ReadTimeout" in payload["message"]
    assert "score_requirements" in payload["message"]
    assert "1523" in payload["message"]


def test_last_known_phase_is_recorded_on_every_publish_and_readable_across_instances() -> None:
    # _LAST_PHASE_BY_JOB is process-global, keyed by job_id -- /level's
    # exception handler constructs a FRESH NarrationPublisher instance to
    # send job_failed, so this must be readable independent of which
    # publisher instance recorded it.
    from app.leveling.narration_publisher import last_known_phase

    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-last-phase-test")

    assert last_known_phase("job-last-phase-test") is None
    publisher.publish(_progress(phase="analyze_section"))
    assert last_known_phase("job-last-phase-test") == "analyze_section"
    publisher.publish(_progress(phase="score_requirements"))
    assert last_known_phase("job-last-phase-test") == "score_requirements"


def test_last_known_phase_is_recorded_even_when_the_redis_publish_itself_fails() -> None:
    # Exactly the scenario job_failed narration most needs to be accurate
    # in -- a Redis outage is a plausible co-occurring failure, not just an
    # LLM timeout, and last_known_phase must not depend on publish()
    # actually succeeding.
    from app.leveling.narration_publisher import last_known_phase

    redis_client = _FakeRedis(raises=ConnectionError("boom"))
    publisher = NarrationPublisher(redis_client, "job-last-phase-outage")

    publisher.publish(_progress(phase="regroup_roots"))

    assert last_known_phase("job-last-phase-outage") == "regroup_roots"
