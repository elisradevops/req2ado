# req2ado — Product Roadmap

**Purpose of this doc:** the map every future session starts from. Read this first, then the
sibling docs (`design-decisions.md`, `backend-capabilities.md`, `docgen-connection-pattern.md`,
`phase1-spec.md`) for depth on a specific phase. Prior context: `docs/handoff-frontend-rebuild.md`.

## What req2ado does

Converts a customer requirements document (contract-signed spec, informal narrative, or
engineering ICD) into a hierarchical Azure DevOps work-item tree (Epic → Feature → Requirement).
Two modes: **BASELINE** (deterministic, verbatim, no LLM) and **SURVEY** (LLM-driven, distills
informal text into formal "shall" requirements — 15-40+ min on real documents). Flow: upload →
dry-run diff (preview, nothing written) → review → confirm (writes to ADO via a custom MCP server).

## Design integrity

This is a genuine, ground-up solution engineered for req2ado — not a copy of any competitor's
product or code. External references used only as:

- **General, public UX conventions** (review-before-commit, tree views, per-item validation —
  common engineering knowledge).
- **Open, published standards** meant to be implemented (EARS notation, INCOSE Guide for Writing
  Requirements, ISO/IEC/IEEE 29148).
- **Internal reuse of the user's own company app** (DocGen) for its connection/auth pattern — not
  third-party IP. See `docgen-connection-pattern.md`.

No competitor implementation is examined, lifted, or reproduced.

## Core product principle: RAG-first, optional, with graceful fallback + learning loop

The knowledge base is the **grounding layer the pipeline attempts first**, not a side feature —
but it is never a hard requirement:

- **RAG-first, optional (all LLM stages):** every LLM call *attempts* retrieval first and injects
  any relevant org context into the prompt before running — SURVEY hierarchy inference,
  requirement generation, quality scoring, and per-item chat. **If no KB is connected, or the KB
  returns nothing relevant for the task, the stage falls back to the AI model's own knowledge as
  baseline and proceeds ungrounded — it never blocks.** When the KB does have relevant material,
  grounding is preferred (higher quality, org-specific). Every injection point must no-op cleanly
  on empty retrieval.
- **Learning loop:** in-context grounding **plus** write-back — accepted/confirmed requirements
  are written back into the knowledge base so future runs retrieve past decisions. The app
  "learns" from usage in-context (no weight training).
- **Knowledge sources:** on-prem SharePoint (literal bearer token, sent the same way the ADO PAT
  is) + uploaded standards/glossary/rules docs.

Today (pre-Phase-2) there is **zero** retrieval-to-prompt injection anywhere in req2ado — confirmed
by investigation. The existing vector store (Chroma + cosine) only powers a dedup boolean and
stores no source text. RAG-first grounding is entirely net-new, built in Phase 2.

## Roadmap

Build in order. Each phase gets its own spec/plan when reached — this doc is the map, not the
detailed spec for phases beyond 1.

- **Phase 1 — Rebuild + cheap ADO wins** *(current, see `phase1-spec.md`)*: modern shell/routing/
  state, job list, tree diff view, upload wizard w/ pre-parse ETA, real ADO area-path picker, SSE
  progress, error/failed states; write taxonomy tags to ADO; configurable State/Iteration. SURVEY
  runs on the existing ungrounded pipeline — RAG arrives in Phase 2.

- **Phase 2 — RAG-first knowledge layer** *(the product's core; splits into sub-phases)*:
  - **P2a — SharePoint connector + KB** *(mirrors DocGen's pattern, see `docgen-connection-pattern.md`)*:
    credential travels per-request in the body; bearer token for the user's SharePoint case
    (`Authorization: Bearer`), NTLM as a future on-prem option; secrets stay client-side
    (sessionStorage), only non-secret config (site/library/folder) persists server-side. Fetch →
    chunk → **store source text** (net-new — today's vector store holds vectors only) → embed →
    persist, extending the existing Chroma+cosine store.
  - **P2b — RAG-first retrieval-injection**: prepend retrieve+inject to all LLM stages
    (infer_hierarchy, generate_requirements, chat) — grounds each call when relevant KB material
    exists; falls back to the model's baseline knowledge (no injection) when it doesn't.
  - **P2c — Quality score, RAG-grounded when possible**: per-item score judged against org
    rules/definitions retrieved from the KB when available; falls back to general EARS/INCOSE/29148
    checks (public standards) when no KB or no relevant rules exist. Shown as chips + score.
  - **P2d — Learning loop** *(deferred — see rationale below, revisit after Phase 3)*: write
    confirmed/accepted requirements back into the KB with dedup/curation.
    **Deferred 2026-07-14** after brainstorming: the naive version (derive "rules" from confirmed
    items' P2c quality_score/quality_issues) is circular — P2c's own LLM call already produced
    those issue flags, so a second LLM deriving "rules" from them mostly restates generic advice,
    not genuine org-specific learning. "Confirmed" today is also a whole-job action, not a
    per-item human endorsement of substance. The real learning signal is the diff between an
    LLM-generated item and what a human actually edited it to (Phase 3's not-yet-built per-item
    edit/accept/reject flow) — that reveals genuine org preference, not restated grading. Revisit
    P2d once Phase 3 ships and real edit-diffs exist to learn from.

- **Phase 3 — Review power**: editable dry-run diff (inline edit/delete/add before confirm — not
  possible today, confirmed by investigation: confirm re-reads the DB blob and reads no request
  body) + AI assist (per-item chat, refine/regenerate one item, accept/reject, source provenance).
  Feeds richer accepted-item data into the P2d learning loop.

- **Phase 4 — Traceability**: trace/coverage link types (Covers/CoveredBy/Affects) beyond the
  current parent-child-only linking; diff-vs-live-ADO tree / round-trip re-import (update, not
  duplicate); baselining.
