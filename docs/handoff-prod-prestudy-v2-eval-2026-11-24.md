# Hand-off: the pre-study prompt v2 on the production models (2026-11-24)

## Why

The document pre-study (`ingestion/app/prompts/study_file_rules_document.v2.txt`) now also names the headings that open front matter:
cover, notice, revision history, contents, abbreviations, glossary and other. It names them by heading number only, and code checks each
one (`study/model_rules.validate_front_matter`).

It has been checked offline only. The two new eval cases pass with scripted replies, and a scripted wrong reply fails each. On the dev
model (qwen3.6:35b, local Ollama) one wizard reading took about 3 minutes, against about 2 minutes for v1. Nothing has run on a
production model yet.

## Run (inside the production ingestion container, once per production model family)

```
python -m tests.prompt_evals.run --user-id <a user with a model connection> --model <model> \
  --family study_file_rules_document --repeat 3 --out /tmp/prestudy-v2-<model>.json
```

The container's own `ORCHESTRATOR_URL` and `LLM_PROXY_BEARER` are used, so nobody handles the token. Every fixture is synthetic, and no
customer document is sent.

## What passes

- `front_matter_by_heading`: "Revision History" (role `revision_history`) and "Acronyms" (`abbreviations` or `glossary`) are named, and
  no numbered section is named. This must pass in every repeat.
- `scope_is_not_front_matter`: "Introduction", "Scope" and "Purpose" are never named. This must pass in every repeat.
- Record each call's wall time from the report. Compare it with a v1 run of the same family if one exists (`docs/prod-eval-baseline-2026-11-22.md`).

## If a case fails

Do not change the prompt in production. Report the case, the model and the check that failed. A model that names a content section as
front matter cannot lose a requirement: code refuses any section that holds a requirement code, and caps front matter at half the
document. But it could fold a descriptive section away, so the failure must be fixed in the prompt and re-evaluated before release.
