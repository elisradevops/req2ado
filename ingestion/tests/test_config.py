def test_survey_chunk_concurrency_defaults_to_one() -> None:
    # Same default and same reasoning as survey_branch_concurrency (see
    # config.py's own doc comment): opting in is an operator decision made
    # in coordination with whoever runs the LLM backend, never a default.
    from app.config import Settings

    assert Settings().survey_chunk_concurrency == 1


def test_survey_chunk_concurrency_reads_its_env_var(monkeypatch) -> None:
    from app.config import Settings

    monkeypatch.setenv("SURVEY_CHUNK_CONCURRENCY", "4")

    assert Settings().survey_chunk_concurrency == 4


def test_survey_chunk_concurrency_treats_a_blank_env_var_as_unset(monkeypatch) -> None:
    # `SURVEY_CHUNK_CONCURRENCY=` (present but blank) is a real shape in a
    # hand-edited .env -- an operator "turning it off" by emptying the value
    # rather than deleting the line. Without env_ignore_empty that parses as
    # the empty string and raises a pydantic ValidationError at import time,
    # taking down the whole ingestion process instead of falling back to the
    # default.
    from app.config import Settings

    monkeypatch.setenv("SURVEY_CHUNK_CONCURRENCY", "")

    assert Settings().survey_chunk_concurrency == 1


def test_vision_caption_concurrency_defaults_to_one() -> None:
    # Same default and same reasoning as survey_branch_concurrency (see
    # config.py's own doc comment): a client-side fan-out is an operator
    # decision made in coordination with whoever runs the vision backend,
    # never a default. 1 means no ThreadPoolExecutor is constructed at all.
    from app.config import Settings

    assert Settings().vision_caption_concurrency == 1


def test_vision_caption_concurrency_reads_its_env_var(monkeypatch) -> None:
    from app.config import Settings

    monkeypatch.setenv("VISION_CAPTION_CONCURRENCY", "6")

    assert Settings().vision_caption_concurrency == 6
