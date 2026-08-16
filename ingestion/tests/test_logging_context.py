import logging

from app.logging_context import JobIdLogFilter, job_id_scope


def _record(name: str = "app.leveling.llm_leveling") -> logging.LogRecord:
    return logging.LogRecord(name, logging.WARNING, __file__, 1, "test message", None, None)


def test_job_id_log_filter_defaults_to_dash_outside_any_scope() -> None:
    record = _record()
    JobIdLogFilter().filter(record)
    assert record.job_id == "-"


def test_job_id_log_filter_picks_up_the_current_scope() -> None:
    with job_id_scope("job-abc-123"):
        record = _record()
        JobIdLogFilter().filter(record)
    assert record.job_id == "job-abc-123"


def test_job_id_scope_resets_after_exiting_the_with_block() -> None:
    with job_id_scope("job-abc-123"):
        pass
    record = _record()
    JobIdLogFilter().filter(record)
    assert record.job_id == "-"


def test_job_id_scope_does_not_leak_across_nested_scopes() -> None:
    with job_id_scope("outer"):
        with job_id_scope("inner"):
            inner_record = _record()
            JobIdLogFilter().filter(inner_record)
        outer_record = _record()
        JobIdLogFilter().filter(outer_record)
    assert inner_record.job_id == "inner"
    assert outer_record.job_id == "outer"


def test_job_id_log_filter_does_not_override_an_explicitly_set_job_id(caplog) -> None:
    # A record that already carries job_id (e.g. via extra={"job_id": ...})
    # must not be clobbered by the ambient contextvar.
    with job_id_scope("ambient-job"):
        record = _record()
        record.job_id = "explicit-job"
        JobIdLogFilter().filter(record)
    assert record.job_id == "explicit-job"


def test_build_survey_tree_warning_carries_job_id_through_run_in_threadpool() -> None:
    """End-to-end regression: a real logger.warning fired from deep inside
    llm_leveling.py must carry the job_id set via job_id_scope() around the
    call -- even when build_survey_tree runs on a worker thread via
    starlette.concurrency.run_in_threadpool (the exact mechanism app.main
    uses for _build_survey_tree_with_scoring), not the caller's own task.
    Forces a real warning: a client that produces 0 nodes from a non-empty
    branch (llm_leveling.py's own "produced 0 work items" warning)."""
    import asyncio

    from starlette.concurrency import run_in_threadpool

    from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
    from app.leveling.llm_leveling import build_survey_tree

    class _EmptyResultClient:
        def analyze_section_skeleton(self, *args, **kwargs):
            return [], False

    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="b0", kind=BlockKind.PARAGRAPH,
                text="The system shall power on within 2 seconds.",
                source_ref=SourceRef(document_path="x.txt", start_offset=0, end_offset=10),
            ),
        ],
    )

    root_logger = logging.getLogger()
    handler = logging.StreamHandler()
    handler.addFilter(JobIdLogFilter())
    captured_records: list[logging.LogRecord] = []

    class _CapturingFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            captured_records.append(record)
            return True

    handler.addFilter(_CapturingFilter())
    root_logger.addHandler(handler)

    def _build_with_job_scope() -> None:
        # Mirrors app.main._build_survey_tree_with_scoring's actual shape:
        # job_id_scope is entered INSIDE the function that runs on the
        # worker thread, not around the outer await -- the contextvar is
        # set directly on the thread build_survey_tree itself executes on.
        with job_id_scope("job-thread-test-123"):
            build_survey_tree(doc, _EmptyResultClient())

    try:
        asyncio.run(run_in_threadpool(_build_with_job_scope))
    finally:
        root_logger.removeHandler(handler)

    zero_node_warnings = [r for r in captured_records if "produced 0 work items" in r.getMessage()]
    assert len(zero_node_warnings) == 1
    assert zero_node_warnings[0].job_id == "job-thread-test-123"
