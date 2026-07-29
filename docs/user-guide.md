# req2ado User Guide

## What this tool does

Converts a requirements document (contract, survey, or engineering spec) into a structured Epic → Feature → Requirement hierarchy in Azure DevOps.

## Modes

- **Baseline** — verbatim extraction. The tool never rewrites your text; titles are truncated (not summarized) from the source, and every requirement's description is byte-for-byte traceable back to the source document via a fidelity hash. Use this for signed contracts and formal specs where wording must not change.
- **Survey** — generative. The tool uses an AI model to turn informal notes into formal "shall"-style requirements, merges near-duplicate clauses, infers parents the numbering implies but never states, and scores each requirement for quality. Use this for early-stage or informally-written requirements. Runs 15–40+ minutes on a real document and uses model quota, versus Baseline's few minutes.

## Workflow

1. **Upload** a document and specify the target ADO Area Path.
2. The tool ingests the document, infers a hierarchy, and computes a **dry-run diff** — a preview of what would be created or reused, without writing anything to ADO yet.
3. Review the diff. Each row shows whether that item would be newly created or would reuse an existing ADO work item (re-running the same document never creates duplicates).
4. Click **Confirm** to perform the actual ADO write — this cannot be undone from req2ado; items must be deleted directly in Azure DevOps afterward.

## Customer ID

If your ADO project has a custom "Customer ID" field, the tool automatically detects its real field name (it checks a few common naming conventions) — you don't need to configure this yourself in most cases.

## Troubleshooting

- **"Upload failed"** — check that the file format is supported (txt, md, docx, pdf, scanned PDF, xlsx) and that the Area Path field is filled in.
- **Diff never becomes ready** — the ingestion service may be unreachable; contact your administrator.
