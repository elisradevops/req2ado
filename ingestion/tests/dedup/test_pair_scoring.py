import json

import httpx
import pytest

from app.dedup.pair_scoring import load_text_pairs, ollama_embedder, score_pairs


def fake_embed(texts: list[str]) -> list[list[float]]:
    # One axis per word the tests use, so similarity is easy to predict.
    vocab = ["drop", "volt", "usb"]
    return [[float(word in text) for word in vocab] or [0.0] for text in texts]


def row(a: str, b: str, label: int, **extra) -> dict:
    return {"a": a, "b": b, "label": label, **extra}


def test_identical_meaning_scores_one_and_unrelated_scores_zero() -> None:
    scored = score_pairs([row("survive a drop", "withstand a drop", 1), row("a drop", "18 volt supply", 0)], fake_embed)

    assert scored[0]["score"] == pytest.approx(1.0)
    assert scored[1]["score"] == pytest.approx(0.0)


def test_each_scored_row_keeps_its_label_language_and_source_for_the_evaluation() -> None:
    scored = score_pairs([row("a drop", "a drop", 1, lang="he", source="draft")], fake_embed)

    assert scored[0] == {"score": pytest.approx(1.0), "label": 1, "lang": "he", "source": "draft"}


def test_a_title_is_blended_with_the_text_like_the_real_check() -> None:
    # title says "usb" for both, text says drop vs volt: the blend moves the score off the text-only value
    plain = score_pairs([row("a drop", "a volt", 0)], fake_embed)[0]["score"]
    blended = score_pairs([row("a drop", "a volt", 0, title_a="usb", title_b="usb")], fake_embed)[0]["score"]

    assert plain == pytest.approx(0.0)
    assert blended > 0.4


def test_every_text_is_embedded_in_one_call_not_one_per_pair() -> None:
    calls: list[int] = []

    def counting(texts: list[str]) -> list[list[float]]:
        calls.append(len(texts))
        return fake_embed(texts)

    score_pairs([row("a drop", "a drop", 1), row("a volt", "a usb", 0)], counting)

    assert len(calls) == 1


def test_load_text_pairs_reads_jsonl_and_skips_blank_lines(tmp_path) -> None:
    path = tmp_path / "pairs.jsonl"
    path.write_text(json.dumps(row("x", "y", 1, lang="he")) + "\n\n" + json.dumps(row("p", "q", 0)) + "\n", encoding="utf-8")

    rows = load_text_pairs(path)

    assert [r["label"] for r in rows] == [1, 0]
    assert rows[0]["lang"] == "he"


def test_load_text_pairs_names_the_line_it_cannot_use(tmp_path) -> None:
    path = tmp_path / "pairs.jsonl"
    path.write_text(json.dumps(row("x", "y", 1)) + "\n" + json.dumps({"a": "only one side", "label": 0}) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="line 2"):
        load_text_pairs(path)


def test_the_ollama_embedder_posts_model_and_input_with_the_bearer_key_and_batches_the_texts() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append({"auth": request.headers.get("authorization"), "url": str(request.url), "model": body["model"], "n": len(body["input"])})
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0] for _ in body["input"]]})

    embed = ollama_embedder("http://host:3000", "/ollama/api/embed", "bge-m3:latest", "sk-key", batch_size=2, transport=httpx.MockTransport(handler))

    vectors = embed(["a", "b", "c"])

    assert len(vectors) == 3
    assert [call["n"] for call in seen] == [2, 1]
    assert seen[0] == {"auth": "Bearer sk-key", "url": "http://host:3000/ollama/api/embed", "model": "bge-m3:latest", "n": 2}


def test_the_ollama_embedder_says_what_went_wrong_instead_of_returning_a_short_list() -> None:
    embed = ollama_embedder("http://host:3000", "/ollama/api/embed", "bge-m3:latest", None, transport=httpx.MockTransport(lambda request: httpx.Response(404, text="model not found")))

    with pytest.raises(RuntimeError, match="404"):
        embed(["a"])

