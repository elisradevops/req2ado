# Duplicate detection: evaluation and audit

How the duplicate check works, whether it meets the usual standards for similarity matching, what was changed, and what stays open.
Findings below are from reading the code unless marked otherwise. Nothing here was measured on production data.

## How it works

For each proposed item (`ingestion/app/dedup/check_for_duplicates.py`):

1. The title and the description are embedded separately and blended 50/50 into one vector (`embedding_blend.py`).
2. The nearest stored item in the same area path is found by cosine similarity (`vector_store.py`, `query_nearest`).
3. At or above the threshold (0.90 by default, one global value in `AppSettings`) it is a candidate duplicate.
4. A numeric guard drops the candidate if the two texts carry different numbers or units ("at least 87%" against "at least 93%").
5. An LLM judge reads the two texts and answers `redundant`, `distinct` or `contradictory`.
6. A duplicate is skipped: `confirm()` does not create the work item.

The cost of a mistake is lopsided. A wrong skip silently loses a real requirement. A missed duplicate creates one extra item that a reviewer
can merge. Every judgement below weighs a wrong skip as the worse error.

## Findings

| # | Finding | Evidence | Severity | Status |
|---|---|---|---|---|
| 1 | A judge that could not run still left the skip in place, so a real requirement could be dropped with no confirmation. | `check_for_duplicates.py` (judge `except` branch) | High | **Fixed**: an unconfirmed match is not skipped. |
| 2 | A `contradictory` verdict counted as a duplicate, so an item that disagrees with an existing one was dropped. | same file | Medium | **Fixed**: `contradictory` is not a duplicate; the verdict and the matched item are still reported. |
| 3 | The 0.90 threshold and the 50/50 blend were tuned on a handful of pairs. The docstring records one pair at 0.755 against 0.747 and a minimum of 0.9416 over the measured true duplicates, and does not name the embedding model. Production uses `OpenAI/text-embedding-3-small` (`deploy/helm/req2ado/values.yaml`). Scores from one model do not transfer to another. | `embedding_blend.py`, `values.yaml` | High | Open: needs a labelled set (below). |
| 4 | Only the single nearest item is compared (`n_results=1`). A true duplicate that is the second-nearest is missed, and a nearer non-duplicate hides it. | `vector_store.py` | Medium | Open. |
| 5 | Matching is filtered by area path only. Item type and parent are not used, so a Requirement can be matched against a Feature. | `query_nearest(embedding, area_path)` | Medium | Open. |
| 6 | Requirement boilerplate ("The system shall...") is shared by almost every item and pushes cosine similarity up for unrelated pairs. | reasoning from the data shape, not measured | Medium | Open: not measured. |
| 7 | Hebrew and mixed Hebrew/English text have never been evaluated. | no Hebrew pairs in any test or fixture | Medium | Open: the evaluation set must include them. |
| 8 | One global threshold that any signed-in user can change (`settings.dto.ts`). The app has no roles. | `settings.dto.ts` | Medium | Open. |
| 9 | `DedupSkipAudit` stores only the skipped pairs (a score and an ADO id), not the texts or the verdicts, and never the pairs that were not skipped. It cannot serve as a labelled set, because it only contains predicted positives. | `schema.prisma` | Low | Open. |
| 10 | The Settings page described the threshold in terms of cosine similarity and did not say that a second check confirms every match. | `Settings.tsx` | Low | **Fixed**: plain wording, and the embedding model is shown read-only. |

## What was added

- `ingestion/app/dedup/evaluation.py` and `ingestion/scripts/dedup_eval.py`. Given a labelled set of pairs, they report precision, recall and F0.5 at the
  threshold in use and at the best threshold, average precision (area under the precision-recall curve), and the same split by language. F0.5 is used because
  precision matters more than recall here (see above). The module is pure: it reads recorded scores or vectors and never calls a model, so it runs in CI.
- The judge fail-safe (findings 1 and 2), with tests at the check level and at the endpoint level.
- Settings: the threshold explained in plain words, and the embedding model shown as information only.

## Running the evaluation

```
cd ingestion
.venv/bin/python scripts/dedup_eval.py pairs.jsonl --threshold 0.90
```

`pairs.jsonl` has one pair per line:

```
{"score": 0.93, "label": 1, "lang": "he", "source": "review-2026-11"}
{"vec_a": [...], "vec_b": [...], "label": 0, "lang": "en"}
```

`label` is 1 for a duplicate and 0 for a pair that is not. A row carries either the score the check produced or the two recorded, already blended, vectors.

## Scoring text pairs with a model

`ingestion/scripts/dedup_score_pairs.py` takes pairs of texts (`{"a", "b", "label", "lang", "source"}`), embeds them the way the real check does
(title and description blended), and prints precision, recall and F0.5 at the threshold in use and at the best one. `--save` writes the scores for
`dedup_eval.py`. It supports the local Ollama route only; production's OpenAI-style route is not covered.

`ingestion/scripts/samples/dedup_pairs_draft.jsonl` is a **draft of 36 synthetic pairs written by an assistant for review**, not data from a real project:
18 duplicates and 18 near-misses, in English, Hebrew and mixed. Treat any number from it as a smoke test only.

Draft-set result on local `bge-m3:latest` (2026-11-12): duplicates scored 0.67 to 0.94 (median 0.86); near-misses scored 0.60 to 0.86. At 0.90 the check
wrongly skips nothing but catches 1 of 18 duplicates, and none in Hebrew. The best threshold on this set is about 0.84. This is a pointer, not a
calibration: the set is small and synthetic, and production uses a different model. The 0.90 default was not changed.

## What the evaluation needs from you

The scripts cannot say anything useful without real pairs. A set of about 200 pairs from your own projects, labelled by people who know them, is the minimum to
trust a threshold: roughly half duplicates, half hard non-duplicates (same topic, different requirement), and at least 40 in Hebrew or mixed Hebrew/English.
The hard non-duplicates matter most, because those are the pairs the threshold has to keep apart.

## Follow-ups, once the set exists

1. Calibrate the threshold for `text-embedding-3-small` (finding 3) and record the result here with the date and model.
2. Compare top-k with a re-rank step against the single nearest item (finding 4).
3. Try normalising away requirement boilerplate before embedding (finding 6), judged by the same evaluation.
4. Block by item type and parent (finding 5).
5. Restrict who can change the threshold (finding 8), and log the texts and verdicts of every decision (finding 9) so the next set can be built from real use.

## Not verified

- Behaviour of the judge on Hebrew text.
- Any number in this document as a measurement on production data: none was taken.
