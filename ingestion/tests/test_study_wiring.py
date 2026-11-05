"""The concurrent document study (app.leveling.study_runner) wired into build_survey_tree: started first, joined by the criteria step,
and always stopped by the wrapper, whichever way the job ends."""
import inspect
import threading

import pytest

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat
from app.config import settings
from app.job_cancel import CancelToken, JobCancelled, cancellation_scope
from app.kb.profile import windows_of
from app.leveling.document_study import STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP
from app.leveling import llm_leveling as llm_leveling_module
from app.leveling.llm_leveling import _propose_criteria_step, build_survey_tree, render_section
from app.leveling.study_runner import StudyHandle, StudyOutcome
from app.leveling.study_store import StudyStore
from app.request_identity import user_scope
from app.workitem.model import WarningKind
from tests.test_llm_leveling import (
    _EMPTY_STUDY, FakeScoringClient, FakeSectionAnalysisClient, _BrokenStudy, _CriteriaForEveryKey, _CriteriaSpy, _flagged_requirement,
    _flagged_scoring, _long_doc, _small_doc, _sr, _structural_heading_doc,
)
from tests.test_study_runner import _doc, _Limiter, _Redis, _Stub

WAIT = 10.0
USER = "user-a"
MODEL = "model-a"


@pytest.fixture(autouse=True)
def _no_study_thread_survives():
    yield
    leaked = [t for t in threading.enumerate() if t.name.startswith(("study-coordinator", "study-worker"))]
    for thread in leaked:
        thread.join(5)
    assert not [t for t in leaked if t.is_alive()], "a study thread outlived its test"


class _EventStudy:
    """Answers every window at once; `requested` is set when a window is first asked for, `done` when one has been answered."""

    def __init__(self) -> None:
        self.requested = threading.Event()
        self.done = threading.Event()
        self.windows: list[str] = []

    def study_document_window(self, window_text, user_id=None):
        self.windows.append(window_text)
        self.requested.set()
        try:
            return {**_EMPTY_STUDY}
        finally:
            self.done.set()


class _HookedScoring(FakeScoringClient):
    """Flags n1 as lacking acceptance criteria, after running `before` (which may raise)."""

    def __init__(self, before=None, flag=True) -> None:
        super().__init__({"n0": {"score": 90, "issues": []}, "n1": {"score": 40 if flag else 90, "issues": ["missing_acceptance_criteria"] if flag else []}})
        self.before = before

    def score_requirements_for_document(self, descriptions_by_node_id, *args, **kwargs):
        if self.before is not None:
            self.before()
        return super().score_requirements_for_document(descriptions_by_node_id, *args, **kwargs)


class _OrderedCriteria(_CriteriaSpy):
    """Records whether the study had answered by the time the criteria were asked for."""

    def __init__(self, study: _EventStudy) -> None:
        super().__init__()
        self.study = study
        self.study_done_at_call: bool | None = None

    def propose_acceptance_criteria(self, items_by_id, user_id=None):
        self.study_done_at_call = self.study.done.is_set()
        return super().propose_acceptance_criteria(items_by_id, user_id=user_id)


def _two_window_doc() -> CanonicalDoc:
    path = "two_windows.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text=_doc(2), source_ref=_sr(path)),
        ],
    )


def _window_count(doc: CanonicalDoc) -> int:
    return len(windows_of(render_section(doc.blocks, doc.tables), STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP))


def _stored_keys(redis: _Redis) -> list[str]:
    return list(redis.data)


def test_study_starts_before_scoring_and_joins_before_criteria() -> None:
    study = _EventStudy()
    criteria = _OrderedCriteria(study)
    seen: list[bool] = []
    scoring = _HookedScoring(before=lambda: seen.append(study.requested.wait(WAIT)))

    build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), scoring_client=scoring, acceptance_criteria_client=criteria, document_study_client=study,
    )

    assert seen and seen[0] is True  # a window was requested before the scoring client was first called
    assert criteria.study_done_at_call is True  # and the study had finished when the criteria were asked for


def test_study_runs_on_the_deterministic_path_too() -> None:
    study = _EventStudy()
    criteria = _OrderedCriteria(study)

    tree = build_survey_tree(
        _structural_heading_doc(), FakeSectionAnalysisClient(), scoring_client=_CriteriaForEveryKey(),
        acceptance_criteria_client=criteria, document_study_client=study,
    )

    assert len(study.windows) == 1 and "The system shall do A." in study.windows[0]
    assert criteria.study_done_at_call is True
    assert any("Proposed acceptance criteria" in n.description for n in tree.nodes)


def test_positional_arguments_still_work_on_the_public_wrapper() -> None:
    study, criteria = _EventStudy(), _CriteriaSpy()
    names = list(inspect.signature(build_survey_tree).parameters)
    given = {
        "doc": _small_doc(), "analysis_client": FakeSectionAnalysisClient(), "scoring_client": _flagged_scoring(),
        "acceptance_criteria_client": criteria, "document_study_client": study,
    }
    defaults = {name: p.default for name, p in inspect.signature(build_survey_tree).parameters.items()}
    chunk_at = names.index("chunk_concurrency")
    positional = [given.get(name, defaults[name]) for name in names[: chunk_at + 1]]  # up to and including the last pre-study parameter
    assert names.index("study_store") < chunk_at and names[chunk_at + 1:] == ["study_limiter"]  # no existing position moved

    tree = build_survey_tree(*positional)

    assert len(study.windows) == 1 and list(criteria.calls[0]) == ["n1"]
    assert any("Proposed acceptance criteria" in n.description for n in tree.nodes)


def test_exception_in_the_pipeline_stops_the_study_and_cleans_its_keys(monkeypatch) -> None:
    doc, redis = _two_window_doc(), _Redis()
    stub = _Stub(_window_count(doc), hold={1})

    def boom(*args, **kwargs) -> None:  # a client error is fail-open inside the scoring stage; an unexpected bug in it is not
        assert redis.stored.wait(WAIT)  # window 0 is stored, window 1 is still being read
        raise RuntimeError("scoring down")

    monkeypatch.setattr(llm_leveling_module, "_score_all_requirements", boom)

    try:
        with pytest.raises(RuntimeError, match="scoring down"):
            build_survey_tree(
                doc, FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
                document_study_client=stub, study_store=StudyStore(redis, 3600), user_id=USER, model=MODEL,
            )
        assert stub.started[1].is_set() and not stub.finished[1].is_set()  # the study was still running
        assert _stored_keys(redis) == []
    finally:
        stub.open_all()


def test_cancellation_propagates_and_cleans_up() -> None:
    doc, redis = _two_window_doc(), _Redis()
    stub = _Stub(_window_count(doc), hold={1})
    token = CancelToken()

    def cancel() -> None:  # the run is cancelled mid-job; the criteria step then finds the study cancelled with it
        assert redis.stored.wait(WAIT)
        token.cancel()

    try:
        with cancellation_scope(token):
            with pytest.raises(JobCancelled):
                build_survey_tree(
                    doc, FakeSectionAnalysisClient(), scoring_client=_HookedScoring(before=cancel), acceptance_criteria_client=_CriteriaSpy(),
                    document_study_client=stub, study_store=StudyStore(redis, 3600), user_id=USER, model=MODEL,
                )
        assert stub.started[1].is_set() and not stub.finished[1].is_set()
        assert _stored_keys(redis) == []
    finally:
        stub.open_all()


def test_study_cancelled_error_is_never_swallowed_by_the_step() -> None:
    class _Handle:
        stopped: list[bool] = []

        def stop(self, keep_results):
            self.stopped.append(keep_results)

        def result(self, timeout=None):
            raise JobCancelled("gone")

    warnings: list = []

    with pytest.raises(JobCancelled):
        _propose_criteria_step([_flagged_requirement()], _small_doc(), _CriteriaSpy(), None, warnings, study_handle=_Handle())

    assert warnings == []


def test_no_eligible_requirement_keeps_finished_windows_and_stops_the_study(monkeypatch) -> None:
    monkeypatch.setattr(llm_leveling_module, "eligible_nodes", lambda nodes: [])  # eligibility is decided by the text (see test_acceptance_criteria)
    doc, redis = _two_window_doc(), _Redis()
    stub = _Stub(_window_count(doc), hold={1})
    criteria = _CriteriaSpy()
    scoring = _HookedScoring(before=lambda: redis.stored.wait(WAIT), flag=False)  # nothing is flagged, but window 0 is stored first

    try:
        tree = build_survey_tree(
            doc, FakeSectionAnalysisClient(), scoring_client=scoring, acceptance_criteria_client=criteria, document_study_client=stub,
            study_store=StudyStore(redis, 3600), user_id=USER, model=MODEL,
        )
        assert criteria.calls == []
        assert stub.started[1].is_set() and not stub.finished[1].is_set()  # the study was stopped while still reading
        assert len(_stored_keys(redis)) >= 1  # what had been read stays as the cache
        assert not [w for w in tree.warnings if w.detail.get("pass") == "document_study"]
    finally:
        stub.open_all()


def test_off_switch_skips_the_study_entirely(monkeypatch) -> None:
    monkeypatch.setattr(settings, "survey_study_enabled", False)
    study = _EventStudy()

    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
        document_study_client=study,
    )

    assert study.windows == []
    assert not [w for w in tree.warnings if w.detail.get("pass") == "document_study"]
    assert any("Proposed acceptance criteria" in n.description for n in tree.nodes)


def test_no_user_id_still_studies_but_uncached_and_unlimited() -> None:
    class _SpyRedis:
        def __init__(self) -> None:
            self.calls: list = []

        def get(self, *args, **kwargs):
            self.calls.append("get")

        def set(self, *args, **kwargs):
            self.calls.append("set")
            return True

        def delete(self, *args, **kwargs):
            self.calls.append("delete")

    redis, limiter, study = _SpyRedis(), _Limiter(), _EventStudy()

    build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
        document_study_client=study, study_store=StudyStore(redis, 60), study_limiter=limiter,
    )

    assert len(study.windows) == 1
    assert redis.calls == [] and limiter.acquires == []


def test_study_warnings_become_integrity_warnings_in_the_main_thread() -> None:
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
        document_study_client=_BrokenStudy(),
    )
    ours = [w for w in tree.warnings if w.detail.get("pass") == "document_study"]
    assert len(ours) == 1 and ours[0].kind == WarningKind.DOCUMENT_STUDY_INCOMPLETE and "none of the document" in ours[0].raw

    class _FailsOneWindow:
        def __init__(self) -> None:
            self.lock = threading.Lock()
            self.calls = 0

        def study_document_window(self, window_text, user_id=None):
            with self.lock:
                self.calls += 1
                failing = self.calls == 2
            if failing:
                raise RuntimeError("model down")
            return {**_EMPTY_STUDY}

    tree = build_survey_tree(
        _long_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
        document_study_client=_FailsOneWindow(),
    )
    ours = [w for w in tree.warnings if w.detail.get("pass") == "document_study"]
    assert len(ours) == 1 and "1 of 2 parts" in ours[0].raw


def test_a_study_that_could_not_start_gives_one_warning_and_a_tree_from_the_hierarchy_alone(monkeypatch) -> None:
    def failing_start(self):
        raise RuntimeError("no thread")

    monkeypatch.setattr(StudyHandle, "start", failing_start)
    study, criteria = _EventStudy(), _CriteriaSpy()

    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=criteria,
        document_study_client=study,
    )

    ours = [w for w in tree.warnings if w.detail.get("pass") == "document_study"]
    assert len(ours) == 1 and ours[0].kind == WarningKind.DOCUMENT_STUDY_INCOMPLETE and "could not be started" in ours[0].raw
    assert study.windows == []  # nothing reads the document on the job's thread
    assert list(criteria.calls[0]) == ["n1"] and "Proposed acceptance criteria" in {n.local_id: n for n in tree.nodes}["n1"].description


@pytest.mark.parametrize("enabled, study_client", [(False, _EventStudy()), (True, None)])
def test_no_handle_and_no_study_wanted_proposes_without_a_warning(enabled, study_client) -> None:
    warnings: list = []
    node = _flagged_requirement()

    _propose_criteria_step([node], _small_doc(), _CriteriaSpy(), study_client, warnings, study_enabled=enabled)

    assert warnings == [] and "Proposed acceptance criteria" in node.description


def test_concurrency_4_gives_the_same_tree_as_concurrency_1(monkeypatch) -> None:
    def tree_with(concurrency: int):
        monkeypatch.setattr(settings, "survey_study_concurrency", concurrency)
        tree = build_survey_tree(
            _two_window_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
            document_study_client=_Stub(_window_count(_two_window_doc())),
        )
        return [(n.local_id, n.title, n.description) for n in tree.nodes], [w.raw for w in tree.warnings]

    assert tree_with(4) == tree_with(1)


def test_limiter_is_used_when_given() -> None:
    limiter = _Limiter()

    build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
        document_study_client=_EventStudy(), study_limiter=limiter, user_id=USER, model=MODEL,
    )

    assert limiter.acquires and all(a[:2] == (MODEL, user_scope(USER)) for a in limiter.acquires)
    assert limiter.released == len(limiter.acquires) and limiter.held == 0


def test_survey_study_enabled_setting_default() -> None:
    from app.config import Settings

    assert Settings().survey_study_enabled is True


def test_a_study_outcome_is_all_the_step_reads_from_the_handle() -> None:
    class _Handle:
        def stop(self, keep_results):
            raise AssertionError("an eligible requirement must not stop the study")

        def result(self, timeout=None):
            return StudyOutcome(None, ("first", "second"), "error")

    warnings: list = []

    _propose_criteria_step([_flagged_requirement()], _small_doc(), _CriteriaSpy(), None, warnings, study_handle=_Handle())

    assert [w.raw for w in warnings] == ["first", "second"]
    assert all(w.detail == {"pass": "document_study"} for w in warnings)


def test_the_study_text_is_a_snapshot_rendered_on_the_calling_thread(monkeypatch) -> None:
    """The study thread must read a string taken before any stage runs, never the live blocks: so the document is rendered by the job's own
    thread, and no `study-coordinator` thread ever renders it."""
    rendered_on: list[str] = []
    real = llm_leveling_module.render_section

    def spy(*args, **kwargs):
        rendered_on.append(threading.current_thread().name)
        return real(*args, **kwargs)

    monkeypatch.setattr(llm_leveling_module, "render_section", spy)

    build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(),
        acceptance_criteria_client=_CriteriaSpy(), document_study_client=_EventStudy(),
    )

    assert rendered_on and "study-coordinator" not in rendered_on
    assert rendered_on[0] == threading.current_thread().name  # the snapshot is the first render, taken before the pipeline starts


def _starting_fails(monkeypatch, what) -> None:
    if what == "start":
        def boom(self) -> None:
            raise RuntimeError("can't start new thread for user-a")

        monkeypatch.setattr(llm_leveling_module.StudyHandle, "start", boom)
    else:
        real, calls = llm_leveling_module.render_section, []

        def render(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:  # the wrapper's snapshot of the document is the first render
                raise ValueError("cannot render user-a")
            return real(*args, **kwargs)

        monkeypatch.setattr(llm_leveling_module, "render_section", render)


@pytest.mark.parametrize("what", ["start", "render"])
def test_a_study_that_cannot_start_never_fails_the_job(monkeypatch, caplog, what) -> None:
    _starting_fails(monkeypatch, what)
    criteria = _CriteriaForEveryKey()

    with caplog.at_level("WARNING"):
        tree = build_survey_tree(
            _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=criteria,
            document_study_client=_EventStudy(), user_id=USER,
        )

    assert tree.nodes  # the criteria step ran its sequential fallback
    lines = [r.getMessage() for r in caplog.records if "Document study" in r.getMessage() and "could not start" in r.getMessage()]
    assert len(lines) == 1 and ("RuntimeError" if what == "start" else "ValueError") in lines[0]
    assert USER not in lines[0] and "can't start" not in lines[0] and "cannot render" not in lines[0]


def test_a_job_cancelled_while_starting_the_study_still_stops(monkeypatch) -> None:
    def cancelled(self) -> None:
        raise JobCancelled("gone")

    monkeypatch.setattr(llm_leveling_module.StudyHandle, "start", cancelled)

    with pytest.raises(JobCancelled):
        build_survey_tree(
            _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
            document_study_client=_EventStudy(), user_id=USER,
        )


def _fail_after_the_criteria_step(monkeypatch, error: BaseException) -> None:
    """The criteria step runs for real (it joins or stops the study), then the job fails."""
    real = llm_leveling_module._propose_criteria_step

    def step(*args, **kwargs):
        real(*args, **kwargs)
        raise error

    monkeypatch.setattr(llm_leveling_module, "_propose_criteria_step", step)


def _run_two_window_job(redis: _Redis, **kwargs):
    doc = _two_window_doc()
    return build_survey_tree(
        doc, FakeSectionAnalysisClient(), scoring_client=kwargs.pop("scoring", _flagged_scoring()), acceptance_criteria_client=_CriteriaSpy(),
        document_study_client=_Stub(_window_count(doc)), study_store=StudyStore(redis, 3600), user_id=USER, model=MODEL, **kwargs,
    )


def test_completed_study_keys_are_deleted_when_the_job_later_fails(monkeypatch) -> None:
    redis = _Redis()
    _fail_after_the_criteria_step(monkeypatch, RuntimeError("write-back down"))

    with pytest.raises(RuntimeError, match="write-back down"):
        _run_two_window_job(redis)

    assert _stored_keys(redis) == []


def test_completed_study_keys_are_deleted_when_the_job_is_later_cancelled(monkeypatch) -> None:
    redis = _Redis()
    _fail_after_the_criteria_step(monkeypatch, JobCancelled("gone"))

    with pytest.raises(JobCancelled):
        _run_two_window_job(redis)

    assert _stored_keys(redis) == []


def test_completed_study_keys_are_kept_when_the_job_finishes_normally() -> None:
    redis = _Redis()

    _run_two_window_job(redis)

    assert len(_stored_keys(redis)) == _window_count(_two_window_doc())


def test_no_eligible_requirement_keys_are_deleted_when_the_job_later_fails(monkeypatch) -> None:
    redis = _Redis()
    _fail_after_the_criteria_step(monkeypatch, RuntimeError("write-back down"))

    with pytest.raises(RuntimeError, match="write-back down"):
        _run_two_window_job(redis, scoring=_HookedScoring(before=lambda: redis.stored.wait(WAIT), flag=False))

    assert _stored_keys(redis) == []


def test_close_failure_does_not_mask_the_original_exception(monkeypatch) -> None:
    def broken_close(self, *args, **kwargs) -> None:
        raise OSError("close failed")

    monkeypatch.setattr(llm_leveling_module.StudyHandle, "close", broken_close)
    monkeypatch.setattr(llm_leveling_module, "_propose_criteria_step", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("the job's own")))

    with pytest.raises(RuntimeError, match="the job's own"):
        build_survey_tree(
            _small_doc(), FakeSectionAnalysisClient(), scoring_client=_flagged_scoring(), acceptance_criteria_client=_CriteriaSpy(),
            document_study_client=_EventStudy(), user_id=USER,
        )
