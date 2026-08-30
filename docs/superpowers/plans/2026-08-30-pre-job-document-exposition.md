# Pre-Job Document Exposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a reviewer two things SWEEP.md's item 5 flagged as missing: a SURVEY-only "does this look right" document synopsis generated in the New Job Wizard before a Job exists, and per-node grounding-score surfacing plus a collapsed-by-default tree on the job page.

**Architecture:** A new orchestrator endpoint (`POST /jobs/preview/exposition`) generates `{synopsis, caveat}` from the wizard's already-fetched step-1 preview data — a deterministic caveat function plus one LLM call, no re-parse. The wizard gains a real third step (SURVEY-only) that calls it and is the actual job-creation trigger; the result is persisted on `Job.documentOverview` at creation. Separately, `DiffTree`/`NodeDetailPanel` gain `groundingScore` surfacing (a review chip, a toolbar filter, a metric in the detail panel) and a mode-agnostic collapsed-by-default tree.

**Tech Stack:** NestJS + Prisma (orchestrator), React + Vitest (frontend), Jest (orchestrator tests).

**Spec:** `docs/superpowers/specs/2026-08-30-pre-job-document-exposition-design.md`

## Global Constraints

- Never fail or block job creation on exposition-call failure — fail-open, matching this codebase's convention everywhere an LLM call is optional.
- SURVEY-only, structurally: no BASELINE code path calls the exposition endpoint or reads `groundingScore`/`qualityScore`-derived UI. The tree's default-collapse is the one mode-agnostic exception.
- The exposition call never re-parses the uploaded file — it consumes only the heading/document-map data step 1's existing `POST /jobs/preview` already returned.
- The caveat is deterministic, computed from real thresholds in plain code — never left for the LLM to decide.
- No new narration phase, no SSE-replay plumbing — this feature never touches `build_survey_tree` or the ingestion pipeline.

---

## Task 1: `Job.documentOverview` column

**Files:**
- Modify: `orchestrator/prisma/schema.prisma` (Job model, near `tableDescriptions`/`excludedFigureIds`)
- Create: `orchestrator/prisma/migrations/20260830130000_add_job_document_overview/migration.sql`

**Interfaces:**
- Produces: `Job.documentOverview: Json?` — shape `{ synopsis: string; caveat: string | null } | null`, read/written by every later task in this plan.

- [ ] **Step 1: Add the column to the schema**

In `orchestrator/prisma/schema.prisma`, inside `model Job { ... }`, add immediately after the `excludedTableIds Json?` line:

```prisma
  // Whole-document synopsis generated once, at job creation time, in the
  // New Job Wizard's SURVEY-only "Confirm understanding" step -- BEFORE
  // this Job row even exists (see DocumentOverviewService). Shape:
  // { synopsis: string, caveat: string | null }. Always null for BASELINE
  // (never attempted) and for a SURVEY job whose generation call failed at
  // wizard time (fails open, same convention as every other optional
  // LLM-dependent signal in this codebase) -- the two cases are
  // distinguished client-side by Job.mode, not by this column's nullness.
  documentOverview Json?
```

- [ ] **Step 2: Write the migration file by hand**

Create `orchestrator/prisma/migrations/20260830130000_add_job_document_overview/migration.sql`:

```sql
-- Job.documentOverview: whole-document synopsis generated in the New Job
-- Wizard's SURVEY-only "Confirm understanding" step, persisted at job
-- creation. Same nullable-JSONB convention as figureDescriptions/warnings.

ALTER TABLE "Job" ADD COLUMN "documentOverview" JSONB;
```

- [ ] **Step 3: Validate the schema**

Run: `cd orchestrator && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

Do NOT run `npx prisma migrate deploy`/`db push` against a live database — matching this repo's own hand-authored-migration convention (see `20260830120000_add_audit_jobid_indexes`), the migration file ships unapplied from this session.

- [ ] **Step 4: Commit**

```bash
cd /Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado
git add orchestrator/prisma/schema.prisma orchestrator/prisma/migrations/20260830130000_add_job_document_overview
git commit -m "feat(orchestrator): add Job.documentOverview column"
```

---

## Task 2: `DocumentOverviewService` — deterministic caveat + LLM synopsis

**Files:**
- Create: `orchestrator/src/modules/pipeline/document-overview.service.ts`
- Test: `orchestrator/test/document-overview.service.spec.ts`

**Interfaces:**
- Consumes: `OpenWebUiClient.chat(messages, opts)` (`orchestrator/src/modules/llm/llm-client.interface.ts`) — already exported by `LlmModule`, already imported by `JobsModule` (`orchestrator/src/modules/pipeline/jobs.module.ts:20,27`). `DocumentMapSection` (`orchestrator/src/modules/pipeline/document-map.ts:9-17`).
- Produces: `export interface DocumentOverview { synopsis: string; caveat: string | null }`, `export function computeDeterministicCaveat(sectionCount: number, depth: number, documentMap: DocumentMapSection[]): string | null`, `export class DocumentOverviewService { generate(input: {documentMap: DocumentMapSection[]; sectionCount: number; depth: number}): Promise<DocumentOverview | null> }` — both consumed by Task 3's controller endpoint.

- [ ] **Step 1: Write the failing tests**

```typescript
// orchestrator/test/document-overview.service.spec.ts
import { computeDeterministicCaveat, DocumentOverviewService } from '../src/modules/pipeline/document-overview.service';
import type { DocumentMapSection } from '../src/modules/pipeline/document-map';

function section(blockCount: number): DocumentMapSection {
  return { number: null, title: 'Section', blockCount, figureCount: 0 };
}

describe('computeDeterministicCaveat', () => {
  it('returns null for a small, shallow document', () => {
    const documentMap = Array.from({ length: 6 }, () => section(10));
    expect(computeDeterministicCaveat(6, 2, documentMap)).toBeNull();
  });

  it('returns a caveat when max heading depth is unusually deep', () => {
    const documentMap = Array.from({ length: 6 }, () => section(10));
    expect(computeDeterministicCaveat(6, 5, documentMap)).not.toBeNull();
  });

  it('returns a caveat when the document is large and fragmented (many tiny sections)', () => {
    // Mirrors the real AirPro ICD shape used throughout this feature's
    // design review: 79 sections, most with 0-2 blocks.
    const documentMap = [
      ...Array.from({ length: 50 }, () => section(1)),
      ...Array.from({ length: 29 }, () => section(20)),
    ];
    expect(computeDeterministicCaveat(79, 3, documentMap)).not.toBeNull();
  });

  it('does not fire on a large document that is NOT fragmented', () => {
    const documentMap = Array.from({ length: 40 }, () => section(15));
    expect(computeDeterministicCaveat(40, 3, documentMap)).toBeNull();
  });
});

describe('DocumentOverviewService.generate', () => {
  it('returns a synopsis with the deterministic caveat attached', async () => {
    const chat = jest.fn().mockResolvedValue({ content: 'This document specifies interface requirements for a backplane.' });
    const service = new DocumentOverviewService({ chat } as any);

    const documentMap = Array.from({ length: 6 }, () => section(10));
    const result = await service.generate({ documentMap, sectionCount: 6, depth: 2 });

    expect(result).toEqual({
      synopsis: 'This document specifies interface requirements for a backplane.',
      caveat: null,
    });
    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ seed: 42 }),
    );
  });

  it('fails open to null when the LLM call throws', async () => {
    const chat = jest.fn().mockRejectedValue(new Error('backend unreachable'));
    const service = new DocumentOverviewService({ chat } as any);

    const result = await service.generate({ documentMap: [section(10)], sectionCount: 1, depth: 1 });

    expect(result).toBeNull();
  });

  it('fails open to null when the LLM returns empty content', async () => {
    const chat = jest.fn().mockResolvedValue({ content: '   ' });
    const service = new DocumentOverviewService({ chat } as any);

    const result = await service.generate({ documentMap: [section(10)], sectionCount: 1, depth: 1 });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest document-overview.service.spec.ts`
Expected: FAIL — `Cannot find module '../src/modules/pipeline/document-overview.service'`

- [ ] **Step 3: Write the implementation**

```typescript
// orchestrator/src/modules/pipeline/document-overview.service.ts
import { Injectable } from '@nestjs/common';
import { OpenWebUiClient } from '../llm/openwebui.client';
import type { DocumentMapSection } from './document-map';

export interface DocumentOverview {
  synopsis: string;
  caveat: string | null;
}

// Thresholds tuned against a real, deeply fragmented ICD used throughout
// this feature's own design review (79 top-level sections' worth of
// headings collapsed into 543 flat rows, max depth 5, per-section
// blockCount ranging 0-37) -- see docs/superpowers/specs/2026-08-30-pre-
// job-document-exposition-design.md. Deliberately NOT model-decided: the
// caveat must never depend on the LLM choosing to raise a concern.
const DEEP_NESTING_DEPTH_THRESHOLD = 4;
const FRAGMENTED_MIN_SECTION_COUNT = 30;
const FRAGMENTED_TINY_SECTION_FRACTION = 0.4;
const TINY_SECTION_BLOCK_COUNT = 2;

const CAVEAT_TEXT =
  "This document's heading structure is unusually deep and fragmented — many small sections sit alongside a few much larger ones. Worth a closer look to confirm nothing was misclassified.";

export function computeDeterministicCaveat(sectionCount: number, depth: number, documentMap: DocumentMapSection[]): string | null {
  const deepNesting = depth >= DEEP_NESTING_DEPTH_THRESHOLD;
  const tinySectionCount = documentMap.filter((section) => section.blockCount <= TINY_SECTION_BLOCK_COUNT).length;
  const fragmented = sectionCount >= FRAGMENTED_MIN_SECTION_COUNT && tinySectionCount / sectionCount >= FRAGMENTED_TINY_SECTION_FRACTION;
  return deepNesting || fragmented ? CAVEAT_TEXT : null;
}

const SYNOPSIS_SYSTEM_PROMPT = `You are summarizing a requirements/interface document for an engineer who is about to review an AI-generated breakdown of it. Given a list of its real section headings, write ONE short paragraph (2-4 sentences) that:
1. States what kind of document this is and what system/subject it specifically covers -- be concrete, not generic.
2. Ends with one sentence describing what to expect from processing it (roughly how many discrete requirements, across how many sections).
Do not mention structural concerns, formatting, or how deep/fragmented the document is -- that is handled separately. Respond with the paragraph only, no heading, no preamble.`;

@Injectable()
export class DocumentOverviewService {
  constructor(private readonly llmClient: OpenWebUiClient) {}

  async generate(input: { documentMap: DocumentMapSection[]; sectionCount: number; depth: number }): Promise<DocumentOverview | null> {
    const caveat = computeDeterministicCaveat(input.sectionCount, input.depth, input.documentMap);
    const headingList = input.documentMap
      .map((section) => (section.number ? `${section.number} ${section.title}` : section.title))
      .join('\n');
    try {
      const result = await this.llmClient.chat(
        [
          { role: 'system', content: SYNOPSIS_SYSTEM_PROMPT },
          { role: 'user', content: `Real section headings, in document order:\n\n${headingList}` },
        ],
        { seed: 42, maxTokens: 300 },
      );
      const synopsis = result.content.trim();
      if (!synopsis) return null;
      return { synopsis, caveat };
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest document-overview.service.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/pipeline/document-overview.service.ts orchestrator/test/document-overview.service.spec.ts
git commit -m "feat(orchestrator): add DocumentOverviewService (deterministic caveat + LLM synopsis)"
```

---

## Task 3: `POST /jobs/preview/exposition` endpoint

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts` (constructor + new endpoint, place after the existing `preview` handler, `jobs.controller.ts:180-262`)
- Modify: `orchestrator/src/modules/pipeline/jobs.module.ts` (register `DocumentOverviewService` as a provider)
- Test: `orchestrator/test/jobs.controller.preview-exposition.spec.ts` (new file — `orchestrator/test/jobs.controller.spec.ts` already exists with 42 pre-existing `new JobsController(...)` call sites that need fixing, see Step 6 below; keeping this endpoint's own tests in a separate new file avoids touching that large file more than necessary)

**Interfaces:**
- Consumes: `DocumentOverviewService.generate` (Task 2).
- Produces: `POST /jobs/preview/exposition` returning `DocumentOverview | null`, consumed by Task 6's frontend `previewExposition()`.

- [ ] **Step 1: Register the new provider**

In `orchestrator/src/modules/pipeline/jobs.module.ts`, add the import and provider (bare class provider — `OpenWebUiClient` is a real, non-erased import already resolvable via `LlmModule`, same as `JobsController`'s own direct `OpenWebUiClient` injection):

```typescript
import { DocumentOverviewService } from './document-overview.service';
```

Add `DocumentOverviewService` to the `providers` array (anywhere after the array's opening, e.g. right after the `PrismaClient` provider entry).

- [ ] **Step 2: Write the failing test**

```typescript
// orchestrator/test/jobs.controller.preview-exposition.spec.ts
import { JobsController } from '../src/modules/pipeline/jobs.controller';

describe('JobsController.previewExposition', () => {
  function makeController(documentOverviewService: any): JobsController {
    return new JobsController(
      {} as any, // jobsService
      {} as any, // ingestionClient
      {} as any, // llmClient
      {} as any, // adoCredentialResolver
      {} as any, // workItemTypeCatalogService
      {} as any, // etaService
      1024 * 1024, // maxUploadSizeBytes
      documentOverviewService,
    );
  }

  it('returns the generated overview for valid input', async () => {
    const documentOverviewService = { generate: jest.fn().mockResolvedValue({ synopsis: 'About a backplane.', caveat: null }) };
    const controller = makeController(documentOverviewService);

    const result = await controller.previewExposition([{ number: null, title: 'Intro', blockCount: 5, figureCount: 0 }], 1, 2);

    expect(result).toEqual({ synopsis: 'About a backplane.', caveat: null });
    expect(documentOverviewService.generate).toHaveBeenCalledWith({
      documentMap: [{ number: null, title: 'Intro', blockCount: 5, figureCount: 0 }],
      sectionCount: 1,
      depth: 2,
    });
  });

  it('returns null without calling the service when documentMap is missing', async () => {
    const documentOverviewService = { generate: jest.fn() };
    const controller = makeController(documentOverviewService);

    const result = await controller.previewExposition(undefined, 1, 2);

    expect(result).toBeNull();
    expect(documentOverviewService.generate).not.toHaveBeenCalled();
  });

  it('returns null without calling the service when sectionCount/depth are missing', async () => {
    const documentOverviewService = { generate: jest.fn() };
    const controller = makeController(documentOverviewService);

    const result = await controller.previewExposition([], undefined, undefined);

    expect(result).toBeNull();
    expect(documentOverviewService.generate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd orchestrator && npx jest jobs.controller.preview-exposition.spec.ts`
Expected: FAIL — `Expected 8 arguments, but got 7` (constructor doesn't accept `documentOverviewService` yet) or `controller.previewExposition is not a function`

- [ ] **Step 4: Add the constructor param and endpoint**

In `orchestrator/src/modules/pipeline/jobs.controller.ts`, add the import:

```typescript
import { DocumentOverviewService } from './document-overview.service';
import type { DocumentMapSection } from './document-map';
```

Add `private readonly documentOverviewService: DocumentOverviewService,` as the last constructor parameter (after `maxUploadSizeBytes`).

Add the new endpoint directly after the existing `preview` handler (after its closing `}` around line 262):

```typescript
  // No file upload here -- consumes the heading/document-map data the
  // wizard's step-1 preview() call already returned, so this never
  // re-parses the document. SURVEY-only from the caller's side (the
  // wizard only calls this once SURVEY is selected); this endpoint itself
  // has no mode check since it does nothing mode-specific.
  @Post('preview/exposition')
  async previewExposition(
    @Body('documentMap') documentMap: DocumentMapSection[] | undefined,
    @Body('sectionCount') sectionCount: number | undefined,
    @Body('depth') depth: number | undefined,
  ): Promise<{ synopsis: string; caveat: string | null } | null> {
    if (!documentMap || typeof sectionCount !== 'number' || typeof depth !== 'number') {
      return null;
    }
    return this.documentOverviewService.generate({ documentMap, sectionCount, depth });
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd orchestrator && npx jest jobs.controller.preview-exposition.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Fix the 42 pre-existing `new JobsController(...)` call sites in `test/jobs.controller.spec.ts`**

Adding a required 8th constructor parameter breaks every existing positional `new JobsController(...)` call in this file (confirmed: exactly 42 call sites, none elsewhere in the codebase). Their argument lists are inconsistently formatted (some single-line, some multi-line, some with a trailing comma) but never contain nested parentheses, so a paren-depth-aware script can append the new argument to every one of them safely regardless of formatting:

```bash
cd orchestrator
python3 - << 'EOF'
path = "test/jobs.controller.spec.ts"
text = open(path).read()
out = []
i = 0
count = 0
while True:
    idx = text.find("new JobsController(", i)
    if idx == -1:
        out.append(text[i:])
        break
    out.append(text[i:idx])
    start = idx + len("new JobsController(")
    depth = 1
    j = start
    while depth > 0:
        if text[j] == '(':
            depth += 1
        elif text[j] == ')':
            depth -= 1
        j += 1
    call_args = text[start:j-1]
    stripped = call_args.rstrip()
    trailing_ws = call_args[len(stripped):]
    if stripped.endswith(","):
        new_args = stripped + " {} as any," + trailing_ws
    else:
        new_args = stripped + ", {} as any" + trailing_ws
    out.append("new JobsController(" + new_args + ")")
    count += 1
    i = j
open(path, "w").write("".join(out))
print("rewrote", count, "call sites")
EOF
```

Expected output: `rewrote 42 call sites`. This was dry-run tested against a scratch copy of this exact file during planning (verified with `node --check`, which parses `.ts` syntax including `as any` under Node 22's built-in type-stripping) — both the single-line and trailing-comma multi-line forms produce valid syntax.

- [ ] **Step 7: Run the full orchestrator suite to catch any remaining constructor-arity breaks**

Run: `cd orchestrator && npx jest jobs.controller`
Expected: PASS. If any other test file outside `test/jobs.controller.spec.ts` also constructs `JobsController` positionally (none were found during planning, but confirm), add `, {} as any` for `documentOverviewService` at that call site by hand.

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.controller.ts orchestrator/src/modules/pipeline/jobs.module.ts orchestrator/test/jobs.controller.spec.ts orchestrator/test/jobs.controller.preview-exposition.spec.ts
git commit -m "feat(orchestrator): add POST /jobs/preview/exposition endpoint"
```

---

## Task 4: Thread `documentOverview` through job creation

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts` (`SubmitJobInput` interface `:77-97`, `submit()`'s `prisma.job.create` call `:227-240`)
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts` (`submit()` handler `:134-176`)
- Test: `orchestrator/test/jobs.service.spec.ts` (`describe('JobsService.submit'`, `:4250`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SubmitJobInput.documentOverview?: { synopsis: string; caveat: string | null } | null` — a job created with this set has it available immediately via `getById()` (Task 5).

- [ ] **Step 1: Write the failing test**

Add to the `describe('JobsService.submit', ...)` block in `orchestrator/test/jobs.service.spec.ts`:

```typescript
  it('persists documentOverview on the created job when provided', async () => {
    jest.spyOn(Queue.prototype, 'add').mockResolvedValue(undefined as any);
    const jobCreate = jest.fn().mockResolvedValue({ id: 'job-1' });
    const prisma = {
      job: { create: jobCreate },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await service.submit({
      areaPath: 'Project\\Area1', userId: null, mode: 'survey',
      fileBuffer: Buffer.from('doc'), filename: 'doc.docx', sourceHash: 'hash-1',
      documentOverview: { synopsis: 'About a backplane.', caveat: null },
    });

    expect(jobCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ documentOverview: { synopsis: 'About a backplane.', caveat: null } }) }),
    );
  });

  it('persists a null documentOverview when omitted (BASELINE, or SURVEY with no override)', async () => {
    jest.spyOn(Queue.prototype, 'add').mockResolvedValue(undefined as any);
    const jobCreate = jest.fn().mockResolvedValue({ id: 'job-1' });
    const prisma = {
      job: { create: jobCreate },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await service.submit({
      areaPath: 'Project\\Area1', userId: null, mode: 'baseline',
      fileBuffer: Buffer.from('doc'), filename: 'doc.docx', sourceHash: 'hash-1',
    });

    expect(jobCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ documentOverview: null }) }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest jobs.service.spec.ts -t "documentOverview"`
Expected: FAIL — `documentOverview` not present in the `create` call's data object

- [ ] **Step 3: Thread the field through**

In `orchestrator/src/modules/pipeline/jobs.service.ts`, add to `SubmitJobInput` (`:77-97`), after the existing `model` field comment/declaration:

```typescript
  // Generated in the wizard's SURVEY-only "Confirm understanding" step
  // (see DocumentOverviewService), BEFORE this Job row exists -- passed
  // straight through here, never recomputed. Always undefined/null for
  // BASELINE, or for a SURVEY submission whose generation call failed at
  // wizard time (fail-open, same convention as every other optional
  // LLM-dependent signal in this codebase).
  documentOverview?: { synopsis: string; caveat: string | null } | null;
```

In `submit()`'s `prisma.job.create` data object (`:229-239`), add:

```typescript
        documentOverview: input.documentOverview ?? null,
```

In `orchestrator/src/modules/pipeline/jobs.controller.ts`'s `submit()` handler (`:134-176`), add a new param and parse it before calling `jobsService.submit`:

```typescript
    @Body('documentOverview') documentOverviewRaw: string | undefined,
```

(added to the parameter list, matching the existing `@Body('model')` style)

Before the `return this.jobsService.submit({...})` call, add:

```typescript
    // Parsed defensively -- a malformed/unexpected shape must never fail
    // job creation, same fail-open contract DocumentOverviewService itself
    // already follows.
    let documentOverview: { synopsis: string; caveat: string | null } | null = null;
    if (documentOverviewRaw) {
      try {
        const parsed = JSON.parse(documentOverviewRaw);
        if (parsed && typeof parsed.synopsis === 'string') {
          documentOverview = { synopsis: parsed.synopsis, caveat: typeof parsed.caveat === 'string' ? parsed.caveat : null };
        }
      } catch {
        documentOverview = null;
      }
    }
```

Add `documentOverview,` to the object passed to `this.jobsService.submit({...})`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest jobs.service.spec.ts -t "documentOverview"`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full jobs.service + jobs.controller suites**

Run: `cd orchestrator && npx jest jobs.service.spec.ts jobs.controller`
Expected: PASS — no other `submit()`/`submit` call sites should have broken (the new controller param is optional/last, the new service field is optional).

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/src/modules/pipeline/jobs.controller.ts orchestrator/test/jobs.service.spec.ts
git commit -m "feat(orchestrator): persist documentOverview at job creation"
```

---

## Task 5: Read `documentOverview` back through `getById()`

**Files:**
- Modify: `orchestrator/src/modules/pipeline/jobs.service.ts` (`getById()` return type `:485-542` and return object `:548-574`)
- Modify: `orchestrator/src/modules/pipeline/jobs.controller.ts` (`getById()` return type `:284-317`)
- Test: `orchestrator/test/jobs.service.spec.ts` (`describe('JobsService.getById'`, `:4423`)

**Interfaces:**
- Produces: `getById()` result gains `documentOverview: { synopsis: string; caveat: string | null } | null`, consumed by Task 12's `JobDetail.tsx`.

- [ ] **Step 1: Write the failing test**

Add to the `describe('JobsService.getById', ...)` block:

```typescript
  it('returns the persisted documentOverview', async () => {
    const prisma = {
      job: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', mode: 'survey', dryRunDiff: [],
          warnings: null, kbCitations: [], figureDescriptions: null,
          documentOverview: { synopsis: 'About a backplane.', caveat: 'Unusually deep.' },
          _count: { createdItemMappings: 0 },
        }),
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.getById('job-1');

    expect(result?.documentOverview).toEqual({ synopsis: 'About a backplane.', caveat: 'Unusually deep.' });
  });

  it('returns null documentOverview for a BASELINE job (never attempted)', async () => {
    const prisma = {
      job: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [],
          warnings: null, kbCitations: [], figureDescriptions: null, documentOverview: null,
          _count: { createdItemMappings: 0 },
        }),
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.getById('job-1');

    expect(result?.documentOverview).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx jest jobs.service.spec.ts -t "documentOverview"`
Expected: FAIL — `result?.documentOverview` is `undefined`, not the expected object/`null`

- [ ] **Step 3: Add the field**

In `jobs.service.ts`'s `getById()` return type (`:485-542`), add after `excludedTableIds: string[];`:

```typescript
    documentOverview: { synopsis: string; caveat: string | null } | null;
```

In the return object (`:548-574`), add after `excludedTableIds: (job.excludedTableIds as string[] | null) ?? [],`:

```typescript
      documentOverview: job.documentOverview as { synopsis: string; caveat: string | null } | null,
```

In `orchestrator/src/modules/pipeline/jobs.controller.ts`'s `getById()` return type (`:284-317`), add the same field to the annotation (it flows through automatically via the `...job` spread at `:321`, since the field is now part of what `ownedJob`/`jobsService.getById` returns — only the type annotation needs updating so TypeScript doesn't strip it):

```typescript
    documentOverview: { synopsis: string; caveat: string | null } | null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx jest jobs.service.spec.ts`
Expected: PASS — full file, including the two new tests and every pre-existing `getById` test (which now also implicitly expects `documentOverview: undefined` unless their mocked `findUnique` row includes it — if any pre-existing `toEqual` assertion fails because it doesn't expect this new key, add `documentOverview: null` to that test's expected object, matching how the mocked row omits the column).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/pipeline/jobs.service.ts orchestrator/src/modules/pipeline/jobs.controller.ts orchestrator/test/jobs.service.spec.ts
git commit -m "feat(orchestrator): return documentOverview from GET /jobs/:id"
```

---

## Task 6: Frontend API client — `previewExposition` + `submitJob` threading

**Files:**
- Modify: `frontend/src/api/jobs.ts`
- Test: `frontend/src/api/jobs.test.ts` (create if it doesn't already exist as a describe block for this file)

**Interfaces:**
- Produces: `export interface DocumentOverview { synopsis: string; caveat: string | null }`, `export async function previewExposition(params: { documentMap: DocumentMapSection[]; sectionCount: number; depth: number }): Promise<DocumentOverview | null>`, `SubmitJobParams.documentOverview?: DocumentOverview | null`. Consumed by Task 8 (`NewJobWizard.tsx`).

- [ ] **Step 1: Write the failing test**

```typescript
// Add to (or create) a describe block in a test file covering src/api/jobs.ts,
// e.g. frontend/src/api/jobs.test.ts
import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { previewExposition, submitJob } from './jobs';

vi.mock('./httpClient');

describe('previewExposition', () => {
  it('posts the heading outline and returns the overview', async () => {
    vi.mocked(httpClient.post).mockResolvedValue({ data: { synopsis: 'About a backplane.', caveat: null } } as any);

    const result = await previewExposition({ documentMap: [{ number: null, title: 'Intro', blockCount: 5, figureCount: 0 }], sectionCount: 1, depth: 2 });

    expect(result).toEqual({ synopsis: 'About a backplane.', caveat: null });
    expect(httpClient.post).toHaveBeenCalledWith('/jobs/preview/exposition', {
      documentMap: [{ number: null, title: 'Intro', blockCount: 5, figureCount: 0 }],
      sectionCount: 1,
      depth: 2,
    });
  });
});

describe('submitJob', () => {
  it('appends documentOverview to the form data when provided', async () => {
    vi.mocked(httpClient.post).mockResolvedValue({ data: { jobId: 'job-1' } } as any);

    await submitJob({
      file: new File(['x'], 'doc.docx'),
      areaPath: 'Project\\Area1',
      mode: 'survey',
      documentOverview: { synopsis: 'About a backplane.', caveat: null },
    });

    const formData = vi.mocked(httpClient.post).mock.calls[0][1] as FormData;
    expect(formData.get('documentOverview')).toBe(JSON.stringify({ synopsis: 'About a backplane.', caveat: null }));
  });

  it('omits documentOverview from the form data when not provided', async () => {
    vi.mocked(httpClient.post).mockResolvedValue({ data: { jobId: 'job-1' } } as any);

    await submitJob({ file: new File(['x'], 'doc.docx'), areaPath: 'Project\\Area1', mode: 'baseline' });

    const formData = vi.mocked(httpClient.post).mock.calls[0][1] as FormData;
    expect(formData.get('documentOverview')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/api/jobs.test.ts`
Expected: FAIL — `previewExposition` is not exported / `documentOverview` never appended

- [ ] **Step 3: Implement**

In `frontend/src/api/jobs.ts`, add after `PreviewResult` (`:59-69`):

```typescript
export interface DocumentOverview {
  synopsis: string;
  caveat: string | null;
}

export async function previewExposition(params: {
  documentMap: DocumentMapSection[];
  sectionCount: number;
  depth: number;
}): Promise<DocumentOverview | null> {
  const response = await httpClient.post<DocumentOverview | null>('/jobs/preview/exposition', params);
  return response.data;
}
```

Update `SubmitJobParams` (`:100-109`), adding:

```typescript
  // Generated by the wizard's SURVEY-only "Confirm understanding" step
  // (previewExposition above) -- undefined/null for BASELINE or a failed
  // generation.
  documentOverview?: DocumentOverview | null;
```

Update `submitJob` (`:111-121`), adding before the `httpClient.post` call:

```typescript
  if (params.documentOverview) form.append('documentOverview', JSON.stringify(params.documentOverview));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/api/jobs.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/jobs.ts frontend/src/api/jobs.test.ts
git commit -m "feat(frontend): add previewExposition API client, thread documentOverview through submitJob"
```

---

## Task 7: `JobDetail` type gains `documentOverview`

**Files:**
- Modify: `frontend/src/store/jobsStore.ts` (`JobDetail` interface, `:20+`)

**Interfaces:**
- Produces: `JobDetail.documentOverview: { synopsis: string; caveat: string | null } | null` — consumed by Task 12.

- [ ] **Step 1: Add the field**

In `frontend/src/store/jobsStore.ts`'s `JobDetail` interface, add after `excludedTableIds?: string[];`:

```typescript
  // Generated once in the New Job Wizard's SURVEY-only "Confirm
  // understanding" step, before this Job existed -- see Job.documentOverview's
  // schema.prisma doc comment. Null for BASELINE (never attempted, an
  // explicit mode-driven state, see JobDetail.tsx's DocumentOverviewCard)
  // or a SURVEY job whose generation call failed at wizard time.
  documentOverview: { synopsis: string; caveat: string | null } | null;
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean (no test asserts against this type directly; this step only fails if some other file constructs a literal `JobDetail` object missing this now-required field — if so, add `documentOverview: null` to that fixture).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/store/jobsStore.ts
git commit -m "feat(frontend): add documentOverview to the JobDetail type"
```

(If Step 2 required fixing other fixtures, `git add` those files too before committing.)

---

## Task 8: New Job Wizard — the SURVEY-only "Confirm understanding" step

**Files:**
- Modify: `frontend/src/pages/NewJobWizard.tsx`
- Test: `frontend/src/pages/NewJobWizard.test.tsx`

**Interfaces:**
- Consumes: `previewExposition` (Task 6), `PreviewResult.documentMap/sectionCount/depth` (already present).
- Produces: nothing consumed elsewhere — this is the wizard's own terminal UI.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/pages/NewJobWizard.test.tsx`:

```typescript
describe('NewJobWizard Step 3 (Confirm understanding, SURVEY-only)', () => {
  async function uploadAndConfigureAsSurvey(): Promise<void> {
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    const file = new File(['x'], 'req.docx');
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    await userEvent.upload(input, file);
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    await userEvent.click(screen.getByRole('radio', { name: /survey/i }));
  }

  it('BASELINE never shows step 3 -- Start job submits directly from step 2', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 1, figureCount: 0, depth: 1, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <NewJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    const file = new File(['x'], 'req.docx');
    await userEvent.upload(screen.getByLabelText(/upload/i), file);
    await waitFor(() => expect(screen.getByRole('button', { name: /configure/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /configure/i }));
    // BASELINE is the default mode -- no mode selection needed.
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');

    await userEvent.click(screen.getByRole('button', { name: /start job/i }));

    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline', documentOverview: undefined }));
    expect(screen.queryByText(/does this look right/i)).not.toBeInTheDocument();
  });

  it('SURVEY selection advances to step 3 and shows the generated synopsis', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition').mockResolvedValue({ synopsis: 'About a backplane.', caveat: null });
    await uploadAndConfigureAsSurvey();

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText('About a backplane.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /looks right/i })).toBeInTheDocument();
  });

  it('"Looks right -- start job" submits with the generated documentOverview', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition').mockResolvedValue({ synopsis: 'About a backplane.', caveat: null });
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    await uploadAndConfigureAsSurvey();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('About a backplane.')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /looks right/i }));

    expect(jobsApi.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'survey', documentOverview: { synopsis: 'About a backplane.', caveat: null } }),
    );
  });

  it('"Back to configure" returns to step 2 without losing the area path', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition').mockResolvedValue({ synopsis: 'About a backplane.', caveat: null });
    await uploadAndConfigureAsSurvey();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('About a backplane.')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /back to configure/i }));

    expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
  });

  it('exposition failure still allows the job to be created', async () => {
    vi.spyOn(jobsApi, 'previewJob').mockResolvedValue({
      blockCount: 1, sectionCount: 6, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [],
    } as any);
    vi.spyOn(jobsApi, 'listModels').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'previewExposition').mockRejectedValue(new Error('LLM unreachable'));
    vi.spyOn(jobsApi, 'submitJob').mockResolvedValue({ jobId: 'job-1' });
    await uploadAndConfigureAsSurvey();
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /start job|looks right/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /start job|looks right/i }));

    expect(jobsApi.submitJob).toHaveBeenCalledWith(expect.objectContaining({ documentOverview: null }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/NewJobWizard.test.tsx`
Expected: FAIL — step 3 doesn't exist yet, no "Continue"/"Looks right" buttons render

- [ ] **Step 3: Implement the step-3 state and step transitions**

In `frontend/src/pages/NewJobWizard.tsx`:

Change the step type (`:154`):

```typescript
  const [step, setStep] = useState<1 | 2 | 3>(1);
```

Add new state near the other `useState` declarations (after `model`/`availableModels`, `:170-171`):

```typescript
  const [documentOverview, setDocumentOverview] = useState<DocumentOverview | null>(null);
  const [expositionStatus, setExpositionStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
```

Add the import (top of file, alongside the other `../api/jobs` imports):

```typescript
import { previewExposition, type DocumentOverview } from '../api/jobs';
```

Replace the module-level `WIZARD_STEPS` constant (`:33`) with two mode-specific arrays:

```typescript
const WIZARD_STEPS_BASELINE = ['Upload document', 'Configure & review'];
const WIZARD_STEPS_SURVEY = ['Upload document', 'Configure & review', 'Confirm understanding'];
```

Add a new function near `handleSubmit` (`:271-290`) — rename nothing, `handleSubmit` keeps creating the job exactly as today, just gains `documentOverview`:

```typescript
  async function handleSubmit(): Promise<void> {
    if (!file || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      const { jobId } = await submitJob({
        file,
        areaPath,
        mode,
        state: state || undefined,
        iterationPath: iterationPath || undefined,
        model: mode === 'survey' ? model || undefined : undefined,
        documentOverview: mode === 'survey' ? documentOverview : undefined,
      });
      navigate(`/jobs/${jobId}`);
    } catch {
      showToast('Failed to start the job. Please try again.', 'error');
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  // Step 2's own submit button: BASELINE creates the job directly
  // (unchanged); SURVEY instead advances to step 3, where the real
  // creation trigger lives.
  function handleContinueFromConfigure(): void {
    if (mode === 'survey') {
      setStep(3);
    } else {
      void handleSubmit();
    }
  }
```

Add a `useEffect` (near the other effects, e.g. right after the model-fetching effect) that fires the exposition call exactly once per entry into step 3:

```typescript
  useEffect(() => {
    if (step !== 3 || expositionStatus !== 'idle' || !preview) return;
    setExpositionStatus('loading');
    previewExposition({ documentMap: preview.documentMap, sectionCount: preview.sectionCount, depth: preview.depth })
      .then((result) => {
        setDocumentOverview(result);
        setExpositionStatus('ready');
      })
      .catch(() => {
        setDocumentOverview(null);
        setExpositionStatus('error');
      });
  }, [step, expositionStatus, preview]);
```

- [ ] **Step 4: Change step 2's button and add the step-3 render block**

In the step-2 render block, change the `handleSubmit`/"Start job" button (`:601-604`) to branch by mode:

```typescript
            <Button onClick={handleContinueFromConfigure} disabled={!areaPath || (hasAdoSession && !project) || isSubmitting} className="ml-auto">
              {isSubmitting ? <Spinner /> : mode === 'survey' ? <ArrowRight className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
              {isSubmitting ? 'Starting…' : mode === 'survey' ? 'Continue' : 'Start job'}
            </Button>
```

Change the `<Stepper>` calls (`:304` and `:424`) to pick the right array by mode:

```typescript
        <Stepper steps={mode === 'survey' ? WIZARD_STEPS_SURVEY : WIZARD_STEPS_BASELINE} activeIndex={0} />
```

```typescript
      <Stepper steps={mode === 'survey' ? WIZARD_STEPS_SURVEY : WIZARD_STEPS_BASELINE} activeIndex={1} />
```

Add a new `if (step === 3)` render block, right before the existing `return (` that renders step 2 (i.e., right after the `if (step === 1) { ... }` block closes, `:414`):

```typescript
  if (step === 3) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="New Job" description="Confirm the AI understood this document before it runs" />
        <Stepper steps={WIZARD_STEPS_SURVEY} activeIndex={2} />
        <SectionCard title="Does this look right?">
          <div className="flex flex-col gap-3">
            {expositionStatus === 'loading' && (
              <p className="flex items-center gap-2 text-sm text-ink-3">
                <Spinner /> Reading the document's structure…
              </p>
            )}
            {expositionStatus === 'ready' && documentOverview && (
              <>
                <p className="text-sm text-ink-1">{documentOverview.synopsis}</p>
                {documentOverview.caveat && (
                  <Alert severity="warning">{documentOverview.caveat}</Alert>
                )}
              </>
            )}
            {expositionStatus === 'error' && (
              <p className="text-sm text-ink-3">Couldn't generate a summary — you can still continue.</p>
            )}
          </div>
        </SectionCard>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => setStep(2)}>
            ← Back to configure
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting} className="ml-auto">
            {isSubmitting ? <Spinner /> : <Activity className="h-3.5 w-3.5" />}
            {isSubmitting ? 'Starting…' : 'Looks right — start job'}
          </Button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/NewJobWizard.test.tsx`
Expected: PASS

- [ ] **Step 6: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — confirm no other test asserted on the old single `WIZARD_STEPS` constant or the old unconditional `handleSubmit` wiring on step 2's button.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/NewJobWizard.tsx frontend/src/pages/NewJobWizard.test.tsx
git commit -m "feat(frontend): add SURVEY-only Confirm-understanding step to the New Job Wizard"
```

---

## Task 9: `DiffTree` — `groundingScore`, review chip, default-collapsed tree

**Files:**
- Modify: `frontend/src/components/DiffTree.tsx`
- Create: `frontend/src/utils/diffFlagging.ts`
- Test: `frontend/src/utils/diffFlagging.test.ts`, `frontend/src/components/DiffTree.test.tsx`

**Interfaces:**
- Produces: `DryRunDiffEntry.groundingScore?: number | null`; `export function isFlaggedDiffEntry(entry: {groundingScore?: number | null; qualityScore?: number | null}): boolean`; `DiffTree`'s `collapsedIds` initial state now pre-populated. Consumed by Task 10 (toolbar filter) and Task 11 (NodeDetailPanel).

- [ ] **Step 1: Write the failing test for the flagging utility**

```typescript
// frontend/src/utils/diffFlagging.test.ts
import { describe, it, expect } from 'vitest';
import { isFlaggedDiffEntry } from './diffFlagging';

describe('isFlaggedDiffEntry', () => {
  it('is false when both scores are null', () => {
    expect(isFlaggedDiffEntry({ groundingScore: null, qualityScore: null })).toBe(false);
  });

  it('is true when groundingScore is below 0.2', () => {
    expect(isFlaggedDiffEntry({ groundingScore: 0.1, qualityScore: null })).toBe(true);
  });

  it('is true when qualityScore is below 50', () => {
    expect(isFlaggedDiffEntry({ groundingScore: null, qualityScore: 30 })).toBe(true);
  });

  it('is false when both scores are healthy', () => {
    expect(isFlaggedDiffEntry({ groundingScore: 0.9, qualityScore: 95 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/utils/diffFlagging.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the utility**

```typescript
// frontend/src/utils/diffFlagging.ts
// Mirrors orchestrator/src/modules/pipeline/diff-summary.ts's own
// isFlaggedDiffEntry thresholds exactly. Duplicated deliberately, not
// imported -- frontend and orchestrator are separate deployables with no
// shared package for a ~4-line pure function, same precedent as
// frontend/src/lib/canNest.ts (see that file's own doc comment for the
// "five build-infrastructure changes for a ~10-line pure function" reasoning).
const LOW_GROUNDING_THRESHOLD = 0.2;
const LOW_QUALITY_THRESHOLD = 50;

export function isFlaggedDiffEntry(entry: { groundingScore?: number | null; qualityScore?: number | null }): boolean {
  return (
    (entry.groundingScore != null && entry.groundingScore < LOW_GROUNDING_THRESHOLD) ||
    (entry.qualityScore != null && entry.qualityScore < LOW_QUALITY_THRESHOLD)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/utils/diffFlagging.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing tests for `DiffTree`'s default collapse + review chip**

Add to `frontend/src/components/DiffTree.test.tsx` (using this file's existing fixture/render helper conventions — build entries as plain `DryRunDiffEntry[]` literals, matching how existing tests in this file already do):

```typescript
it('loads with every Feature collapsed by default, hiding its Requirements', () => {
  const entries: DryRunDiffEntry[] = [
    { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
    { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
    { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Req 1', description: '', action: 'create', customerId: null },
  ];
  render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

  expect(screen.getByText('Epic 1')).toBeInTheDocument();
  expect(screen.getByText('Feature 1')).toBeInTheDocument();
  expect(screen.queryByText('Req 1')).not.toBeInTheDocument();
});

it('shows a review chip on a flagged entry, not on a healthy one', () => {
  const entries: DryRunDiffEntry[] = [
    { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
    { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
    { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Flagged req', description: '', action: 'create', customerId: null, groundingScore: 0.1 },
    { localId: 'r2', parentLocalId: 'f1', type: 'Requirement', title: 'Healthy req', description: '', action: 'create', customerId: null, groundingScore: 0.9 },
  ];
  render(<DiffTree entries={entries} selectedId={null} onSelect={() => {}} filterAction={null} filterText="" onToggleExclude={() => {}} />);

  // Feature 1 starts collapsed (see the test above) -- expand it to reach the Requirements.
  fireEvent.click(screen.getByRole('button', { name: /expand feature 1/i }));

  expect(screen.getByText('Flagged req').closest('[role="row"], div')?.parentElement).toHaveTextContent(/review/i);
  expect(screen.getByText('Healthy req').closest('[role="row"], div')?.parentElement).not.toHaveTextContent(/review/i);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx`
Expected: FAIL — today's default is fully expanded (Req 1 would already be visible), and no review chip exists

- [ ] **Step 7: Add `groundingScore` to `DryRunDiffEntry` and default-collapse Features**

In `frontend/src/components/DiffTree.tsx`, add to the `DryRunDiffEntry` interface (`:78+`), right after `qualityScore?: number | null;`:

```typescript
  // Computed server-side alongside qualityScore (vocabulary-overlap check
  // against the node's own source text) -- see DiffTree's own review-chip
  // rendering and NodeDetailPanel's Grounding metric. Same nullability
  // convention as qualityScore: absent for BASELINE and for a manually-
  // added entry.
  groundingScore?: number | null;
```

Change the `collapsedIds` initial state (`:417`) from an always-empty set to one pre-populated with every Feature id, computed once from the incoming `entries` prop:

```typescript
  // Collapsed parent nodes -- purely a display concern (not lifted to
  // JobDetail), so toggling one never touches the diff data itself.
  // Starts with every Feature id collapsed (hiding its Requirement
  // children) so a large document's tree reads as an outline first, not a
  // wall of leaf text -- Epics stay expanded so their Features are
  // visible immediately. Computed once, from the entries this component
  // mounted with; toggling never re-derives it.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(entries.filter((entry) => entry.type === 'Feature').map((entry) => entry.localId)),
  );
```

- [ ] **Step 8: Add the review chip to each row**

`DiffTree.tsx` already imports both `Chip` (`:33`, `import { Chip } from '../ui/Chip';`) and renders `<ActionBadge action={entry.action} existingAdoId={entry.existingAdoId} orgUrl={orgUrl} project={project} />` at `:1060`. Import `isFlaggedDiffEntry`:

```typescript
import { isFlaggedDiffEntry } from '../utils/diffFlagging';
```

Immediately before that `<ActionBadge .../>` element at `:1060`, add:

```typescript
              {isFlaggedDiffEntry(entry) && (
                <Chip bg="var(--color-warning-soft)" color="var(--color-warning-ink)" className="border border-warning-border">
                  ⚠ Review
                </Chip>
              )}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx`
Expected: PASS

- [ ] **Step 10: Run the full DiffTree suite to catch collapse-default regressions**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx`
Expected: PASS — every pre-existing test in this file that asserted a Requirement/leaf row was immediately visible without expanding must now either expand the relevant Feature first, or construct its fixture with `type: 'Requirement'` entries parented directly under an `'Epic'` (not `'Feature'`), which stays uncollapsed. Fix each such test by adding the expand step, matching the pattern in Step 5's own test above.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/DiffTree.tsx frontend/src/utils/diffFlagging.ts frontend/src/utils/diffFlagging.test.ts frontend/src/components/DiffTree.test.tsx
git commit -m "feat(frontend): default-collapse Features in DiffTree, add groundingScore + review chip"
```

---

## Task 10: `JobDetail` toolbar — "Needs review · N" filter

**Files:**
- Modify: `frontend/src/components/DiffTree.tsx` (new `filterFlaggedOnly` prop)
- Modify: `frontend/src/pages/JobDetail.tsx` (toolbar `:1429-1454`, `<DiffTree>` invocation `:1455-1472`)
- Test: `frontend/src/components/DiffTree.test.tsx`, `frontend/src/pages/JobDetail.test.tsx`

**Interfaces:**
- Consumes: `isFlaggedDiffEntry` (Task 9).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test for `DiffTree`'s new prop**

Add to `frontend/src/components/DiffTree.test.tsx`:

```typescript
it('filterFlaggedOnly shows only flagged entries, expanding their ancestors', () => {
  const entries: DryRunDiffEntry[] = [
    { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic 1', description: '', action: 'create', customerId: null },
    { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature 1', description: '', action: 'create', customerId: null },
    { localId: 'r1', parentLocalId: 'f1', type: 'Requirement', title: 'Flagged req', description: '', action: 'create', customerId: null, groundingScore: 0.1 },
    { localId: 'r2', parentLocalId: 'f1', type: 'Requirement', title: 'Healthy req', description: '', action: 'create', customerId: null, groundingScore: 0.9 },
  ];
  render(
    <DiffTree
      entries={entries}
      selectedId={null}
      onSelect={() => {}}
      filterAction={null}
      filterText=""
      filterFlaggedOnly
      onToggleExclude={() => {}}
    />,
  );

  expect(screen.getByText('Flagged req')).toBeInTheDocument();
  expect(screen.queryByText('Healthy req')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx -t "filterFlaggedOnly"`
Expected: FAIL — unknown prop, no filtering behavior

- [ ] **Step 3: Add the prop**

In `DiffTree`'s prop destructure and type (`:360-414`), add `filterFlaggedOnly` (default `false`):

```typescript
  filterFlaggedOnly = false,
```

```typescript
  // Isolates flagged rows (see isFlaggedDiffEntry) -- ANDed with
  // filterAction/filterText, a separate filter dimension from action-type
  // filtering, not a value inside filterAction's own vocabulary.
  filterFlaggedOnly?: boolean;
```

Update `isFiltering` (`:428`) and the `rows` memo (`:436-446`):

```typescript
  const isFiltering = !!filterAction || !!filterText || filterFlaggedOnly;
```

```typescript
  const rows = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return allRows.filter((row) => {
      if (!matchesDiffFilter({ action: row.entry.action, title: row.entry.title, index: row.index }, filterAction, query)) return false;
      if (filterFlaggedOnly && !isFlaggedDiffEntry(row.entry)) return false;
      if (isFiltering) return true;
      return !row.ancestorIds.some((ancestorId) => collapsedIds.has(ancestorId));
    });
  }, [allRows, filterAction, filterText, filterFlaggedOnly, isFiltering, collapsedIds]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx -t "filterFlaggedOnly"`
Expected: PASS

- [ ] **Step 5: Write the failing test for `JobDetail`'s toolbar chip**

Add to `frontend/src/pages/JobDetail.test.tsx` (following this file's existing render-helper convention for mounting `JobDetail` with a fake job/diff — match whatever existing test in this file already does to get a `diff_ready` SURVEY job onto the tree tab):

```typescript
it('shows a "Needs review" filter chip with the flagged count, and isolates flagged rows on click', async () => {
  // ... render JobDetail with a diff containing 2 entries, one flagged
  // (groundingScore: 0.1) and one healthy (groundingScore: 0.9) ...
  expect(screen.getByRole('button', { name: /needs review/i })).toHaveTextContent('1');

  await userEvent.click(screen.getByRole('button', { name: /needs review/i }));

  expect(screen.getByText(/flagged/i)).toBeInTheDocument();
  // the healthy entry's own title, whatever the fixture used, must not render
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/JobDetail.test.tsx -t "Needs review"`
Expected: FAIL — no such chip exists yet

- [ ] **Step 7: Implement the toolbar chip**

In `frontend/src/pages/JobDetail.tsx`, add state near `filterAction` (`:176`):

```typescript
  const [filterFlaggedOnly, setFilterFlaggedOnly] = useState(false);
```

Import `isFlaggedDiffEntry` (`../utils/diffFlagging`). Compute the flagged count near where `summary`/`diff` are already derived:

```typescript
  const flaggedCount = useMemo(() => diff.filter((entry) => isFlaggedDiffEntry(entry)).length, [diff]);
```

In the toolbar block (`:1429-1454`), add after the existing `<Select>` (`:1437-1442`):

```typescript
                    {flaggedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setFilterFlaggedOnly((prev) => !prev)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
                          filterFlaggedOnly
                            ? 'border-warning bg-warning-soft text-warning-ink'
                            : 'border-warning-border bg-warning-soft text-warning',
                        )}
                      >
                        ⚠ Needs review · {flaggedCount}
                      </button>
                    )}
```

Add the import at the top of the file (not currently imported in `JobDetail.tsx`):

```typescript
import { cn } from '../lib/cn';
```

Add `filterFlaggedOnly={filterFlaggedOnly}` to the `<DiffTree>` invocation (`:1455-1472`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/JobDetail.test.tsx -t "Needs review"`
Expected: PASS

- [ ] **Step 9: Run the full DiffTree + JobDetail suites**

Run: `cd frontend && npx vitest run src/components/DiffTree.test.tsx src/pages/JobDetail.test.tsx`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/DiffTree.tsx frontend/src/pages/JobDetail.tsx frontend/src/components/DiffTree.test.tsx frontend/src/pages/JobDetail.test.tsx
git commit -m "feat(frontend): add a Needs-review toolbar filter to the job diff tree"
```

---

## Task 11: `NodeDetailPanel` — `Grounding` metric

**Files:**
- Modify: `frontend/src/components/NodeDetailPanel.tsx`
- Test: `frontend/src/components/NodeDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `DryRunDiffEntry.groundingScore` (Task 9).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/NodeDetailPanel.test.tsx` (matching this file's existing render-helper convention for mounting the panel with a fake `entry`):

```typescript
it('renders a Grounding metric when groundingScore is present, marked low below 0.2', () => {
  // ... render NodeDetailPanel with entry: { ...baseRequirementEntry, groundingScore: 0.14 } ...
  expect(screen.getByText('0.14')).toBeInTheDocument();
  expect(screen.getByText(/grounding/i)).toBeInTheDocument();
  expect(screen.getByText(/low/i)).toBeInTheDocument();
});

it('omits the Grounding metric when groundingScore is null (e.g. a BASELINE node)', () => {
  // ... render NodeDetailPanel with entry: { ...baseRequirementEntry, groundingScore: null } ...
  expect(screen.queryByText(/grounding/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx -t "Grounding"`
Expected: FAIL — no Grounding text renders

- [ ] **Step 3: Implement**

In `frontend/src/components/NodeDetailPanel.tsx`, immediately after the `{entry.type === 'Requirement' && (...)}` quality block closes (the block starting at `:587`), add a new sibling block:

```typescript
      {entry.groundingScore != null && (
        <div className="flex items-center gap-1.5 rounded-sm border border-hairline bg-surface-alt p-2.5 text-sm">
          <span className={cn('font-mono font-semibold', entry.groundingScore < 0.2 ? 'text-warning' : 'text-ink-1')}>
            {entry.groundingScore.toFixed(2)}
          </span>
          <span className="text-ink-3">Grounding{entry.groundingScore < 0.2 ? ' ⚠ low' : ''}</span>
        </div>
      )}
```

(`cn` is already imported in this file, per its existing `cn(entry.qualityStale && 'opacity-50')` usage at `:595`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx -t "Grounding"`
Expected: PASS

- [ ] **Step 5: Run the full NodeDetailPanel suite**

Run: `cd frontend && npx vitest run src/components/NodeDetailPanel.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/NodeDetailPanel.tsx frontend/src/components/NodeDetailPanel.test.tsx
git commit -m "feat(frontend): show groundingScore as a Grounding metric in NodeDetailPanel"
```

---

## Task 12: `JobDetail` — Document overview card + BASELINE absence note

**Files:**
- Modify: `frontend/src/pages/JobDetail.tsx`
- Test: `frontend/src/pages/JobDetail.test.tsx`

**Interfaces:**
- Consumes: `JobDetail.documentOverview` (Task 7).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/pages/JobDetail.test.tsx`:

```typescript
it('renders the Document overview card for a SURVEY job with a real documentOverview', async () => {
  // ... render JobDetail with a fake job: { mode: 'survey', documentOverview: { synopsis: 'About a backplane.', caveat: null }, ... } ...
  expect(await screen.findByText('About a backplane.')).toBeInTheDocument();
});

it('renders nothing for a SURVEY job whose exposition generation failed (documentOverview null)', async () => {
  // ... render JobDetail with a fake job: { mode: 'survey', documentOverview: null, ... } ...
  expect(screen.queryByText(/document overview/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/isn.t produced for baseline/i)).not.toBeInTheDocument();
});

it('renders an explicit absence note for a BASELINE job, never the card', async () => {
  // ... render JobDetail with a fake job: { mode: 'baseline', documentOverview: null, ... } ...
  expect(await screen.findByText(/isn.t produced for baseline jobs/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/JobDetail.test.tsx -t "Document overview"`
Expected: FAIL — neither the card nor the absence note render yet

- [ ] **Step 3: Wire `documentOverview` into this page's state**

`JobDetail.tsx` mirrors the fetched job onto individual `useState` fields inside `loadJob()`'s `getJob(id).then((job) => {...})` callback (`:214-228`), e.g. `setStatus(job.status); setMode(job.mode); ...`. Add a new state declaration alongside the other per-field `useState`s already declared near `:198-210` (e.g. right after wherever `mode`'s own `useState` is declared):

```typescript
  const [documentOverview, setDocumentOverview] = useState<{ synopsis: string; caveat: string | null } | null>(null);
```

Add to `loadJob()`'s `.then((job) => {...})` callback, alongside the existing `setMode(job.mode);` at `:222`:

```typescript
        setDocumentOverview(job.documentOverview ?? null);
```

- [ ] **Step 4: Render the card and the absence note**

Add the import at the top of the file:

```typescript
import { LABEL_MICRO } from '../utils/labelMicro';
```

Add a new block right after the `JobLifecycleSteps`/`NarrationTicker` block closes (after `:1323`, before the `actionableWarningCount` `Alert` at `:1324`):

```typescript
      {mode === 'survey' && documentOverview && (
        <div className="mb-4 flex flex-col gap-2 rounded-md border border-hairline bg-surface p-3">
          <span className={LABEL_MICRO}>Document overview</span>
          <p className="text-sm text-ink-1">{documentOverview.synopsis}</p>
          {documentOverview.caveat && <Alert severity="warning">{documentOverview.caveat}</Alert>}
          <span className="text-xs text-ink-3">Generated from the document's real structure — not a literal excerpt.</span>
        </div>
      )}
      {mode === 'baseline' && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-dashed border-hairline-strong p-3 text-xs text-ink-3">
          <span>
            Document overview isn't produced for BASELINE jobs — deterministic extraction, nothing to verify.
          </span>
        </div>
      )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/JobDetail.test.tsx -t "Document overview"`
Expected: PASS

- [ ] **Step 6: Run the full JobDetail suite**

Run: `cd frontend && npx vitest run src/pages/JobDetail.test.tsx`
Expected: PASS

- [ ] **Step 7: Run every affected suite one final time**

```bash
cd orchestrator && npx jest
cd ../frontend && npx vitest run
cd .. && npx tsc --noEmit -p orchestrator/tsconfig.build.json && npx tsc --noEmit -p frontend
```

Expected: all PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/JobDetail.tsx frontend/src/pages/JobDetail.test.tsx
git commit -m "feat(frontend): show the Document overview card (SURVEY) and an explicit absence note (BASELINE)"
```

---

## Notes for whoever executes this plan

- Tasks 9-11 (grounding surfacing, tree default-collapse) have **no dependency** on Tasks 1-8 (the wizard/backend exposition work) — `groundingScore`/`qualityScore` already exist on every `DryRunDiffEntry` today. If parallelizing across subagents, Tasks 1-2-3-4-5 (backend) and Tasks 9-10-11 (grounding) can run as two independent tracks; Tasks 6-7-8 (wizard) depend on 1-5; Task 12 depends on 5 and 7.
- Task 8's exact `Select`/`radio`/`button` accessible names (`getByLabelText(/upload/i)`, `getByRole('radio', {name: /survey/i})`, etc.) are inferred from this codebase's established component conventions (`TextField`, `Select`, `ModeCards`) — if any query doesn't match the real rendered DOM at implementation time, adjust the query to match the actual accessible name/role rather than changing the component's markup to fit the test.
- Every `git commit` step assumes commits are wanted in this repo per its own established session convention (see recent commit history — this repo's sessions commit per-task, unlike some other projects' global no-commit defaults).
