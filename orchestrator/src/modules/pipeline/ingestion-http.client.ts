import { Injectable } from '@nestjs/common';
import { Agent } from 'undici';
import type { CanonicalDoc, WorkItemTree } from '@req2ado/shared-ts';
import type { FolderIngestFile } from '../kb/kb.service';

// undici's default headersTimeout (300s) is shorter than a real local LLM
// can take for SURVEY mode's two sequential calls (infer_hierarchy +
// generate_requirements_for_document) on CPU/GPU-constrained hardware —
// observed directly: a 12b-class Ollama model took several minutes per
// call. /level and /kb/ingest-url (Graph fetch + parse + per-chunk embedding)
// are the only calls that can run this long (BASELINE never touches an LLM;
// /ingest, /dedup/check, /dedup/upsert are all fast); scoped to a dedicated
// Agent rather than raising the timeout for every ingestion call.
//
// Raised 30min -> 60min after a live run against a large document (152
// SURVEY branches, ~2 sequential LLM calls each) hit UND_ERR_HEADERS_TIMEOUT
// at the 30min mark even on a fast, GPU-accelerated small model -- branch
// count, not model speed, dominates total /level wall time. A real fix
// (parallelizing or streaming per-branch progress) is tracked separately;
// this is the immediate unblock.
//
// This is the OUTERMOST timeout in the SURVEY call ladder (orchestrator ->
// ingestion -> ingestion's own /llm/chat proxy -> the LLM backend) --
// deliberately the widest, so an inner layer's own timeout always fires
// first and this one only ever catches a genuinely wedged /level call, not
// a merely-slow one. Now constructor-configurable (default unchanged) so
// the ladder's ordering can be verified/tuned without a code change.
const DEFAULT_INGESTION_REQUEST_TIMEOUT_MS = 3_600_000;

export class IngestionHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// Confirmed real UX gap (user-reported): every one of this client's
// non-ok checks previously threw `new Error(\`... failed: ${status}\`)`,
// discarding whatever real error detail ingestion's response body carried
// -- so a failed job's audit trail only ever showed a bare status code
// ("Ingestion /level request failed: 500"), useless for figuring out what
// actually went wrong. ingestion's own exception handlers (main.py) now
// return `{"detail": "<the real exception message>"}` on failure -- this
// reads that detail (falling back to the raw response text, then the bare
// status, for a body that isn't the expected JSON shape) so the real
// message survives all the way to the job's audit entry.
async function _readErrorDetail(response: Response): Promise<string> {
  const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
  if (!text) return String(response.status);
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === 'string' && parsed.detail.length > 0) return parsed.detail;
  } catch {
    // Not JSON (e.g. a proxy/gateway's own HTML error page) -- fall through
    // to the raw text below rather than losing it entirely.
  }
  return text;
}

/**
 * Calls the Python ingestion service's real /ingest and /level endpoints
 * (Phase 1/4, already built and tested) directly over HTTP — plain
 * service-to-service calls, NOT the MCP protocol (which is reserved for
 * ADO writes via mcp-ado-server, see McpClient). CanonicalDoc/WorkItemTree
 * are passed through as loosely-typed JSON on the TS side — the
 * orchestrator's job here is orchestration, not re-validating Python's own
 * pydantic-enforced shapes.
 */
@Injectable()
export class IngestionHttpClient {
  private readonly longRunningAgent: Agent;

  constructor(
    private readonly baseUrl: string,
    requestTimeoutMs: number = DEFAULT_INGESTION_REQUEST_TIMEOUT_MS,
  ) {
    this.longRunningAgent = new Agent({ headersTimeout: requestTimeoutMs, bodyTimeout: requestTimeoutMs });
  }

  // skipVision: /jobs/preview's caller (jobs.controller.ts) only needs
  // blockCount/sectionCount/fileType -- never figure captions -- passes
  // true here so a previewed document's images don't pay the full
  // per-image vision-LLM cost (confirmed live: turned a ~30ms preview into
  // 28s for one small embedded image). Real job submission
  // (pipeline.worker.ts) omits this -- captions still matter there, and a
  // real document's images (each a sequential describe_figure LLM call,
  // same cold-start-latency profile as /level's calls) can comfortably
  // exceed undici's default 300s headersTimeout -- confirmed live: a real
  // 36-figure docx failed with HeadersTimeoutError at exactly 5:04 after
  // submit. Needs the SAME longRunningAgent dispatcher /level already
  // uses below, not the plain default-timeout fetch.
  // mode: threaded straight through to ingestion's /ingest so BASELINE jobs
  // never open the vision-LLM gate there (see main.py's ingest() docstring)
  // -- BASELINE is contractually verbatim/no-AI, and a figure caption is
  // model-authored text. Defaults to 'baseline', matching /ingest's own
  // default and every pre-mode-gate call site (preview never sets it,
  // matching its existing skipVision=true behavior either way).
  async ingest(
    fileBuffer: Buffer,
    filename: string,
    skipVision = false,
    mode: 'baseline' | 'survey' = 'baseline',
    // Optional -- present only for a real job submission (pipeline.worker.ts
    // passes job.id), absent for /jobs/preview's own call. Lets ingestion
    // publish real parse-stage narration (figure-by-figure vision progress,
    // parse summary) on the same job-events channel /level's SURVEY
    // narration already uses, instead of the parse stage being a total
    // black box for however long figure captioning takes.
    jobId?: string,
    // Whole-document AI context primer (now computed BEFORE /ingest, see
    // pipeline.worker.ts) -- threaded through so figure vision calls during
    // parsing can judge significance relative to the whole document, not
    // just in visual isolation. Optional/omitted for every call site
    // predating this field (e.g. /jobs/preview), matching jobId's own
    // backward-compat convention above.
    primerContext?: string,
    // Tesseract OCR language pack(s) for a scanned PDF's OCR fallback (e.g.
    // 'heb+eng') -- optional, appended last per this method's existing
    // backward-compat convention. Omitted (undefined) sends nothing, so
    // ingestion's own "eng" default governs, byte-identical to every call
    // site predating this param (deliberately NOT defaulted to 'eng' here
    // too, to keep "not sent at all" and "sent as eng" distinguishable if
    // that ever matters).
    languages?: string,
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
    if (languages) {
      params.set('languages', languages);
    }
    const url = `${this.baseUrl}/ingest?${params.toString()}`;
    const response = await fetch(url, { method: 'POST', body: form, dispatcher: this.longRunningAgent });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /ingest request failed: ${await _readErrorDetail(response)}`);
    }
    return (await response.json()) as CanonicalDoc;
  }

  async level(
    doc: CanonicalDoc,
    mode: 'baseline' | 'survey' = 'baseline',
    // Knowledge Base scope key -- the submitting user's stable ADO identity
    // (see Job.userId's own doc comment), NOT the job's ADO areaPath. Kept
    // as a distinct param/arg name from checkDuplicate/upsertDedupEntry*'s
    // areaPath below, which is a legitimate, unrelated ADO-scoped concern.
    userId?: string,
    linkTypeCatalog?: { referenceName: string; name: string; semanticHint?: string }[],
    model?: string,
    jobId?: string,
    // Whole-document AI context primer (Phase 6c, pipeline.worker.ts's own
    // primer wiring block) -- a short, model-authored orientation covering
    // document type/purpose/domain phrasing, computed once per job (ingestion
    // already accepts and forwards this to build_survey_tree, see main.py's
    // /level route). Optional/omitted for every call site predating this
    // field, matching model/jobId's own backward-compat convention above.
    primerContext?: string,
  ): Promise<WorkItemTree> {
    const params = new URLSearchParams({ mode });
    if (userId) params.set('user_id', userId);
    if (model) params.set('model', model);
    if (jobId) params.set('job_id', jobId);
    if (primerContext) params.set('primer_context', primerContext);
    if (linkTypeCatalog) {
      // ingestion (Python) expects snake_case keys (reference_name/name/
      // semantic_hint) -- AdoLinkType on this side is camelCase. Map at the
      // wire boundary rather than changing either side's native casing.
      params.set(
        'link_type_catalog',
        JSON.stringify(
          linkTypeCatalog.map((t) => ({
            reference_name: t.referenceName,
            name: t.name,
            semantic_hint: t.semanticHint ?? null,
          })),
        ),
      );
    }
    const response = await fetch(`${this.baseUrl}/level?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
      dispatcher: this.longRunningAgent,
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /level request failed: ${await _readErrorDetail(response)}`);
    }
    return (await response.json()) as WorkItemTree;
  }

  // CR-7d rescore: re-judges ONE already-formalized requirement's current
  // description after a manual/AI-chat edit, without re-running /level's
  // whole-document pipeline. `categoryChecklist`, when supplied (the
  // item's OWN previously-scored qualityCategoryScores keys), forces the
  // rescore to judge the SAME rubric as the original scoring pass -- see
  // ingestion's score_single_requirement_text docstring for the
  // determinism guarantee this provides.
  async scoreItem(
    description: string,
    categoryChecklist?: string[] | null,
    userId?: string | null,
    model?: string | null,
  ): Promise<{ qualityScore: number | null; qualityIssues: string[]; qualityCategoryScores: Record<string, number> | null }> {
    const response = await fetch(`${this.baseUrl}/score-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        category_checklist: categoryChecklist ?? null,
        user_id: userId ?? null,
        model: model ?? null,
      }),
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /score-item request failed: ${await _readErrorDetail(response)}`);
    }
    const body = (await response.json()) as {
      quality_score: number | null;
      quality_issues: string[];
      quality_category_scores: Record<string, number> | null;
    };
    return {
      qualityScore: body.quality_score,
      qualityIssues: body.quality_issues,
      qualityCategoryScores: body.quality_category_scores,
    };
  }

  // title: blended 50/50 with the description embedding on the ingestion
  // side -- description alone can't separate "same requirement, reworded"
  // from "different requirement, same topic" (confirmed real miss: a true
  // duplicate scored 0.755, its nearest false neighbor 0.747). See
  // check_for_duplicates.py's own docstring for the full rationale.
  // `threshold` is optional and Settings-window-driven (NEW-07) -- when
  // omitted, ingestion falls back to its own unchanged 0.90 default.
  async checkDuplicate(
    text: string,
    title: string,
    areaPath: string,
    threshold?: number,
  ): Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }> {
    const response = await fetch(`${this.baseUrl}/dedup/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title, area_path: areaPath, ...(threshold !== undefined ? { threshold } : {}) }),
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /dedup/check request failed: ${await _readErrorDetail(response)}`);
    }
    const body = (await response.json()) as { is_duplicate: boolean; matched_item_id: string | null; similarity: number | null };
    return { isDuplicate: body.is_duplicate, matchedItemId: body.matched_item_id, similarity: body.similarity };
  }

  async upsertDedupEntry(itemId: string, text: string, title: string, areaPath: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/dedup/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, text, title, area_path: areaPath }),
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /dedup/upsert request failed: ${await _readErrorDetail(response)}`);
    }
  }

  /**
   * Batches multiple items into a single /dedup/upsert-batch call -- one
   * embed() round-trip for all of them, instead of confirm()'s previous
   * per-node loop triggering one /dedup/upsert (and one embed() call) per
   * item. A no-op for an empty list (never makes the HTTP call at all).
   */
  async upsertDedupEntriesBatch(items: { itemId: string; text: string; title: string; areaPath: string }[]): Promise<void> {
    if (items.length === 0) return;
    const response = await fetch(`${this.baseUrl}/dedup/upsert-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items.map((item) => ({ item_id: item.itemId, text: item.text, title: item.title, area_path: item.areaPath })),
      }),
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /dedup/upsert-batch request failed: ${await _readErrorDetail(response)}`);
    }
  }

  /**
   * Counterpart to upsertDedupEntry -- removes a stale dedup_skip match's
   * Chroma entry once verifyExistingAdoIdsStillExist has downgraded it to
   * 'create' (its ADO work item no longer exists), so the same dead id
   * doesn't keep matching future jobs against this area path.
   */
  async deleteDedupEntry(itemId: string, areaPath: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/dedup/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, area_path: areaPath }),
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /dedup/delete request failed: ${await _readErrorDetail(response)}`);
    }
  }

  /**
   * Irreversibly drops a user's entire KB collection -- the admin/CLI
   * remediation (scripts/purge-user-data.ts) for a deleted-and-recreated
   * ADO account whose new session resolves to the same descriptor-derived
   * userId as the old one. Never called from any normal request path.
   */
  async purgeUserKb(userId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/kb/collection?user_id=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/collection delete request failed: ${await _readErrorDetail(response)}`);
    }
  }

  async ingestUrl(
    url: string,
    userId: string,
    docType: string | null,
    graphToken?: string | null,
    retrievalMode?: string | null,
  ): Promise<{
    documentName: string;
    driveitemId: string;
    mimeType: string | null;
    sizeBytes: number;
    chunksStored: number;
    skippedUnchanged: boolean;
  }> {
    const response = await fetch(`${this.baseUrl}/kb/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        user_id: userId,
        doc_type: docType,
        graph_token: graphToken ?? null,
        retrieval_mode: retrievalMode ?? null,
      }),
      dispatcher: this.longRunningAgent,
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/ingest-url request failed: ${await _readErrorDetail(response)}`);
    }
    const body = (await response.json()) as {
      document_name: string;
      driveitem_id: string;
      mime_type: string | null;
      size_bytes: number;
      chunks_stored: number;
      skipped_unchanged: boolean;
    };
    return {
      documentName: body.document_name,
      driveitemId: body.driveitem_id,
      mimeType: body.mime_type,
      sizeBytes: body.size_bytes,
      chunksStored: body.chunks_stored,
      skippedUnchanged: body.skipped_unchanged,
    };
  }

  async ingestFolderUrl(
    url: string,
    userId: string,
    docType: string | null,
    recursive = false,
    graphToken?: string | null,
  ): Promise<{ files: FolderIngestFile[] }> {
    const response = await fetch(`${this.baseUrl}/kb/ingest-folder-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, user_id: userId, doc_type: docType, recursive, graph_token: graphToken ?? null }),
      dispatcher: this.longRunningAgent,
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/ingest-folder-url request failed: ${await _readErrorDetail(response)}`);
    }
    const body = (await response.json()) as {
      files: {
        file: string;
        status: string;
        chunks_stored: number;
        driveitem_id: string | null;
        mime_type: string | null;
        size_bytes: number | null;
        reason: string | null;
        relative_path: string | null;
      }[];
    };
    return {
      files: body.files.map((f) => ({
        file: f.file,
        status: f.status,
        chunksStored: f.chunks_stored,
        driveitemId: f.driveitem_id,
        mimeType: f.mime_type,
        sizeBytes: f.size_bytes,
        reason: f.reason,
        relativePath: f.relative_path,
      })),
    };
  }

  // Ingests exactly one file already returned by browseFolder/browseChildren
  // (addressed by its Graph download URL, not a sharing link) -- backs the
  // tree view's per-row ingest action.
  async ingestItem(
    name: string,
    itemId: string,
    downloadUrl: string,
    userId: string,
    docType: string | null,
    graphToken?: string | null,
    retrievalMode?: string | null,
  ): Promise<{
    documentName: string;
    driveitemId: string;
    mimeType: string | null;
    sizeBytes: number;
    chunksStored: number;
    skippedUnchanged: boolean;
  }> {
    const response = await fetch(`${this.baseUrl}/kb/ingest-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        item_id: itemId,
        download_url: downloadUrl,
        user_id: userId,
        doc_type: docType,
        graph_token: graphToken ?? null,
        retrieval_mode: retrievalMode ?? null,
      }),
      dispatcher: this.longRunningAgent,
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/ingest-item request failed: ${await _readErrorDetail(response)}`);
    }
    const body = (await response.json()) as {
      document_name: string;
      driveitem_id: string;
      mime_type: string | null;
      size_bytes: number;
      chunks_stored: number;
      skipped_unchanged: boolean;
    };
    return {
      documentName: body.document_name,
      driveitemId: body.driveitem_id,
      mimeType: body.mime_type,
      sizeBytes: body.size_bytes,
      chunksStored: body.chunks_stored,
      skippedUnchanged: body.skipped_unchanged,
    };
  }

  async deleteDocument(userId: string, sourceFile: string, sourceId: string): Promise<void> {
    const params = new URLSearchParams({ user_id: userId, source_file: sourceFile, source_id: sourceId });
    const response = await fetch(`${this.baseUrl}/kb/documents?${params.toString()}`, { method: 'DELETE' });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion DELETE /kb/documents request failed: ${await _readErrorDetail(response)}`);
    }
  }

  async browseFolder(url: string, graphToken?: string | null): Promise<FolderChild[]> {
    const response = await fetch(`${this.baseUrl}/kb/browse-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, graph_token: graphToken ?? null }),
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/browse-folder request failed: ${await _readErrorDetail(response)}`);
    }
    return mapFolderChildren(
      (await response.json()) as { id: string; name: string; mime_type: string | null; size_bytes: number; is_folder: boolean; drive_id: string | null; download_url: string | null }[],
    );
  }

  async browseChildren(driveId: string, itemId: string, graphToken?: string | null): Promise<FolderChild[]> {
    const response = await fetch(`${this.baseUrl}/kb/browse-children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drive_id: driveId, item_id: itemId, graph_token: graphToken ?? null }),
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/browse-children request failed: ${await _readErrorDetail(response)}`);
    }
    return mapFolderChildren(
      (await response.json()) as { id: string; name: string; mime_type: string | null; size_bytes: number; is_folder: boolean; drive_id: string | null; download_url: string | null }[],
    );
  }

  // Raw model-response captures behind any soft-failure warning this job's
  // SURVEY run produced (see app.debug_capture) -- surfaced to the caller
  // (jobs.controller.ts's GET /jobs/:id/debug) so a reviewer can see what
  // the model actually said without re-running the job. Empty array is the
  // common case (no soft failures occurred).
  async getDebugCaptures(jobId: string): Promise<{ kind: string; identifier: string; content: string }[]> {
    const response = await fetch(`${this.baseUrl}/debug/${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /debug request failed: ${await _readErrorDetail(response)}`);
    }
    return (await response.json()) as { kind: string; identifier: string; content: string }[];
  }

  async getSharePointStatus(graphToken?: string | null): Promise<SharePointStatus> {
    const response = await fetch(`${this.baseUrl}/kb/sharepoint/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph_token: graphToken ?? null }),
    });
    if (!response.ok) {
      throw new IngestionHttpError(response.status, `Ingestion /kb/sharepoint/status request failed: ${await _readErrorDetail(response)}`);
    }
    const body = (await response.json()) as { status: SharePointStatus['status']; expires_in_seconds: number | null };
    return { status: body.status, expiresInSeconds: body.expires_in_seconds };
  }
}

export interface SharePointStatus {
  status: 'not_configured' | 'valid' | 'invalid' | 'unreachable';
  expiresInSeconds: number | null;
}

export interface FolderChild {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  isFolder: boolean;
  driveId: string | null;
  // Files only -- Graph's pre-signed download URL, needed to ingest this
  // exact item via /kb/ingest-item without its own sharing link.
  downloadUrl: string | null;
}

function mapFolderChildren(
  body: {
    id: string;
    name: string;
    mime_type: string | null;
    size_bytes: number;
    is_folder: boolean;
    drive_id: string | null;
    download_url: string | null;
  }[],
): FolderChild[] {
  return body.map((item) => ({
    id: item.id,
    name: item.name,
    mimeType: item.mime_type,
    sizeBytes: item.size_bytes,
    isFolder: item.is_folder,
    driveId: item.drive_id,
    downloadUrl: item.download_url,
  }));
}
