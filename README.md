# req2ado — Requirements-to-ADO Ingestion Platform

Converts heterogeneous customer requirement documents (txt/md/docx/pdf/scanned-pdf/xlsx)
into a hierarchical Azure DevOps / TFS work-item tree (Epic → Feature → Requirement),
with two operating modes:

- **BASELINE** (contract-signed): strict, verbatim, hash-verifiable, deterministic, LLM off by default.
- **SURVEY** (informal): generative — distills formal "shall"-style requirements with taxonomy tags.

See the full architecture/plan at `docs/architecture.md` (mirrors the approved planning
deliverable) and the in-app Wiki (`frontend/src/content/wiki/`) for user-facing guidance.

## Packages

| Package | Role | Stack |
|---|---|---|
| `frontend/` | GUI — login, upload, dry-run preview, job progress, results, in-app wiki | React 19 + Vite + TS + MUI/AntD + MobX |
| `orchestrator/` | API, app auth (RBAC), LLM redaction proxy, job queue producer + pipeline workers, Postgres/Prisma | Node 22 + TypeScript + NestJS |
| `ingestion/` | Document parsing (all formats), OCR, tables/figures, leveling heuristics, embeddings | Python 3.11 + FastAPI |
| `mcp-ado-server/` | Our MCP server — ADO work-item read/write tools (create/set-fields/link/update/dry-run), Streamable HTTP transport | Node 22 + TypeScript (`@modelcontextprotocol/sdk`) |
| `shared/` | Cross-package contracts: JSON Schema single-source → generated TS types + Python pydantic models | JSON Schema |

## Target environment

On-prem Azure DevOps Server / TFS (api-version `7.1`, fallback `7.1 → 5.1 → none`,
self-signed TLS via CA-trust). Dev/off-network via the built-in mock ADO backend
(SQLite/JSON) behind the same MCP tool contract — no real ADO connectivity required
to develop or test.

## Getting started

```bash
cp .env.template .env      # fill in LLM_*, ADO_*, MCP_*, REDIS_URL, DATABASE_URL
docker-compose up -d       # postgres, redis, chroma, mcp-ado-server, ingestion, orchestrator, frontend
```

Each package also runs standalone for development — see its own README once scaffolded
in Phase 0.

## Status

Phase 0 (foundations) in progress. See `docs/architecture.md` for the full 9-phase plan
(Phase 0–8) and `docs/prompts.md` for the runtime LLM prompt contracts.
