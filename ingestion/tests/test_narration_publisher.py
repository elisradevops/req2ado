import json

from app.leveling.narration_publisher import LevelingProgress, NarrationPublisher


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


def test_publish_describe_figure_reports_a_running_count_not_a_fraction() -> None:
    # The parse-stage figure loop doesn't know the document's total figure
    # count until it finishes walking the whole document, so this is
    # deliberately a running count ("figure 5 so far"), not "5 of N".
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
                {"type": "Requirement", "title": "HDR support", "text": "The display shall support HDR.", "quality_score": 87},
                {"type": "Feature", "title": "Display", "text": "The system shall handle: Display", "quality_score": None},
            ],
        )
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["sectionNodes"] == [
        {"type": "Requirement", "title": "HDR support", "text": "The display shall support HDR.", "qualityScore": 87},
        {"type": "Feature", "title": "Display", "text": "The system shall handle: Display", "qualityScore": None},
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
