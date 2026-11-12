"""Turns labelled TEXT pairs into scored pairs the evaluation (evaluation.py) can read, using whatever embedding function it is given.

A row is {"a": text, "b": text, "label": 1 or 0, "lang": "he"|"en"|..., "source": "...", optional "title_a"/"title_b"}. The real check embeds a
title and a description separately and averages them (embedding_blend.py); a row with titles is scored the same way, one without uses its
text for both, which leaves the vector as it is. Every text goes to the embedding function in ONE call. Pure: the function is passed in, so
this runs without a network in tests.
"""

from __future__ import annotations

import json
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

