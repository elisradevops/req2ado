# Content Significance Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop boilerplate document sections (Introduction/TOC/Revision History) from becoming spurious work items, and stop decorative figures from polluting work-item text, so SURVEY mode produces a more accurately "well-defined" Epic/Feature/Requirement tree.

**Architecture:** Two independent mechanisms. (A) A deterministic heading-keyword classifier (ingestion, Python) injects a soft guard instruction into a boilerplate-heading branch's `kb_context` before `analyze_section` runs — zero LLM cost, mirrors the existing glossary special-case exactly. (B) The vision-model figure-description call gains schema-constrained structured output (`{significant, description}` instead of a free-text sentinel gamble) and whole-document context, by moving the already-shipped AI context primer to run *before* `/ingest` instead of after.

**Tech Stack:** Python 3.13 (ingestion, FastAPI, pydantic), TypeScript/NestJS (orchestrator), Jest, pytest.

## Global Constraints

- Never log file content or PAT/credentials in any error path — job-id context only, matching existing convention.
- `responseSchema` additions must not change existing callers' behavior when `responseSchema` is omitted (default parameter, backward compatible).
- Retired sentinel code (`NO_TECHNICAL_CONTENT_SENTINEL` and every call site) must be deleted, not left dead.
- The front-matter guard must never fully suppress a branch or skip `analyze_section` — a genuine requirement inside an Introduction section must still be able to surface as a real node.
- No new client-side gating heuristic (byte-size, page-count, or otherwise) for whether to attempt the primer — it is always attempted for `mode === 'survey'`, fail-open on any error.
- Both mechanisms are SURVEY-mode only — BASELINE never calls `analyze_section` or the vision-significance path.

---

### Task 1: Deterministic front-matter guard

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py:680` (near `_GLOSSARY_HEADING_PATTERN`), `llm_leveling.py:724-730` (`_combine_global_context`), `llm_leveling.py:1590,1784` (call sites)
- Test: `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Consumes: `_branch_heading_labels(branch: list[Block]) -> list[str]` (existing, `llm_leveling.py:649-655`), `_build_document_outline` (existing, unchanged).
- Produces: `_FRONT_MATTER_HEADING_PATTERN: re.Pattern[str]`, `_find_front_matter_branches(branches: list[list[Block]]) -> set[int]`, `_combine_global_context(base, branch_index, glossary_sections, primer_context=None, front_matter_branch_indices=None) -> str | None` (signature gains one new optional trailing param — every existing call site with 3 or 4 positional/keyword args is unaffected).

- [ ] **Step 1: Write the failing tests**

```python
# ingestion/tests/test_llm_leveling.py -- add near the existing glossary tests

def test_front_matter_heading_pattern_matches_typical_boilerplate_headings() -> None:
    from app.leveling.llm_leveling import _FRONT_MATTER_HEADING_PATTERN

    assert _FRONT_MATTER_HEADING_PATTERN.search("1 Introduction")
    assert _FRONT_MATTER_HEADING_PATTERN.search("Table of Contents")
    assert _FRONT_MATTER_HEADING_PATTERN.search("Revision History")
    assert _FRONT_MATTER_HEADING_PATTERN.search("Document History")
    assert _FRONT_MATTER_HEADING_PATTERN.search("Appendix A")
    assert _FRONT_MATTER_HEADING_PATTERN.search("2.3 References")


def test_front_matter_heading_pattern_does_not_match_real_content_headings() -> None:
    from app.leveling.llm_leveling import _FRONT_MATTER_HEADING_PATTERN

    assert not _FRONT_MATTER_HEADING_PATTERN.search("3 Interface Requirements")
    assert not _FRONT_MATTER_HEADING_PATTERN.search("System Overview")
    assert not _FRONT_MATTER_HEADING_PATTERN.search("4.1 Power Interface")


def test_find_front_matter_branches_returns_indices_of_matching_branches() -> None:
    from app.leveling.llm_leveling import _find_front_matter_branches

    path = "doc.txt"
    intro_heading = Block(id="b0", kind=BlockKind.HEADING, text="Introduction", number_label="1", source_ref=_sr(path))
    intro_body = Block(id="b1", kind=BlockKind.PARAGRAPH, text="This document describes...", source_ref=_sr(path))
    real_heading = Block(id="b2", kind=BlockKind.HEADING, text="Interface Requirements", number_label="2", source_ref=_sr(path))
    real_body = Block(id="b3", kind=BlockKind.PARAGRAPH, text="The unit shall...", source_ref=_sr(path))
    branches = [[intro_heading, intro_body], [real_heading, real_body]]

    assert _find_front_matter_branches(branches) == {0}


def test_combine_global_context_appends_front_matter_guard_only_for_matched_branch_index() -> None:
    from app.leveling.llm_leveling import _combine_global_context, _FRONT_MATTER_GUARD_TEXT

    matched = _combine_global_context("outline", 0, [], None, front_matter_branch_indices={0})
    assert _FRONT_MATTER_GUARD_TEXT in matched

    unmatched = _combine_global_context("outline", 1, [], None, front_matter_branch_indices={0})
    assert _FRONT_MATTER_GUARD_TEXT not in unmatched
    assert unmatched == "outline"


def test_combine_global_context_omits_front_matter_guard_when_indices_not_supplied() -> None:
    # Byte-identical to pre-Task-1 behavior when the new param is omitted --
    # every pre-existing call site that doesn't yet pass it is unaffected.
    from app.leveling.llm_leveling import _combine_global_context

    result = _combine_global_context("outline", 0, [])
    assert result == "outline"


def test_build_survey_tree_front_matter_branch_still_allows_a_real_requirement_to_surface() -> None:
    # The guard is a soft instruction, not a hard skip -- if the model still
    # emits a real node for content inside a front-matter-labeled section
    # (e.g. a genuine requirement accidentally placed under "Introduction"),
    # that node must still reach the tree.
    path = "doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, text="Introduction", number_label="1", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The unit shall boot within ten seconds.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, text="System Overview", number_label="2", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="This system provides power management.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": "Boot time", "text": "The unit shall boot within ten seconds.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert len(tree.nodes) >= 1
    assert any("Boot time" in n.title for n in tree.nodes)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -k "front_matter" -v`
Expected: FAIL with `ImportError`/`AttributeError: module 'app.leveling.llm_leveling' has no attribute '_FRONT_MATTER_HEADING_PATTERN'`

- [ ] **Step 3: Implement**

In `ingestion/app/leveling/llm_leveling.py`, add immediately after the existing `_GLOSSARY_HEADING_PATTERN = re.compile(...)` line (`:680`):

```python
# Mirrors _GLOSSARY_HEADING_PATTERN's own shape exactly -- a deterministic,
# zero-LLM-cost signal that a branch's heading is typical front matter
# (Introduction/TOC/Revision History/Appendix/References), used ONLY to
# inject a soft guard instruction into that branch's own analyze_section
# call. Never skips or merges the branch -- a genuine requirement
# accidentally placed under "Introduction" must still be able to surface.
_FRONT_MATTER_HEADING_PATTERN = re.compile(
    r"(?i)\b(introduction|table of contents|revision history|document history|appendix|references?)\b"
)

_FRONT_MATTER_GUARD_TEXT = (
    "This section's heading matches typical front-matter (Introduction/"
    "Table of Contents/Revision History/Appendix). Only emit work items if "
    "genuine testable/actionable content exists in this section's text -- "
    "do not fabricate an Epic/Feature/Requirement merely to represent this "
    "section's existence."
)


def _find_front_matter_branches(branches: list[list[Block]]) -> set[int]:
    """Branch indices whose heading label matches a front-matter keyword.
    Same heading-label source as _find_glossary_sections (_branch_heading_labels)
    -- deterministic, computed once before any LLM call."""
    indices: set[int] = set()
    for i, branch in enumerate(branches):
        labels = _branch_heading_labels(branch)
        if any(_FRONT_MATTER_HEADING_PATTERN.search(label) for label in labels):
            indices.add(i)
    return indices
```

Replace `_combine_global_context` (`:724-730`) with:

```python
def _combine_global_context(
    base: str | None, branch_index: int, glossary_sections: list[tuple[int, str, str]],
    primer_context: str | None = None, front_matter_branch_indices: set[int] | None = None,
) -> str | None:
    extra = _glossary_context_for_branch(branch_index, glossary_sections)
    guard = (
        _FRONT_MATTER_GUARD_TEXT
        if front_matter_branch_indices is not None and branch_index in front_matter_branch_indices
        else None
    )
    parts = [part for part in (base, extra, primer_context, guard) if part]
    return "\n\n".join(parts) if parts else None
```

At the call site building `glossary_sections` (`:1590`), add immediately after:

```python
        glossary_sections = _find_glossary_sections(branches, glossary_branch_tables)
        front_matter_branch_indices = _find_front_matter_branches(branches)
```

At the `_run_branch` closure's `_combine_global_context` call (`:1784`), change:

```python
                global_context=_combine_global_context(global_context, branch_index, glossary_sections, primer_context),
```

to:

```python
                global_context=_combine_global_context(
                    global_context, branch_index, glossary_sections, primer_context, front_matter_branch_indices,
                ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -k "front_matter" -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full ingestion suite to check for regressions**

Run: `cd ingestion && .venv/bin/python -m pytest tests/ -q`
Expected: all pass, same count as before plus 6

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(leveling): add deterministic front-matter heading guard"
```

---

### Task 2: Orchestrator vision() gains structured-output (responseSchema) support

**Files:**
- Modify: `orchestrator/src/modules/llm/llm-vision.dto.ts`, `orchestrator/src/modules/llm/llm.controller.ts`, `orchestrator/src/modules/llm/openwebui.client.ts`
- Test: `orchestrator/test/openwebui.client.spec.ts`, `orchestrator/test/llm.controller.spec.ts`

**Interfaces:**
- Consumes: `LlmResponseSchema` (existing, `llm-client.interface.ts:12-15`, `{name: string, schema: Record<string, unknown>}`), `buildResponseFormat`/`isSchemaRejection` (existing, `openwebui.client.ts:7-20`).
- Produces: `OpenWebUiClient.vision(prompt, images, opts?: {model?, mimeType?, responseSchema?: LlmResponseSchema}): Promise<string>` (return type UNCHANGED — still a raw string; the schema only constrains what the model puts *inside* that string, ingestion parses it). `LlmVisionRequestBody.responseSchema?: {name, schema}`.

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator/test/openwebui.client.spec.ts -- add near the other vision() tests

it('vision() forwards responseSchema as response_format when provided', async () => {
  const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
  const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: '{"significant":true,"description":"A wiring diagram."}' } }] });
  // @ts-expect-error -- reaching into the private SDK client for a test double
  client.openai.chat.completions.create = fakeCreate;

  await client.vision('describe this figure', [Buffer.from('img')], {
    responseSchema: { name: 'figure_significance', schema: { type: 'object', properties: { significant: { type: 'boolean' }, description: { type: 'string' } } } },
  });

  expect(fakeCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'figure_significance', schema: { type: 'object', properties: { significant: { type: 'boolean' }, description: { type: 'string' } } } },
      },
    }),
  );
});

it('vision() omits response_format when responseSchema is not provided -- unchanged from pre-Task-2 behavior', async () => {
  const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
  const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'A block diagram.' } }] });
  // @ts-expect-error -- reaching into the private SDK client for a test double
  client.openai.chat.completions.create = fakeCreate;

  await client.vision('describe this figure', [Buffer.from('fake-png-bytes')]);

  expect(fakeCreate).toHaveBeenCalledWith({
    model: 'llava',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this figure' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}` } },
        ],
      },
    ],
    temperature: 0,
    seed: 0,
    max_tokens: 200,
    reasoning_effort: 'none',
  });
});

it('vision() retries once without the schema on a schema-rejection error (400/422) -- same degrade-once convention as chat()', async () => {
  const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
  const rejection = new OpenAI.APIError(400, { message: 'bad schema' }, 'bad schema', {} as any);
  const fakeCreate = jest.fn().mockRejectedValueOnce(rejection).mockResolvedValueOnce({ choices: [{ message: { content: 'A block diagram.' } }] });
  // @ts-expect-error -- reaching into the private SDK client for a test double
  client.openai.chat.completions.create = fakeCreate;

  const result = await client.vision('describe', [Buffer.from('img')], {
    responseSchema: { name: 'figure_significance', schema: { type: 'object' } },
  });

  expect(result).toBe('A block diagram.');
  expect(fakeCreate).toHaveBeenCalledTimes(2);
  expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('response_format');
});
```

```typescript
// orchestrator/test/llm.controller.spec.ts -- add near the other "threads an explicit X" tests

it('threads an explicit responseSchema from the request body into llmClient.vision', async () => {
  const llmClient = { vision: jest.fn().mockResolvedValue('a description') };
  const controller = new LlmController(llmClient as any);

  await controller.vision({
    prompt: 'describe this figure',
    images: [Buffer.from('img').toString('base64')],
    responseSchema: { name: 'figure_significance', schema: { type: 'object' } },
  });

  expect(llmClient.vision).toHaveBeenCalledWith(
    'describe this figure',
    [Buffer.from('img')],
    expect.objectContaining({ responseSchema: { name: 'figure_significance', schema: { type: 'object' } } }),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts test/llm.controller.spec.ts -t "responseSchema" -v`
Expected: FAIL — `response_format` never appears in the actual call, or `responseSchema` is stripped by zod validation before reaching the controller.

- [ ] **Step 3: Implement**

`orchestrator/src/modules/llm/llm-vision.dto.ts` — add a `responseSchema` field matching `llm-chat.dto.ts`'s existing exact shape:

```typescript
import { z } from 'zod';

export const llmVisionRequestSchema = z.object({
  prompt: z.string().min(1),
  images: z.array(z.string().min(1)).min(1),
  model: z.string().optional(),
  mimeType: z.string().optional(),
  // Same shape/validation as llm-chat.dto.ts's own responseSchema field --
  // constrains the vision model's JSON output at the sampling level (see
  // LlmResponseSchema's own doc comment, llm-client.interface.ts).
  responseSchema: z
    .object({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      schema: z.record(z.unknown()),
    })
    .optional(),
});

export type LlmVisionRequestBody = z.infer<typeof llmVisionRequestSchema>;
```

`orchestrator/src/modules/llm/llm.controller.ts` — update `vision()` (replace the whole method):

```typescript
  @Post('vision')
  async vision(@Body() rawBody: unknown): Promise<{ description: string }> {
    const parseResult = llmVisionRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: prompt and a non-empty images array (base64) are required');
    }
    const body = parseResult.data;
    const opts =
      body.model !== undefined || body.mimeType !== undefined || body.responseSchema !== undefined
        ? {
            ...(body.model !== undefined ? { model: body.model } : {}),
            ...(body.mimeType !== undefined ? { mimeType: body.mimeType } : {}),
            ...(body.responseSchema !== undefined ? { responseSchema: body.responseSchema } : {}),
          }
        : undefined;
    const description = await this.llmClient.vision(body.prompt, body.images.map((image) => Buffer.from(image, 'base64')), opts);
    return { description };
  }
```

`orchestrator/src/modules/llm/openwebui.client.ts` — replace `vision()`'s signature and body (`:281-346`) to reuse the existing `buildResponseFormat`/`isSchemaRejection` helpers already defined at the top of this file:

```typescript
  async vision(
    prompt: string,
    images: Buffer[],
    opts?: { model?: string; mimeType?: string; responseSchema?: LlmResponseSchema },
  ): Promise<string> {
    const model = opts?.model ?? this.config.LLM_VISION_MODEL;
    if (!model) {
      throw new Error('vision() called with no model available -- set LLM_VISION_MODEL or pass opts.model');
    }
    const mimeType = opts?.mimeType ?? 'image/png';
    const outboundPrompt = this.config.LLM_TRUSTED_LOCAL ? prompt : redactText(prompt);
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: outboundPrompt },
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${mimeType};base64,${image.toString('base64')}` },
      })),
    ];
    const responseFormat = opts?.responseSchema
      ? { type: 'json_schema' as const, json_schema: { name: opts.responseSchema.name, schema: opts.responseSchema.schema } }
      : undefined;
    const buildParams = (includeSchema: boolean) => ({
      model,
      messages: [{ role: 'user' as const, content }],
      temperature: 0,
      seed: 0,
      max_tokens: 200,
      reasoning_effort: 'none' as OpenAI.ReasoningEffort,
      ...(includeSchema && responseFormat ? { response_format: responseFormat } : {}),
    });
    try {
      const response = await this.openai.chat.completions.create(buildParams(true));
      return response.choices[0]?.message?.content ?? '';
    } catch (err) {
      if (opts?.responseSchema && isSchemaRejection(err)) {
        const response = await this.openai.chat.completions.create(buildParams(false));
        return response.choices[0]?.message?.content ?? '';
      }
      throw err;
    }
  }
```

Add `LlmResponseSchema` to this file's existing import from `./llm-client.interface` (it already imports `LlmChatOptions, LlmChatResult, LlmClient, LlmStreamChunk` at the top — add `LlmResponseSchema` to that same import list).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/openwebui.client.spec.ts test/llm.controller.spec.ts -v`
Expected: all pass, including the pre-existing vision() tests (unchanged — omitting `responseSchema` produces byte-identical `buildParams(true)` output to before)

- [ ] **Step 5: Typecheck and run the full orchestrator suite**

Run: `cd orchestrator && npm run build && npm test`
Expected: clean build, all tests pass

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/llm/llm-vision.dto.ts orchestrator/src/modules/llm/llm.controller.ts orchestrator/src/modules/llm/openwebui.client.ts orchestrator/test/openwebui.client.spec.ts orchestrator/test/llm.controller.spec.ts
git commit -m "feat(llm): add responseSchema support to vision()"
```

---

### Task 3: Ingestion vision client — structured significance output + document context

**Files:**
- Modify: `ingestion/app/vision/orchestrator_vision_client.py`
- Test: `ingestion/tests/test_orchestrator_vision_client.py` (**already exists** — 5 tests currently assert `describe_figure(...)` returns a plain `str`; this task updates all 5 to the new `FigureVisionResult | None` contract and adds new tests, it does not create the file)

**Interfaces:**
- Consumes: Task 2's `/llm/vision` route now accepting `responseSchema` in its JSON body.
- Produces: `FigureVisionResult` (NamedTuple: `significant: bool`, `description: str`), `OrchestratorVisionClient.describe_figure(image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None) -> FigureVisionResult | None` (return type CHANGES from always-`str` to `FigureVisionResult | None` — every caller updated in Task 5). **`None` specifically means "totally unparseable response, unknown verdict"** — distinct from a genuinely parsed `FigureVisionResult(significant=False, ...)`, which is a confident, deliberate model verdict. This distinction is load-bearing for Task 5's cache-write logic (an unparseable response must not be cached, so a transient glitch self-heals on retry — the exact protection the pre-existing "never cache a blank result" test already guards; a real `significant=False` verdict IS cached, unlike before).

- [ ] **Step 1: Update the 5 existing tests, then add new ones**

`ingestion/tests/test_orchestrator_vision_client.py` already exists with 5 tests. Its top-of-file mocked responses currently return `{"description": "<plain string>"}` — under the new contract, the orchestrator's `/llm/vision` response's `"description"` field is itself the vision model's raw JSON text (`{"significant": ..., "description": ...}`), which `describe_figure` now parses into a `FigureVisionResult`. Replace the file's full contents:

```python
# ingestion/tests/test_orchestrator_vision_client.py
import base64
import json

import httpx
import pytest

from app.vision.orchestrator_vision_client import FigureVisionResult, OrchestratorVisionClient


def test_describe_figure_calls_the_orchestrator_vision_endpoint_with_bearer_auth() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/vision"
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "A block diagram showing power distribution."})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-png-bytes")
    assert result == FigureVisionResult(significant=True, description="A block diagram showing power distribution.")


def test_describe_figure_sends_the_image_base64_encoded() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-png-bytes")

    assert captured["body"]["images"] == [base64.b64encode(b"fake-png-bytes").decode("ascii")]
    assert "prompt" in captured["body"]


def test_describe_figure_raises_on_non_200_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"message": "bad gateway"})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    with pytest.raises(httpx.HTTPStatusError):
        client.describe_figure(b"img")


def test_describe_figure_forwards_mime_type_when_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-jpeg-bytes", mime_type="image/jpeg")

    assert captured["body"]["mimeType"] == "image/jpeg"


def test_describe_figure_omits_mime_type_when_not_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-png-bytes")

    assert "mimeType" not in captured["body"]


def test_describe_figure_parses_significant_false() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": json.dumps({"significant": False, "description": "A decorative rectangular block."})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-bytes")
    assert result.significant is False


def test_describe_figure_sends_responseSchema_and_document_context_in_the_prompt() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"description": json.dumps({"significant": True, "description": "ok"})})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-bytes", document_context="This is an avionics interface control document.")

    assert "responseSchema" in captured["body"]
    assert captured["body"]["responseSchema"]["name"]
    assert "avionics interface control document" in captured["body"]["prompt"]


def test_describe_figure_returns_none_on_a_totally_unparseable_response() -> None:
    # A bad-figure-description parse failure must never raise -- but it is
    # ALSO distinct from a genuinely parsed significant=False verdict: None
    # signals "unknown, don't cache this" to the caller (main.py's
    # _describe_figure), preserving the exact "don't memorize a glitch for
    # a week" protection the old blank-caption guard provided, while a real
    # parsed significant=False IS cached (a confident, deliberate verdict,
    # not an ambiguous blank).
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": "not valid json at all"})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-bytes")
    assert result is None


def test_describe_figure_recovers_a_slightly_malformed_json_reply_via_repair() -> None:
    # A model appending stray trailing content after otherwise-valid JSON
    # (the same real failure shape orchestrator_llm_client.py's own
    # _parse_json_object already tolerates) must still parse correctly.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"description": '{"significant": true, "description": "A block diagram."} '})

    client = OrchestratorVisionClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.describe_figure(b"fake-bytes")
    assert result == FigureVisionResult(significant=True, description="A block diagram.")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_orchestrator_vision_client.py -v`
Expected: FAIL — `ImportError: cannot import name 'FigureVisionResult'`

- [ ] **Step 3: Implement**

Replace `ingestion/app/vision/orchestrator_vision_client.py` in full:

```python
from __future__ import annotations

import base64
import json
from typing import NamedTuple

import httpx
from json_repair import repair_json

_VISION_REQUEST_TIMEOUT_SECONDS = 300.0


class FigureVisionResult(NamedTuple):
    """Structured result of describe_figure -- replaces the old free-text
    caption + hoped-for NO_TECHNICAL_CONTENT sentinel with schema-constrained
    output. `significant=False` means "don't show this figure to the model
    at all" (main.py's caller sets Figure.caption=None in that case, reusing
    the existing caption=None -> omitted-from-context convention unchanged)."""

    significant: bool
    description: str


_FIGURE_SIGNIFICANCE_SCHEMA = {
    "type": "object",
    "properties": {
        "significant": {
            "type": "boolean",
            "description": "True if this figure has real technical/informational content relevant to understanding the document; false for decorative images, logos, or blank/placeholder graphics.",
        },
        "description": {
            "type": "string",
            "description": "One or two sentences describing the figure's technical content (components, connections, values, labeled parts). Empty or minimal if not significant.",
        },
    },
    "required": ["significant", "description"],
}


def _build_prompt(document_context: str | None) -> str:
    base = (
        "Describe this figure or diagram, focusing on any technical content "
        "(components, connections, values, labeled parts). Judge whether it "
        "has genuine informational content worth including, or whether it is "
        "decorative (a logo, a colored placeholder block, a blank divider)."
    )
    if not document_context:
        return base
    return (
        f"{base}\n\nContext about the document this figure appears in: "
        f"{document_context}\n\nJudge significance relative to THIS document -- "
        "a figure that's decorative in isolation but happens to be labeled "
        "with document-relevant terminology should still be judged on its "
        "own visual content, not on the surrounding context alone."
    )


def _parse_figure_response(raw: str) -> FigureVisionResult | None:
    """Fail-open: any parse failure (malformed JSON, missing fields, wrong
    types) returns None rather than raising -- a bad figure description
    must never fail the whole SURVEY job. None is a DISTINCT outcome from a
    genuinely parsed FigureVisionResult(significant=False, ...): the caller
    (main.py's _describe_figure) must not cache a None result (unknown/
    glitchy, self-heals on retry -- the exact protection the pre-existing
    "never cache a blank result" test already guards), but SHOULD cache a
    real significant=False verdict (a confident, deliberate answer, not an
    ambiguous blank). Mirrors orchestrator_llm_client.py's own defensive
    parse/repair convention (raw_decode first, json_repair as the last
    resort) without importing that module's narrower, analyze_section-
    specific positional tolerances."""
    for attempt in (raw, None):
        try:
            parsed = json.loads(raw) if attempt is not None else repair_json(raw, return_objects=True)
        except Exception:
            continue
        if isinstance(parsed, dict) and isinstance(parsed.get("significant"), bool):
            description = parsed.get("description")
            return FigureVisionResult(significant=parsed["significant"], description=description if isinstance(description, str) else "")
    return None


class OrchestratorVisionClient:
    """Calls the orchestrator's POST /llm/vision proxy -- NEVER calls Open
    WebUI/Ollama directly, same 'backend proxy, redact-first' boundary as
    every other real LLM client in this codebase. Mirrors
    OrchestratorEmbedClient's structure and test-injection seam."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    def describe_figure(
        self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None
    ) -> FigureVisionResult | None:
        """`mime_type` (e.g. 'image/jpeg'), when supplied, tells the
        orchestrator's real content-type instead of its pre-existing
        hardcoded 'image/png' default. `document_context` (the whole-
        document AI primer, see pipeline.worker.ts) lets significance be
        judged relative to THIS document, not just in visual isolation --
        omitted (None) produces a figure-only prompt, unchanged from before
        this parameter existed."""
        with httpx.Client(transport=self._transport, timeout=_VISION_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/vision",
                json={
                    "prompt": _build_prompt(document_context),
                    "images": [base64.b64encode(image_bytes).decode("ascii")],
                    "responseSchema": {"name": "figure_significance", "schema": _FIGURE_SIGNIFICANCE_SCHEMA},
                    **({"mimeType": mime_type} if mime_type else {}),
                },
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        return _parse_figure_response(response.json()["description"])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_orchestrator_vision_client.py -v`
Expected: PASS (9 tests: the original 5, updated, plus 4 new)

- [ ] **Step 5: Run the full ingestion suite**

Run: `cd ingestion && .venv/bin/python -m pytest tests/ -q`
Expected: this will show FAILURES in `test_ingest_endpoint.py`, `test_ingest_figure_storage.py`, and `test_llm_leveling.py` (every fake vision client elsewhere in the suite still returns a bare `str`, and `NO_TECHNICAL_CONTENT_SENTINEL` is now an unresolved import) — this is expected at this point in the plan; Task 5 fixes every remaining caller. Confirm the failures are ONLY in files this task doesn't own, not in `test_orchestrator_vision_client.py` itself.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/vision/orchestrator_vision_client.py ingestion/tests/test_orchestrator_vision_client.py
git commit -m "feat(vision): structured significance output + document-context prompt"
```

---

### Task 4: Orchestrator — move the whole-document primer before /ingest

**Files:**
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`, `orchestrator/src/modules/pipeline/ingestion-http.client.ts`
- Test: `orchestrator/test/pipeline.worker.spec.ts`, `orchestrator/test/ingestion-http.client.spec.ts`

**Interfaces:**
- Consumes: `OpenWebUiClient.uploadFile`/`pollFileProcessed`/`chat`/`deleteFile` (existing, unchanged), `PrimerCacheRedis` (existing interface, unchanged).
- Produces: `IngestionHttpClient.ingest(fileBuffer, filename, skipVision?, mode?, jobId?, primerContext?): Promise<CanonicalDoc>` (gains one new optional trailing param). The primer computation in `pipeline.worker.ts` now runs before the `/ingest` call and no longer depends on `doc`.

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator/test/ingestion-http.client.spec.ts -- add near the other ingest() tests

it('forwards primerContext as a primer_context query param when provided', async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
  const client = new IngestionHttpClient('http://ingestion.internal');

  await client.ingest(Buffer.from('file'), 'doc.pdf', false, 'survey', 'job-1', 'This is an avionics ICD.');

  const [url] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toContain('primer_context=' + encodeURIComponent('This is an avionics ICD.'));
});

it('omits primer_context from the query string when not provided -- unchanged from pre-Task-4 behavior', async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => MINIMAL_DOC });
  const client = new IngestionHttpClient('http://ingestion.internal');

  await client.ingest(Buffer.from('file'), 'doc.pdf', false, 'survey', 'job-1');

  const [url] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).not.toContain('primer_context');
});
```

These go inside the existing `describe('whole-document primer (Phase 6c)', ...)` block (`:1552`), which already provides `fakeIngestionClient`/`fakeDryRunService`/`fakePrisma`/etc. and its own `beforeEach` — reuse that exact surrounding structure and the SAME full inline job/deps object literal every other test in this describe block already uses (there is no shared `baseJob`/`baseDeps` fixture in this file — every test spells the objects out in full; match that convention exactly, do not introduce a new shared helper):

```typescript
// orchestrator/test/pipeline.worker.spec.ts -- add inside the existing
// describe('whole-document primer (Phase 6c)', ...) block (:1552), using
// the exact same full job/deps object literal every sibling test there uses

it('attempts the primer unconditionally for a SURVEY job -- no document-size gate anymore', async () => {
  // A TINY doc -- the old gate would have skipped the primer for this
  // (well under PRIMER_CONTEXT_MIN_DOCUMENT_TEXT_CHARS). Deliberately NOT
  // using this block's own bigDoc/bigFileBuffer fixtures -- the whole point
  // of this test is that document/file size no longer matters at all.
  fakeIngestionClient.ingest.mockResolvedValue({ blocks: [{ id: 'b0', text: 'x' }] });
  fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
  fakeDryRunService.diff.mockResolvedValue([]);
  fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
  fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
  fakeOpenWebUiClient.chat.mockResolvedValue({ content: 'This is an avionics ICD.' });
  fakePrimerCacheRedis.get.mockResolvedValue(null);

  await runPipelineJob(
    { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from('x'), filename: 'x.pdf' },
    {
      ingestionClient: fakeIngestionClient as any,
      dryRunService: fakeDryRunService as any,
      idempotencyService: fakeIdempotencyService as any,
      prisma: fakePrisma as any,
      jobEventsPublisher: fakeJobEventsPublisher as any,
      mcpClient: fakeMcpClient as any,
      backfillService: fakeBackfillService as any,
      adoCredentialResolver: fakeAdoCredentialResolver as any,
      defaultLlmModel: 'gemma4:12b',
      openWebUiClient: fakeOpenWebUiClient as any,
      primerCacheRedis: fakePrimerCacheRedis as any,
    },
  );

  expect(fakeOpenWebUiClient.uploadFile).toHaveBeenCalled();
  expect(fakeIngestionClient.level).toHaveBeenCalledWith(
    { blocks: [{ id: 'b0', text: 'x' }] }, null, 'survey', undefined, [], 'gemma4:12b', 'job-1', 'This is an avionics ICD.',
  );
});

it('computes the primer BEFORE calling ingestionClient.ingest -- figures need it during parsing', async () => {
  fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
  fakeDryRunService.diff.mockResolvedValue([]);
  fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
  fakeOpenWebUiClient.chat.mockResolvedValue({ content: 'Primer text.' });
  fakePrimerCacheRedis.get.mockResolvedValue(null);

  const callOrder: string[] = [];
  fakeOpenWebUiClient.uploadFile.mockImplementation(async () => {
    callOrder.push('primer-upload');
    return 'file-1';
  });
  fakeIngestionClient.ingest.mockImplementation(async () => {
    callOrder.push('ingest');
    return { blocks: [] };
  });

  await runPipelineJob(
    { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from('x'), filename: 'x.pdf' },
    {
      ingestionClient: fakeIngestionClient as any,
      dryRunService: fakeDryRunService as any,
      idempotencyService: fakeIdempotencyService as any,
      prisma: fakePrisma as any,
      jobEventsPublisher: fakeJobEventsPublisher as any,
      mcpClient: fakeMcpClient as any,
      backfillService: fakeBackfillService as any,
      adoCredentialResolver: fakeAdoCredentialResolver as any,
      defaultLlmModel: 'gemma4:12b',
      openWebUiClient: fakeOpenWebUiClient as any,
      primerCacheRedis: fakePrimerCacheRedis as any,
    },
  );

  expect(callOrder).toEqual(['primer-upload', 'ingest']);
});

it('passes the SAME primerContext value to both ingestionClient.ingest and ingestionClient.level -- computed once, not twice', async () => {
  fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
  fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
  fakeDryRunService.diff.mockResolvedValue([]);
  fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
  fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
  fakeOpenWebUiClient.chat.mockResolvedValue({ content: 'Primer text.' });
  fakePrimerCacheRedis.get.mockResolvedValue(null);

  await runPipelineJob(
    { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from('x'), filename: 'x.pdf' },
    {
      ingestionClient: fakeIngestionClient as any,
      dryRunService: fakeDryRunService as any,
      idempotencyService: fakeIdempotencyService as any,
      prisma: fakePrisma as any,
      jobEventsPublisher: fakeJobEventsPublisher as any,
      mcpClient: fakeMcpClient as any,
      backfillService: fakeBackfillService as any,
      adoCredentialResolver: fakeAdoCredentialResolver as any,
      defaultLlmModel: 'gemma4:12b',
      openWebUiClient: fakeOpenWebUiClient as any,
      primerCacheRedis: fakePrimerCacheRedis as any,
    },
  );

  const ingestPrimerArg = fakeIngestionClient.ingest.mock.calls[0][5];
  const levelPrimerArg = fakeIngestionClient.level.mock.calls[0][7];
  expect(ingestPrimerArg).toBe('Primer text.');
  expect(levelPrimerArg).toBe('Primer text.');
});

it('passes a fixed, generous numCtx on the primer chat call -- no per-document sizing is possible before /ingest has run', async () => {
  fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
  fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
  fakeDryRunService.diff.mockResolvedValue([]);
  fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
  fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
  fakeOpenWebUiClient.chat.mockResolvedValue({ content: 'Primer text.' });
  fakePrimerCacheRedis.get.mockResolvedValue(null);

  await runPipelineJob(
    { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from('x'), filename: 'x.pdf' },
    {
      ingestionClient: fakeIngestionClient as any,
      dryRunService: fakeDryRunService as any,
      idempotencyService: fakeIdempotencyService as any,
      prisma: fakePrisma as any,
      jobEventsPublisher: fakeJobEventsPublisher as any,
      mcpClient: fakeMcpClient as any,
      backfillService: fakeBackfillService as any,
      adoCredentialResolver: fakeAdoCredentialResolver as any,
      defaultLlmModel: 'gemma4:12b',
      openWebUiClient: fakeOpenWebUiClient as any,
      primerCacheRedis: fakePrimerCacheRedis as any,
    },
  );

  expect(fakeOpenWebUiClient.chat.mock.calls[0][1]).toEqual(expect.objectContaining({ numCtx: 32_768 }));
});
```

Note: this describe block's own `beforeEach` (`:1565-1569`) currently sets `fakeIngestionClient.ingest.mockResolvedValue(bigDoc)` and `fakeIngestionClient.level.mockResolvedValue({ nodes: [] })` unconditionally for every test in the block — the four new tests above override `.ingest`'s mock per-test as needed (some inline, `'computes the primer BEFORE...'` via `mockImplementation` instead of `mockResolvedValue` since it needs to observe call order), which is safe (a later `mockResolvedValue`/`mockImplementation` call replaces the `beforeEach`'s default for that test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest test/ingestion-http.client.spec.ts test/pipeline.worker.spec.ts -t "primer" -v`
Expected: FAIL — `ingest.mock.calls[0][5]` is undefined (no primerContext param yet), call order is `['ingest', 'primer-upload']` (wrong order)

- [ ] **Step 3: Remove the now-obsolete tests**

Delete these existing tests from `orchestrator/test/pipeline.worker.spec.ts` entirely — they assert a size-based gate this task removes:
- `'never attempts the primer for a document whose ingested TEXT is under the minimum, even when the FILE itself is large -- the gate is text length, not file bytes'`
- `'attempts the primer for a document that is SMALL in file bytes but large in ingested text -- the inverse of the byte-size proxy bug'`
- `'passes an explicit numCtx large enough for the whole document on the primer chat call'` (replaced by the new fixed-numCtx test above)
- `'skips the primer entirely (never calls chat) when no safe numCtx can cover the document'`

Keep every other existing primer test (`'threads primerContext ... into the level() call'`, `'fails open to undefined primerContext when upload throws'`, `'reads from the primer cache instead of re-uploading on a cache hit'`, `'never attempts the primer for a BASELINE job...'`, the clamp test, the `maxTokens`/`think:false` test, the failure-logging test) — update each one only as needed for the new call-order/signature (e.g. any assertion reading `fakeIngestionClient.level.mock.calls[0][7]` for primerContext is unaffected; any assertion that previously relied on `doc` being ingested first before the primer fires needs its mock setup reordered to still work, since `fakeIngestionClient.ingest` must now resolve before the primer's own gate gets evaluated in the NEW code, not after).

- [ ] **Step 4: Implement — `ingestion-http.client.ts`**

Modify `ingest()`'s signature (add the trailing param) and body:

```typescript
  async ingest(
    fileBuffer: Buffer,
    filename: string,
    skipVision = false,
    mode: 'baseline' | 'survey' = 'baseline',
    jobId?: string,
    // Whole-document AI context primer (now computed BEFORE /ingest, see
    // pipeline.worker.ts) -- threaded through so figure vision calls during
    // parsing can judge significance relative to the whole document, not
    // just in visual isolation. Optional/omitted for every call site
    // predating this field (e.g. /jobs/preview), matching jobId's own
    // backward-compat convention above.
    primerContext?: string,
  ): Promise<CanonicalDoc> {
    const form = new FormData();
    form.append('file', new Blob([fileBuffer]), filename);
    const params = new URLSearchParams({ mode });
    if (skipVision) {
      params.set('skip_vision', 'true');
    }
    if (jobId) {
      params.set('job_id', jobId);
    }
    if (primerContext) {
      params.set('primer_context', primerContext);
    }
    const url = `${this.baseUrl}/ingest?${params.toString()}`;
    const response = await fetch(url, { method: 'POST', body: form, dispatcher: this.longRunningAgent });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /ingest request failed: ${await _readErrorDetail(response)}`);
    }
    return (await response.json()) as CanonicalDoc;
  }
```

- [ ] **Step 5: Implement — `pipeline.worker.ts`**

Delete these now-unused declarations entirely: `PRIMER_CONTEXT_CHARS_PER_TOKEN_ESTIMATE`, `PRIMER_CONTEXT_MIN_DOCUMENT_TEXT_CHARS`, `PRIMER_NUM_CTX_RESERVED_TOKENS`, `PRIMER_NUM_CTX_BUCKETS`, the `estimateDocumentTextChars` function, the `resolvePrimerNumCtx` function.

Add in their place:

```typescript
// The primer now runs BEFORE /ingest (figures need document context during
// parsing, not just /level) -- there is no parsed `doc` yet to size num_ctx
// against. Per the design's explicit direction: don't reinvent a client-
// side size heuristic (page-count, raw-byte-count) here -- fixed at this
// deployment's real model ceiling (see the deleted PRIMER_NUM_CTX_BUCKETS'
// own comment: 32_768 is qwen2.5:32b-instruct/qwen3.6:35b's real native
// context window). A document whose real text exceeds this is an accepted,
// explicit tradeoff -- it silently loses primer enrichment (Open WebUI's
// own file-context handling may itself truncate or error; either way this
// call's fail-open catch below absorbs it) rather than failing the job.
const PRIMER_FIXED_NUM_CTX = 32_768;
```

Move the entire primer computation block (everything from the `const primerDocumentTextChars = estimateDocumentTextChars(doc);` line through the end of its enclosing `if (job.mode === 'survey' && ...) { ... }` block, including the trailing `catch` block) to **before** the `const [doc] = await Promise.all([...])` call. Within the moved block:

- Replace the gate condition. Change:
  ```typescript
  if (
    job.mode === 'survey' &&
    primerDocumentTextChars >= PRIMER_CONTEXT_MIN_DOCUMENT_TEXT_CHARS &&
    primerNumCtx !== null &&
    deps.openWebUiClient &&
    deps.primerCacheRedis
  ) {
  ```
  to:
  ```typescript
  if (job.mode === 'survey' && deps.openWebUiClient && deps.primerCacheRedis) {
  ```
- Change the cache key's content hash source from `job.fileBuffer` — this is unchanged, it already hashes `job.fileBuffer`, which is available before `/ingest` runs (no change needed here).
- Change the `numCtx` value passed to the `chat()` call from `primerNumCtx` to `PRIMER_FIXED_NUM_CTX`.
- Delete the `const primerDocumentTextChars = estimateDocumentTextChars(doc);` and `const primerNumCtx = resolvePrimerNumCtx(primerDocumentTextChars);` lines — `doc` doesn't exist yet at this new location.

After the moved block (now sitting before the `Promise.all`), update the `/ingest` call to pass `primerContext` through:

```typescript
    const [doc] = await Promise.all([
      deps.ingestionClient.ingest(job.fileBuffer, job.filename, false, job.mode, job.id, primerContext),
      maybeBackfillAreaPath(deps.prisma, deps.backfillService, job.areaPath, credential),
    ]);
```

The existing `/level` call (`deps.ingestionClient.level(doc, ..., primerContext)`) is unchanged — it already reads the same `primerContext` variable, now computed earlier but still in scope.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd orchestrator && npx jest test/ingestion-http.client.spec.ts test/pipeline.worker.spec.ts -v`
Expected: all pass

- [ ] **Step 7: Typecheck and run the full orchestrator suite**

Run: `cd orchestrator && npm run build && npm test`
Expected: clean build (confirms no other call site references the deleted `estimateDocumentTextChars`/`resolvePrimerNumCtx`/removed constants), all tests pass

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/modules/pipeline/pipeline.worker.ts orchestrator/src/modules/pipeline/ingestion-http.client.ts orchestrator/test/pipeline.worker.spec.ts orchestrator/test/ingestion-http.client.spec.ts
git commit -m "feat(pipeline): compute whole-document primer before /ingest, drop size gate"
```

---

### Task 5: Ingestion — wire document_context through /ingest, retire the sentinel, fix dropped-block check

**Files:**
- Modify: `ingestion/app/main.py`, `ingestion/app/loaders/docx_loader.py`, `ingestion/app/loaders/pdf_loader.py`, `ingestion/app/loaders/pptx_loader.py`, `ingestion/app/loaders/image_loader.py`, `ingestion/app/loaders/ocr.py`, `ingestion/app/leveling/llm_leveling.py`
- Test: `ingestion/tests/test_ingest_endpoint.py`, `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Consumes: Task 3's `OrchestratorVisionClient.describe_figure(...) -> FigureVisionResult`.
- Produces: `POST /ingest` gains an optional `primer_context: str | None = None` query param — **named to match the wire key Task 4's `ingestion-http.client.ts` already sends** (`params.set('primer_context', primerContext)`, the same key `/level` already uses; FastAPI matches query params by parameter name, so this name is load-bearing, not cosmetic). `_describe_figure(image_bytes: bytes, document_context: str | None = None) -> str | None` (return type changes from always-`str` to `str | None`; this function's own param is named `document_context` since it's a plain in-process Python call, never a URL query key — `ingest()`'s route handler passes its `primer_context` value into it). Every loader's `describe_figure` Callable type hint becomes `Callable[[bytes], str | None]`.

- [ ] **Step 1: Write the failing tests**

```python
# ingestion/tests/test_ingest_endpoint.py -- replace
# test_describe_figure_still_caches_the_real_no_technical_content_sentinel
# with these two tests (same file, same fixture-building conventions)

def test_describe_figure_returns_none_when_vision_model_judges_figure_insignificant(monkeypatch) -> None:
    import app.main as main_module
    from app.vision.orchestrator_vision_client import FigureVisionResult

    class _FakeVisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            return FigureVisionResult(significant=False, description="A decorative rectangular block.")

    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_narration_redis", _FakeRedis())

    result = main_module._describe_figure(b"fake-image-bytes")
    assert result is None


def test_describe_figure_returns_the_description_when_vision_model_judges_figure_significant(monkeypatch) -> None:
    import app.main as main_module
    from app.vision.orchestrator_vision_client import FigureVisionResult

    class _FakeVisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            return FigureVisionResult(significant=True, description="A power interface wiring diagram.")

    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_narration_redis", _FakeRedis())

    result = main_module._describe_figure(b"fake-image-bytes")
    assert result == "A power interface wiring diagram."


def test_describe_figure_forwards_document_context_to_the_vision_client(monkeypatch) -> None:
    import app.main as main_module
    from app.vision.orchestrator_vision_client import FigureVisionResult

    captured = {}

    class _FakeVisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            captured["document_context"] = document_context
            return FigureVisionResult(significant=True, description="ok")

    monkeypatch.setattr(main_module, "_vision_client", _FakeVisionClient())
    monkeypatch.setattr(main_module, "_narration_redis", _FakeRedis())

    main_module._describe_figure(b"fake-image-bytes", document_context="An avionics ICD.")
    assert captured["document_context"] == "An avionics ICD."


def test_ingest_route_accepts_primer_context_as_the_wire_query_key(monkeypatch) -> None:
    # Regression guard for the exact param-name mismatch this plan's own
    # self-review caught: the orchestrator sends this as `primer_context`
    # (matching /level's already-established key), NOT `document_context` --
    # a mismatched FastAPI param name would silently swallow the value with
    # no error, and every figure in a real request would get described with
    # zero document context despite the orchestrator sending it correctly.
    import inspect

    import app.main as main_module

    sig = inspect.signature(main_module.ingest)
    assert "primer_context" in sig.parameters
    assert "document_context" not in sig.parameters
```

(`_FakeRedis` already exists in this test file, used by the test being replaced — reuse it as-is; check its definition at `tests/test_ingest_endpoint.py:333` before writing these to confirm its `get`/`set` shape matches.)

```python
# ingestion/tests/test_llm_leveling.py -- replace
# test_build_survey_tree_skips_a_figure_the_vision_model_flagged_as_no_content
# with this (uses caption=None, the general convention, instead of the
# retired sentinel)

def test_build_survey_tree_does_not_flag_an_uncaptioned_figure_as_a_dropped_block() -> None:
    # A figure with no caption (vision judged it insignificant, OR vision
    # failed/was disabled -- both cases render identically as "[FIGURE: none]")
    # must not be flagged as a "dropped" block -- there was nothing to lose
    # either way.
    path = "empty_figure.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The unit shall boot within ten seconds.", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": "Boot time", "text": "The unit shall boot within ten seconds.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert tree.warnings == []
```

- [ ] **Step 2: Update every existing fake vision client to the new contract**

`_describe_figure` now calls `_vision_client.describe_figure(...)` expecting a `FigureVisionResult | None` back, not a bare `str`. Every hand-written fake vision client across the test suite that still returns a plain string will break with `AttributeError: 'str' object has no attribute 'significant'` the moment its test runs `/ingest` in SURVEY mode or calls `_describe_figure` directly. This step updates every one of them — confirmed complete inventory via `grep -n "class _FakeVisionClient\|def describe_figure" ingestion/tests/*.py` (re-run this yourself first to confirm no new fake vision client was added to the suite since this plan was written).

Add `from app.vision.orchestrator_vision_client import FigureVisionResult` to the top of `ingestion/tests/test_ingest_endpoint.py` and `ingestion/tests/test_ingest_figure_storage.py`.

In `ingestion/tests/test_ingest_endpoint.py`, for each of these test functions, change its local `_FakeVisionClient.describe_figure`'s return type annotation from `-> str` to `-> FigureVisionResult | None` and its `return "<text>"` line to `return FigureVisionResult(significant=True, description="<text>")` (same text, just wrapped — every one of these tests is exercising a genuinely-described figure, not an insignificance verdict, so `significant=True` preserves each test's existing intent exactly):

- `test_ingest_skip_vision_skips_figure_captioning_even_when_vision_is_configured` (`return "a description nobody asked for"`)
- `test_ingest_survey_mode_still_captions_when_vision_is_configured` (`return "a real caption"`)
- `test_describe_figure_caches_by_image_hash_so_a_rerun_gets_the_same_caption` (`return f"caption #{self.calls}"`)
- `test_describe_figure_calls_the_vision_client_again_for_genuinely_different_images` (`return f"caption #{self.calls}"`)
- `test_describe_figure_degrades_to_a_live_call_when_the_cache_read_or_write_fails` (`return "live caption"`)
- `test_ingest_publishes_describe_figure_and_parse_done_narration_when_job_id_is_given` (`return "a real caption"`)
- `test_ingest_publishes_no_narration_when_job_id_is_omitted` (`return "a real caption"`)
- `test_ingest_baseline_mode_never_captions_even_when_vision_is_configured` (`return "a description that must never appear in baseline"` — never actually called in this test, `fake_client.calls == 0` is asserted; fix the type for consistency anyway)
- `test_ingest_unrecognized_mode_value_fails_safe_to_baseline` (`return "should never be reached"` — same reasoning, never actually called)
- `test_figure_storage_uses_the_same_rasterized_bytes_as_captioning_not_the_original` (`return "a real caption"`)

`test_ingest_then_level_baseline_never_touches_a_configured_vision_client`'s `_ExplodingVisionClient` needs NO change — it raises before ever returning, so its return type is unreachable either way; update its annotation to `-> FigureVisionResult | None` purely for type-consistency with the real interface, no behavior change.

`test_describe_figure_never_caches_a_blank_result` needs special handling — this test's ENTIRE point is the "don't cache an ambiguous/failed result" guarantee, now expressed via `None` instead of a blank string. Replace its fake vision client and body with:

```python
def test_describe_figure_never_caches_a_blank_result(monkeypatch) -> None:
    # Fail-open protection: an unparseable/failed vision response (None,
    # see FigureVisionResult's own doc comment) must NOT be cached -- it
    # would otherwise replay that same "unknown" answer for a full week
    # (_FIGURE_CAPTION_CACHE_TTL_SECONDS), masking whatever caused the
    # original failure. A genuinely parsed result on retry must succeed
    # normally and get cached like any other real verdict.
    import app.main as main_module

    class _FakeVisionClient:
        def __init__(self) -> None:
            self.calls = 0

        def describe_figure(self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None) -> FigureVisionResult | None:
            self.calls += 1
            return None if self.calls == 1 else FigureVisionResult(significant=True, description="a real caption on retry")

    class _FakeRedis:
        def __init__(self) -> None:
            self._store: dict[str, bytes] = {}

        def get(self, key):
            return self._store.get(key)

        def set(self, key, value, ex=None):
            self._store[key] = value.encode("utf-8") if isinstance(value, str) else value

        def publish(self, channel, payload):
            pass

    fake_client = _FakeVisionClient()
    monkeypatch.setattr(main_module, "_vision_client", fake_client)
    monkeypatch.setattr(main_module, "_narration_redis", _FakeRedis())

    first = main_module._describe_figure(b"same-image-bytes")
    second = main_module._describe_figure(b"same-image-bytes")

    assert first is None
    # NOT served from a poisoned cache -- the None result was never
    # written, so the second call goes live again and self-heals.
    assert second == "a real caption on retry"
    assert fake_client.calls == 2
```

In `ingestion/tests/test_ingest_figure_storage.py`, the single module-level `_FakeVisionClient` (used by all 3 tests in that file) gets the same fix: `-> str` becomes `-> FigureVisionResult | None`, `return "a real caption"` becomes `return FigureVisionResult(significant=True, description="a real caption")`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_ingest_endpoint.py tests/test_ingest_figure_storage.py tests/test_llm_leveling.py -k "describe_figure or dropped_block" -v`
Expected: FAIL — `_describe_figure` still returns a `str` unconditionally, `NO_TECHNICAL_CONTENT_SENTINEL` import errors in the test file being replaced, `llm_leveling.py`'s dropped-blocks check doesn't recognize `"[FIGURE: none]"` as exempt

- [ ] **Step 4: Implement — `main.py`**

Remove the import of `NO_TECHNICAL_CONTENT_SENTINEL` (`:44` — change to `from app.vision.orchestrator_vision_client import OrchestratorVisionClient`).

Replace `_describe_figure` (`:287-337`):

```python
def _describe_figure(image_bytes: bytes, document_context: str | None = None) -> str | None:
    # Confirmed real root cause of run-to-run SURVEY node-count variance
    # (74 vs ~120 nodes for the identical document): a figure's caption was
    # previously freshly (re-)sampled on every single job run. Memoizing by
    # the image's own byte hash makes the SAME figure produce the SAME
    # result on every run -- but the cache key must now also depend on
    # document_context, since the SAME image embedded in two DIFFERENT
    # documents can legitimately get two DIFFERENT significance verdicts
    # once document context feeds the judgment (an image byte-identical
    # cache key alone would silently leak document A's verdict onto
    # document B). Fails open on any Redis error in either direction.
    cache_key = _figure_caption_cache_key(image_bytes, document_context)
    try:
        cached = _narration_redis.get(cache_key)
        if cached is not None:
            try:
                cached_obj = json.loads(cached.decode("utf-8"))
                return cached_obj["description"] if cached_obj["significant"] else None
            except (json.JSONDecodeError, KeyError, UnicodeDecodeError):
                pass  # Treat an unparseable cache entry as a miss, same as a blank one below.
    except Exception:
        logger.warning("Figure-caption cache read failed -- falling through to a live vision call", exc_info=True)

    describe_bytes, mime_type = _rasterize_for_vision(image_bytes)
    result = _vision_client.describe_figure(describe_bytes, mime_type, document_context)
    if result is None:
        # Totally unparseable vision response -- same "don't memorize a
        # glitch for a week" protection the old blank-caption guard
        # provided (see FigureVisionResult's own doc comment). Not cached;
        # self-heals on the next call/run instead of being locked in.
        return None
    try:
        _narration_redis.set(
            cache_key,
            json.dumps({"significant": result.significant, "description": result.description}),
            ex=_FIGURE_CAPTION_CACHE_TTL_SECONDS,
        )
    except Exception:
        logger.warning("Figure-caption cache write failed -- caption still returned, just not cached", exc_info=True)
    return result.description if result.significant else None
```

Replace `_figure_caption_cache_key` (`:251-260`):

```python
def _figure_caption_cache_key(original_image_bytes: bytes, document_context: str | None) -> str:
    # Keyed on the ORIGINAL bytes handed to _describe_figure, before any
    # EMF/WMF->PNG conversion below -- two callers with byte-identical
    # source images must hit the same cache entry regardless of which
    # conversion path either happened to take. document_context is now part
    # of the key -- see _describe_figure's own comment for why the same
    # image across two different documents can legitimately produce two
    # different significance verdicts once document context is a real
    # input to that judgment.
    context_hash = hashlib.sha256((document_context or "").encode("utf-8")).hexdigest()[:16]
    return f"figcap:{hashlib.sha256(original_image_bytes).hexdigest()}:{context_hash}"
```

Update `_describe_figure_with_progress` (`:677-748`) — it's defined inside `ingest()`, so it must close over the new `document_context` param (added to `ingest()`'s signature below) and pass it through, and its narration display logic no longer compares against the retired sentinel:

```python
        def _describe_figure_with_progress(image_bytes: bytes) -> str | None:
            figure_counter["n"] += 1
            index = figure_counter["n"]
            if narration_publisher is not None:
                narration_publisher.publish(
                    LevelingProgress(
                        phase="describe_figure",
                        branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                        kb_grounded=False, kb_citations=[],
                        figure_index=index, figure_count=figure_total,
                    )
                )
            # primer_context is the outer ingest() route param (closed over
            # by this nested function); _describe_figure's OWN parameter is
            # named document_context (see main.py's _describe_figure) since
            # it's a plain in-process argument, never a URL query key of its
            # own -- passing primer_context's value into it here is the one
            # place that boundary rename happens.
            caption = _describe_figure(image_bytes, primer_context)
            if narration_publisher is not None:
                # caption is None exactly when the vision model judged this
                # figure non-significant (or vision failed) -- both cases
                # get the same honest "nothing here" narration copy, same
                # spirit as the retired sentinel's display translation.
                display_caption = caption if caption is not None else "this figure has no discernible technical content"
                narration_publisher.publish(
                    LevelingProgress(
                        phase="describe_figure",
                        branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                        kb_grounded=False, kb_citations=[],
                        figure_index=index, figure_caption=display_caption, figure_count=figure_total,
                    )
                )
            if job_id is not None and _figure_file_client is not None:
                figure_id = f"f{index - 1}"
                try:
                    rasterized_bytes, _ = _rasterize_for_vision(image_bytes)
                    compressed = compress_figure_for_storage(rasterized_bytes)
                    if compressed is not None:
                        _figure_file_client.store(job_id, figure_id, compressed[0], compressed[1])
                except Exception:
                    logger.warning(
                        "Figure-file storage failed for %s -- it will not be attachable in ADO", figure_id, exc_info=True
                    )
            return caption

        describe_figure_fn = _describe_figure_with_progress
```

Add `primer_context` to `ingest()`'s route signature (`:594-609`) as a new trailing param — **named `primer_context`, not `document_context`**, to exactly match the query key Task 4's `ingestion-http.client.ts` sends (`params.set('primer_context', primerContext)`, the same key `/level` already uses) — FastAPI resolves query params by parameter name, so a mismatch here silently drops the value with no error anywhere:

```python
@app.post("/ingest", response_model=CanonicalDoc)
async def ingest(
    file: UploadFile,
    redact: bool = False,
    languages: str = "eng",
    skip_vision: bool = False,
    mode: str = "baseline",
    job_id: str | None = None,
    # Whole-document AI context primer (Phase 6/orchestrator's pipeline.worker.ts,
    # now computed BEFORE this call, not after) -- threaded to every figure's
    # describe_figure call during this document's own parse, so vision
    # significance can be judged relative to the whole document. Optional;
    # None produces byte-identical figure-only prompts to before this
    # parameter existed (see _build_prompt in orchestrator_vision_client.py).
    # Named `primer_context` (not `document_context`) to match the query key
    # ingestion-http.client.ts sends and /level already uses -- only renamed
    # to `document_context` internally, below, when passed into the
    # figure-description closure (a plain in-process argument, never a wire
    # key of its own).
    primer_context: str | None = None,
) -> CanonicalDoc:
```

- [ ] **Step 5: Implement — loader Callable type hints (mechanical, 6 locations, 5 files)**

In each of these files, change `describe_figure: Callable[[bytes], str] | None` to `describe_figure: Callable[[bytes], str | None] | None` — no other code in any of these files changes (loaders already pass the callback's return value straight into `Figure(caption=...)`, which already accepts `str | None`):

- `ingestion/app/loaders/docx_loader.py:603` (in `_describe_one_figure`) and `:694` (in `load_docx`)
- `ingestion/app/loaders/pdf_loader.py:1150` (in the PDF loader's main entry)
- `ingestion/app/loaders/pptx_loader.py:238` (in `load_pptx`)
- `ingestion/app/loaders/image_loader.py:10` (in `load_image`)
- `ingestion/app/loaders/ocr.py:58` (in the OCR entry point)

Also update `_describe_one_figure`'s own return type annotation in `docx_loader.py` (`:604`, currently `-> str | None` — already correct, no change needed there).

- [ ] **Step 6: Implement — `llm_leveling.py` dropped-blocks check**

Remove the now-dead import at `:66` (`from app.vision.orchestrator_vision_client import NO_TECHNICAL_CONTENT_SENTINEL`).

Replace the dropped-blocks list comprehension's first condition (`:2477`):

```python
    dropped_blocks = [
        i
        for i, block in enumerate(blocks)
        if not (block.kind == BlockKind.FIGURE and _figure_line(block) is None)
        and not _block_content_appears_in_generated_output(resolved_block_texts[i], combined_words)
        and not _REFERENCED_ATTACHMENT_PATTERN.search(resolved_block_texts[i])
    ]
```

(`_figure_line` is already imported into this module — see `:54`. This generalizes the old sentinel-specific carve-out to ANY figure with no caption, whether from a deliberate insignificance verdict or a vision failure — both are "nothing to lose" from a dropped-content standpoint, matching this codebase's existing fail-open philosophy.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_ingest_endpoint.py tests/test_ingest_figure_storage.py tests/test_llm_leveling.py tests/test_orchestrator_vision_client.py -v`
Expected: all pass

- [ ] **Step 8: Run the full ingestion suite (this closes out every remaining failure noted at the end of Task 3)**

Run: `cd ingestion && .venv/bin/python -m pytest tests/ -q`
Expected: all pass, zero references to `NO_TECHNICAL_CONTENT_SENTINEL` remain anywhere (verify with `grep -rn "NO_TECHNICAL_CONTENT" ingestion/app ingestion/tests` — expect zero results)

- [ ] **Step 9: Commit**

```bash
git add ingestion/app/main.py ingestion/app/loaders/docx_loader.py ingestion/app/loaders/pdf_loader.py ingestion/app/loaders/pptx_loader.py ingestion/app/loaders/image_loader.py ingestion/app/loaders/ocr.py ingestion/app/leveling/llm_leveling.py ingestion/tests/test_ingest_endpoint.py ingestion/tests/test_ingest_figure_storage.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(ingest): wire document_context through figure description, retire sentinel"
```

---

### Final Integration Check

After Task 5, run both full suites once more from the repo root to confirm the two services agree on the wire contract end to end:

```bash
cd ingestion && .venv/bin/python -m pytest tests/ -q
cd ../orchestrator && npm run build && npm test
```

Both must be fully green with no skips introduced by this plan. This is not a separate task — it is the final check before final review, matching this session's established pattern (PDF ingestion fidelity plan, docx analyze-stage fidelity plan).
