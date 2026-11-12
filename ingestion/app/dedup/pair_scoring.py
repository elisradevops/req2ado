"""Turns labelled TEXT pairs into scored pairs the evaluation (evaluation.py) can read, using whatever embedding function it is given.

A row is {"a": text, "b": text, "label": 1 or 0, "lang": "he"|"en"|..., "source": "...", optional "title_a"/"title_b"}. The real check embeds a
title and a description separately and averages them (embedding_blend.py); a row with titles is scored the same way, one without uses its
text for both, which leaves the vector as it is. Every text goes to the embedding function in ONE call. Pure: the function is passed in, so
this runs without a network in tests.
"""

from __future__ import annotations

import csv
import json
import re
from collections.abc import Callable
from pathlib import Path

import httpx

from app.dedup.embedding_blend import blend_embeddings
from app.dedup.evaluation import cosine

Embed = Callable[[list[str]], list[list[float]]]


def load_text_pairs(path: Path) -> list[dict]:
    rows: list[dict] = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if not isinstance(row.get("a"), str) or not isinstance(row.get("b"), str):
                raise ValueError("needs text in both a and b")
            if row.get("label") not in (0, 1):
                raise ValueError("label must be 0 or 1")
        except (ValueError, TypeError) as exc:
            raise ValueError(f"line {number}: {exc}") from exc
        rows.append(row)
    return rows


_HEBREW = re.compile(r"[\u0590-\u05FF]")


def detect_lang(a: str, b: str) -> str:
    """"he" when both texts have Hebrew letters, "he-en" when only one does, otherwise "en" (the label the evaluation splits by)."""
    hebrew_a, hebrew_b = bool(_HEBREW.search(a)), bool(_HEBREW.search(b))
    if hebrew_a and hebrew_b:
        return "he"
    return "he-en" if hebrew_a or hebrew_b else "en"


def load_decision_export(path: Path) -> list[dict]:
    """Reads what GET /dedup/decisions returns, as JSON (a list of rows) or as CSV (the same columns)."""
    path = Path(path)
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        for row in rows:
            if row.get("similarity") not in (None, ""):
                row["similarity"] = float(row["similarity"])
            row["reviewerOutcome"] = row.get("reviewerOutcome") or None
        return rows
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("a decision export is a list of rows")
    return data


_LABEL_BY_OUTCOME = {"kept_skipped": 1, "created_anyway": 0}


def pairs_from_decisions(rows: list[dict]) -> tuple[list[dict], int]:
    """Labelled text pairs from the decision log: a skip the reviewer left alone is a duplicate (1), an item they created anyway is not (0).

    Returns (pairs, undecided): rows the reviewer has not decided yet are counted, not guessed. The log keeps no title for the matched
    item, so the pairs carry no titles and are scored on the texts alone, both sides alike; the scores are close to, not the same as, the
    ones the real check produced.
    """
    pairs: list[dict] = []
    undecided = 0
    for row in rows:
        a, b = row.get("candidateText"), row.get("matchedText")
        if not a or not b:
            continue
        label = _LABEL_BY_OUTCOME.get(row.get("reviewerOutcome") or "")
        if label is None:
            undecided += 1
            continue
        day = str(row.get("createdAt", ""))[:10]
        pairs.append({"a": a, "b": b, "label": label, "lang": detect_lang(a, b), "source": f"decision-log {day} job {str(row.get('jobId', ''))[:8]}"})
    return pairs, undecided


def score_pairs(rows: list[dict], embed: Embed) -> list[dict]:
    """One scored row per input row: {"score", "label", "lang", "source"}, in the same order."""
    texts: list[str] = []
    for row in rows:
        texts.extend([row.get("title_a", row["a"]), row["a"], row.get("title_b", row["b"]), row["b"]])
    vectors = embed(texts)
    scored: list[dict] = []
    for index, row in enumerate(rows):
        title_a, text_a, title_b, text_b = vectors[index * 4 : index * 4 + 4]
        score = cosine(blend_embeddings(title_a, text_a), blend_embeddings(title_b, text_b))
        scored.append({"score": score, "label": row["label"], "lang": row.get("lang", "unknown"), "source": row.get("source", "")})
    return scored


def ollama_embedder(base_url: str, path: str, model: str, api_key: str | None, batch_size: int = 32, transport: httpx.BaseTransport | None = None) -> Embed:
    """An embedding function that calls an Ollama-shaped /api/embed endpoint (directly, or through Open WebUI's /ollama/api/embed)."""

    def embed(texts: list[str]) -> list[list[float]]:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        vectors: list[list[float]] = []
        with httpx.Client(timeout=120.0, transport=transport) as client:
            for start in range(0, len(texts), batch_size):
                response = client.post(f"{base_url.rstrip('/')}{path}", json={"model": model, "input": texts[start : start + batch_size]}, headers=headers)
                if response.status_code != 200:
                    raise RuntimeError(f"embedding request failed: {response.status_code} {response.text[:200]}")
                vectors.extend(response.json()["embeddings"])
        return vectors

    return embed

