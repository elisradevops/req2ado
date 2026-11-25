# Hand-off: the document grammar and pre-study prompt v3 on production (2026-11-25)

## Why

A CUI-safe investigation of a real customer specification showed every requirement code lost, a quarter of the requirements missing,
"shall" invented for context and empty sections, and notices that claimed nothing was missing. The cause was fixed rules: one uppercase
code pattern, a list of context titles, a 72 pt margin band. The fix is a **learned document grammar** (`ingestion/app/leveling/
document_grammar.py`, `code_shape.py`):

- Code learns the document's requirement-code shape, the parts printed under each requirement (trace label, Notes), and its context,
  empty and back-matter sections.
- The pre-study (`ingestion/app/prompts/study_file_rules_document.v3.txt`) lets the model confirm them, by example codes and heading
  numbers only. Code checks every part against the document (`study/model_rules.validate_grammar`) and the 3 votes decide.
- Code alone then builds the tree, the same in BASELINE and SURVEY, and the items it builds are never rewritten.

It is checked offline:

- A twin of the real document, with the same structure and invented text (`ingestion/tests/fixtures/build_twin_spec_fixture.py`), comes
  out as the document states it in both modes: 1 Epic, 38 Features, 117 Requirements, 116 Customer IDs, no page furniture.
- The new eval case `grammar_of_a_coded_specification` passes with a scripted reply, and three wrong replies each fail it.

Nothing has run on a production model or a real document yet.

## 1. The prompt on each production model family (inside the production ingestion container)

```
python -m tests.prompt_evals.run --user-id <a user with a model connection> --model <model> \
  --family study_file_rules_document --repeat 3 --out /tmp/prestudy-v3-<model>.json
```

The fixtures are synthetic, and the container's own `ORCHESTRATOR_URL` and `LLM_PROXY_BEARER` are used.

**What passes, in every repeat:**

- `front_matter_by_heading` and `scope_is_not_front_matter`, as in v2.
- `grammar_of_a_coded_specification`, which checks five things:
  - The requirement codes are copied from the `a_9` examples, never the parent codes `GCS_9`.
  - The identification section is context.
  - No coded section is named as context.
  - The identity listing is back matter.
  - The "None." section gets an answer.

Record the wall time per reading, and compare it with v2: about 42 s on claude-opus-5-5, about 17 s on gpt-5.4.

## 2. The real documents: counts only (offline, no model)

```
python scripts/pdf_structure_counts.py /tmp/<file>.pdf --no-name --json
```

Expected for the investigated specification:

- `grammar.applied` true, with `code_shape` `a_9`;
- `items` about 1 Epic, 38 Features and 117 Requirements;
- `requirements_with_id` 116, and `requirements_not_items` 0;
- `left_out_parts_with_pages` including the traceability listing over its pages.

## 3. One SURVEY job on the investigated specification

Take counts from the job page's two downloads, "Download items (CSV)" and "Download report":

- items per type;
- Requirements with a Customer ID;
- the report's "Customer IDs are written like" shape;
- each notice kind with its count.

There should be no `requirements_not_items` notice, and no Epic other than the cover title.

## If something fails

Do not change anything in production. Report the case, model or count that failed:

- **A model that names the wrong code shape:** its answer is refused unless the codes open at least five requirements, and code learns
  the shape on its own anyway. The tree cannot lose requirements to a bad answer, but the failure must still be fixed in the prompt.
- **A real document whose counts differ from the expected ones:** that is a new layout the twin does not have. Run the investigation
  prompt on it again (`docs/runbook-prod-probe.md`).

## One-time costs after the release

- Every stored file reading is read again once, the next time its file is opened: 3 model calls per file. The prompt text is part of the
  pre-study version (`model_rules.prestudy_version`), and `_CODE_PASS_VERSION` went from 4 to 5.
- A Requirement's identity is anchored on its Customer ID when it has one (`identity_v2.py`). Grammar-built items therefore get new,
  stable identities.
- A file already written from the old tree is matched by the duplicate check, not by exact identity. Its items show as "Skipped as a
  duplicate" for review, and are never created again silently.
