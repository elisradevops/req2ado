# Production probe: the tree-building rules, after the wave 1 probe (2026-11-26)

For the production operator (or the Copilot agent working with them). Run it after the release that contains branch
`fix/tree-building-rules`. Report numbers only.

## Rules for this probe

- The operator runs every `kubectl` and `helm` command. Production is read-only apart from the one test job in part 3.
- Report no secrets, user ids, hostnames, node names, IPs, registry hosts, organisation namespaces, document file names or document text.
- Make no connection tests or HTTP requests to internal hosts, and script none. The evals use the container's own settings.
- Evals use synthetic fixtures only. Structure counts on real files print numbers only (`--no-name`).

## What changed, in one paragraph

The owner's tree rules are now enforced in code for every file:

- **No Feature or Requirement without a parent.** Code completes the ladder, then a new prompt (`choose_parent` v1) lets AI place each such
  item among the parents code offers.
- **No empty Epic or Feature.** A placeholder section ("None.", "Not applicable.", "Reserved") is left out and listed. A section with text
  but no requirement becomes context in the item above it. An item the file itself states, with content, is kept and marked "No
  requirement under it".
- **The study's renames and level removals apply by default.** The user can undo each before Start.
- **No title over 255 characters.** AI names an over-long title, or it is cut after a whole word with "…".
- **Fewer correct titles refused.** The short-title check (pass version 2) accepts other forms of the requirement's own words
  ("connection" for "connect", "3000" for "3 000"), refuses a title that repeats its parent's, and logs why titles were refused, as counts.
- **More logging.** The orchestrator logs every `/llm/...` request that did not succeed, including ones refused before its handler runs.

## Part 1: the prompts on each production model family

Inside a production ingestion container, once per model family (the last rounds used `claude-opus-5-5` and `OpenAI/gpt-5.4`):

```
python -m tests.prompt_evals.run --user-id <a user with a model connection> --model <model> \
  --family choose_parent --family requirement_titles --family study_file_rules_document --repeat 3 --out /tmp/tree-rules-<model>.json
```

What passes (each case, every repeat):

- `choose_parent/places_each_item_with_its_subject`:
  - every item gets an offered option;
  - the remote's batteries go under "Remote control" and picture calibration under "Display and picture";
  - the product family goes under the document's Epic;
  - the Hebrew item's reason is in Hebrew.
- `requirement_titles/short_grounded_titles` and the four `study_file_rules_document` cases, as in the last probe.

Report per model: passed / failed per case, and each call's wall time (min / median / max).

## Part 2: structure counts on the real files

As before (`python scripts/pdf_structure_counts.py /tmp/<file>.pdf --no-name --json`). The script's keys changed:

- `numbered_sections_lost` must be **0**. It replaces `numbered_sections_without_item`, which counted sections left out on purpose too.
  On the fictional TV twin, the 4 "lost" sections were front and back matter.
- `numbered_sections_left_out`: front matter, back matter and empty sections. Report it.
- `empty_items` must be **0**.
- `empty_sections`: report it.
- The expected zeros stay: `requirements_not_items`, `contents_like_items`, `requirements_with_several_ids`.

## Part 3: one Standard job with the fictional TV twin

The same file as last time (`tv_twin_spec.pdf`, sha256 starts `ec167f298fc7609a`). Never a real document for this part.

1. New job, upload the file, **Standard**, a test area path. Do not write to Azure DevOps.
2. On the new-job page, record:
   - the verdict line (expected `121 requirements · 120 with IDs · 9 Epics · 25 Features`);
   - the header ("3 changes to the file's structure");
   - that each change reads as done, with Undo.
3. Start. At **Diff ready**, record:
   - items per type: expected **9 Epics, 25 Features, 121 Requirements**. The five empty sections ("Interchangeability", "Voice control",
     "Software reuse", "Test equipment", "Reserved") are not items, but are listed under "Left out";
   - the top Epic's title (expected "Vireo Television Set (VTS)") and that there is no "General";
   - how many requirements have a short title (last time 114 of 121), and whether dsp_6's title still repeats "Picture modes".
4. From the ingestion log for that job, the one line `Short titles: N written, M kept from the text (...)`: numbers only.
5. Reject the job (nothing is written).

## Part 4: the load-related failures

Last time the first eval run failed every call (HTTP 400, no orchestrator log line, "Connection reset by peer") while a job ran.

1. Start the Part 3 job. While it studies or runs, run Part 1 again for one model family.
2. From the orchestrator log over that window, count the lines by their opening words:
   - `POST /llm/chat answered <status>` (any request that did not succeed, including ones refused before the handler);
   - `POST /llm/chat closed before an answer was sent`;
   - `chat request rejected (<status>)`.

   Report each status and its count, and the stages named. Never job ids, user ids or text.
3. If calls failed but no such line appears, the refusal happened in front of the orchestrator (ingress or proxy). Say so: that is the
   finding.

## If something fails

Do not change prompts or settings in production. Report the case or step, the model, and the message.
