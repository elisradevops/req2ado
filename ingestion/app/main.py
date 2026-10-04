# ingestion/app/main.py
import hashlib
import json
import logging
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal, NamedTuple, cast

import redis
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.canonical.model import CanonicalDoc
from app.chat.chat_client import ChatLlmClient
from app.chat.chat_service import run_chat_turn
from app.chat.redis_publisher import RedisChatPublisher
from app.config import settings
from app.debug_capture import DebugCapture
from app.dedup.check_for_duplicates import DuplicateCheckResult, check_for_duplicates
from app.dedup.embedding_blend import blend_embeddings
from app.dedup.orchestrator_embed_client import OrchestratorEmbedClient
from app.dedup.vector_store import ChromaVectorStore
from app.dispatch import dispatch_by_extension
from app.kb.browse_service import FolderChildSummary, browse_shared_folder, browse_subfolder
from app.kb.graph_client import GraphApiError, GraphClient, decode_jwt_expiry_seconds
from app.kb.ingest_service import FolderIngestResult, IngestResult, ingest_document_from_url, ingest_folder_child, ingest_folder_from_url
from app.kb.kb_vector_store import KbVectorStore
from app.kb.retrieval import retrieve_context
from app.leveling.id_hierarchy import rows_from_table
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.id_tree_builder import _TITLE_TAG_CHUNK_SIZE, synthesis_updates, title_tag_updates
from app.leveling.model_caps import _resolve_caps
from app.leveling.narration_publisher import LevelingProgress, NarrationPublisher, last_known_phase
from app.leveling.scoring import score_single_requirement_text
from app.leveling.tree_builder import build_baseline_tree, figure_id_by_block_id
from app.loaders.docx_pagination import annotate_docx_pages
from app.logging_context import JobIdLogFilter, job_id_scope
from app.quality.criteria_retrieval import CriteriaRetriever
from app.redaction.redactor import redact_canonical_doc
from app.survey.llm_cache import LlmResponseCache
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.vision.emf_converter import convert_vector_image_to_png, sniff_vector_image_extension
from app.vision.orchestrator_vision_client import PROMPT_VERSION, OrchestratorVisionClient, _strip_degenerate_continuation
from app.vision.figure_storage_client import OrchestratorFigureFileClient, compress_figure_for_storage
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemTree, WorkItemType

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s [job_id=%(job_id)s] %(name)s: %(message)s",
)
# Filter attached to the root logger's HANDLER, not the root logger itself --
# a Logger's own .addFilter() only runs for records IT originates; records
# from child loggers (app.leveling.llm_leveling, etc.) reach the root
# logger's handlers directly via propagation, bypassing the root Logger's
# own filter() call. Handler-level filters run for every record the handler
# processes regardless of which logger it came from. JobIdLogFilter reads
# the current job_id from app.logging_context's contextvar (set via
# job_id_scope() around _build_survey_tree_with_scoring below), falling
# back to "-" for anything logged outside a job's scope.
for _handler in logging.getLogger().handlers:
    _handler.addFilter(JobIdLogFilter())

logger = logging.getLogger(__name__)

app = FastAPI(title="req2ado-ingestion")

from app.otel import setup_otel  # noqa: E402 -- must instrument after `app` exists, before it serves

setup_otel(app)


# Stamps each request's start time so the exception handler below can report
# how long a job had actually been running when it failed (elapsed_seconds
# on the job_failed narration event) -- request.state is the standard
# per-request scratch space for exactly this kind of cross-cutting timing,
# not persisted or used anywhere else.
@app.middleware("http")
async def _stamp_request_start_time(request: Request, call_next):
    request.state.start_time = time.monotonic()
    return await call_next(request)


# Confirmed real UX gap (user-reported): with no handler registered here,
# Starlette's own default (debug=False, uvicorn's default) swallows any
# unhandled exception into a bare '{"detail": "Internal Server Error"}' --
# every real root cause (a malformed-JSON LLM response, a downstream ADO/KB
# error, anything else /level or any other route can raise) was silently
# discarded before the orchestrator's ingestion-http.client.ts even saw it,
# so a failed job's audit trail only ever showed "Ingestion /level request
# failed: 500" -- accurate but useless for a reviewer trying to understand
# what actually went wrong. These two handlers make the real exception
# message reach the response body (and, via ingestion-http.client.ts's own
# fix, the job's audit entry) for every route, present and future, without
# having to wrap each one individually.
#
# ValueError specifically means "an upstream dependency (the LLM) produced
# something this service couldn't use" everywhere it's raised in this
# codebase (see orchestrator_llm_client.py's _parse_json_object) -- a
# genuine upstream-failure signal, so 502 Bad Gateway is the semantically
# correct status; anything else is a real internal bug, reported as 500.
# Real gap this closes (confirmed live: a real job's httpx.ReadTimeout
# during quality scoring): the response body above already carries the
# real exception message, but that only ever reaches a flattened one-line
# AuditEntry ("Pipeline failed: Ingestion /level request failed: timed
# out") -- no phase, no elapsed time, no real exception TYPE. Publishing a
# job_failed narration event here (same publish()/Redis/JobEvent-
# persistence path every other phase already uses) durably captures that
# structured context for free, keyed off whatever job_id this request
# carries (both /level and /ingest take it as a query param -- any other
# route simply has no job_id to report against, a no-op).
def _publish_job_failed(request: Request, exc: Exception) -> None:
    job_id = request.query_params.get("job_id")
    if not job_id:
        return
    start_time = getattr(request.state, "start_time", None)
    elapsed_seconds = time.monotonic() - start_time if start_time is not None else None
    try:
        NarrationPublisher(_narration_redis, job_id).publish(
            LevelingProgress(
                phase="job_failed",
                branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                kb_grounded=False, kb_citations=[],
                error_type=type(exc).__name__, error_message=str(exc),
                elapsed_seconds=elapsed_seconds, last_phase=last_known_phase(job_id),
            )
        )
    except Exception:  # noqa: BLE001 - this enrichment must never mask the real error response
        logger.exception("Failed to publish job_failed narration for job %s", job_id)


@app.exception_handler(ValueError)
async def _value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    # request.url (not request.url.path) -- /level's job_id arrives as a
    # query param, which .path silently drops from this log line.
    logger.exception("Unhandled ValueError in %s", request.url)
    _publish_job_failed(request, exc)
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception in %s", request.url)
    _publish_job_failed(request, exc)
    return JSONResponse(status_code=500, content={"detail": str(exc)})

# settings.chroma_mode="embedded" (default, unset = same behavior as
# before this option existed) means a local PersistentClient -- does NOT
# survive horizontal scaling, each ingestion instance gets an independent,
# incomplete corpus copy. Set chroma_mode="http" (+ chroma_host/chroma_port)
# to connect to a real, shared Chroma server instead, making ingestion
# genuinely stateless and safe to run as multiple replicas. Same reasoning
# applies to _kb_vector_store below (KB corpus, not dedup corpus).
_embed_client = OrchestratorEmbedClient(settings.orchestrator_url, settings.llm_proxy_bearer)
_vector_store = ChromaVectorStore(
    settings.chroma_persist_path,
    mode=settings.chroma_mode,
    host=settings.chroma_host,
    port=settings.chroma_port,
)
_kb_vector_store = KbVectorStore(
    settings.chroma_persist_path,
    mode=settings.chroma_mode,
    host=settings.chroma_host,
    port=settings.chroma_port,
)
# Gemma4 repetition-collapse mitigation (confirmed upstream bug,
# ollama/ollama#15502) -- these are the Gemma4 team's own release-note-
# recommended sampler settings, confirmed in ollama/ollama#15502 to reduce
# degenerate token-repetition on long generations. Applied unconditionally
# to every SURVEY analysis call (see OrchestratorLlmClient's top_k/min_p
# forwarding) -- harmless for any other model/backend that ignores the
# passthrough options field (see LlmChatOptions.topK/minP's own docstring).
_SURVEY_TOP_K = 50
_SURVEY_MIN_P = 0.05

# Module-level singleton, same convention as _embed_client/_vector_store
# above -- no per-job model override needed, /dedup/check has no model
# context of its own (it's called once per diff-tree node, independent of
# any job's own SURVEY model choice). Backs check_for_duplicates.py's
# optional LLM verification pass (DuplicateJudgeClient).
_dedup_judge_client = OrchestratorLlmClient(
    settings.orchestrator_url, settings.llm_proxy_bearer, top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P
)
# None (default: llm_vision_model unset) means figure extraction stays a
# placeholder -- identical behavior to before vision support existed.
_vision_client = (
    OrchestratorVisionClient(settings.orchestrator_url, settings.llm_proxy_bearer)
    if settings.llm_vision_model
    else None
)
# Same bearer/base_url, same "None means feature off" convention as
# _vision_client -- storing figure bytes for later ADO attachment only ever
# makes sense alongside real vision-based figure description in the first
# place (see _describe_figure_with_progress).
_figure_file_client = (
    OrchestratorFigureFileClient(settings.orchestrator_url, settings.llm_proxy_bearer)
    if settings.llm_vision_model
    else None
)
# KB quality-checklist extraction (runs ONCE per document, at ingest time --
# see OrchestratorLlmClient.extract_quality_checklist's own docstring for
# the cross-run scoring-determinism problem this fixes). Same always-on
# convention as _embed_client -- no separate opt-in flag, since this is a
# best-effort enhancement (failures are caught and logged, never fail the
# ingest, see ingest_service._store_document) rather than a capability gate
# like vision.
_checklist_client = OrchestratorLlmClient(
    settings.orchestrator_url, settings.llm_proxy_bearer, top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P
)
# Module-level singleton, mirroring _embed_client/_kb_vector_store above:
# RedisChatPublisher.__init__ opens a redis.asyncio connection pool via
# from_url() that is never explicitly closed. Constructing one per request
# (as /chat/{job_id}/{local_id}/turn used to) leaked a pool on every chat
# turn, risking FD/Redis maxclients exhaustion on a long-running process.
_chat_redis_publisher = RedisChatPublisher(settings.redis_url)
# Separate SYNCHRONOUS redis client (not redis.asyncio like the chat
# publisher above) -- build_survey_tree's progress_callback fires from
# inside run_in_threadpool, i.e. on a worker THREAD, not the event loop,
# where an async client can't be awaited without loop gymnastics a plain
# sync call sidesteps. See NarrationPublisher's own docstring.
_narration_redis = redis.Redis.from_url(settings.redis_url)
# Same synchronous client, same threadpool-friendliness reasoning as above --
# DebugCapture.capture() is called from inside soft-failure warning paths
# that run on the same worker thread build_survey_tree itself runs on.
_debug_capture = DebugCapture(_narration_redis)
# S11: caches OrchestratorLlmClient's analyze_section/score_requirements_for_
# document/score_epics_and_features_for_document calls -- same shared sync
# client as above (fail-open on any Redis error, see LlmResponseCache's own
# docstring), not a separate connection.
_llm_response_cache = LlmResponseCache(_narration_redis)


def _sniff_image_mime_type(image_bytes: bytes) -> str | None:
    """Magic-byte sniff, not a filename/extension guess -- every
    describe_figure caller only ever has raw bytes (a docx/pptx-embedded
    image, or a standalone image file already opened into memory). Returns
    None for a non-raster format this function doesn't handle (e.g. a
    docx-embedded EMF/WMF vector graphic) -- _describe_figure now attempts a
    real conversion for that case (see emf_converter.py) before falling back
    to the orchestrator's pre-existing image/png default."""
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if image_bytes.startswith(b"BM"):
        return "image/bmp"
    if image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        return "image/webp"
    if image_bytes.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    return None


# A week is long enough to cover repeated re-ingestion of the same document
# during review iteration (a real, common flow -- re-run SURVEY after
# tweaking KB documents or destination), short enough that a genuine
# vision-model swap self-heals within a week rather than serving stale
# captions forever.
_FIGURE_CAPTION_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7


def _figure_caption_cache_key(original_image_bytes: bytes, document_context: str | None) -> str:
    # Keyed on the ORIGINAL bytes handed to _describe_figure, before any
    # EMF/WMF->PNG conversion below -- two callers with byte-identical
    # source images must hit the same cache entry regardless of which
    # conversion path either happened to take. document_context is now part
    # of the key -- see _describe_figure's own comment for why the same
    # image across two different documents can legitimately produce two
    # different significance verdicts once document context is a real
    # input to that judgment. PROMPT_VERSION is also part of the key --
    # see its own docstring in orchestrator_vision_client.py: without this,
    # a prompt wording change (which has happened twice in one real
    # debugging session already) would silently keep serving captions
    # generated under the OLD wording for up to the full 1-week TTL.
    context_hash = hashlib.sha256((document_context or "").encode("utf-8")).hexdigest()[:16]
    return f"figcap:{PROMPT_VERSION}:{hashlib.sha256(original_image_bytes).hexdigest()}:{context_hash}"


def _rasterize_for_vision(image_bytes: bytes) -> tuple[bytes, str | None]:
    """Sniffs `image_bytes` and, for a non-raster vector format (most
    commonly a docx/pptx-embedded EMF/WMF metafile), converts it to PNG --
    shared by _describe_figure (vision captioning) AND
    _describe_figure_with_progress's figure-storage call (compress_figure_
    for_storage) below, which previously called Pillow directly on the
    ORIGINAL bytes and silently failed for every vector figure (Pillow has
    no EMF/WMF support -- confirmed real gap: a figure could be captioned
    successfully via this exact conversion yet never become attachable/
    viewable in the review UI, since only the caption path used it). Returns
    the original bytes and a None mime type unchanged when the format is
    already raster or the vector conversion itself fails -- callers must
    treat a None mime type as "use your own format detection/fallback",
    not as an error."""
    mime_type = _sniff_image_mime_type(image_bytes)
    if mime_type is not None:
        return image_bytes, mime_type
    vector_extension = sniff_vector_image_extension(image_bytes)
    if vector_extension is not None:
        converted = convert_vector_image_to_png(image_bytes, vector_extension)
        if converted is not None:
            return converted, "image/png"
    return image_bytes, None


def _describe_figure(
    image_bytes: bytes,
    document_context: str | None = None,
    # Optional out-param: a single-entry dict this function sets
    # caption_status_out["status"] on to "insignificant" or "vision_failed"
    # -- the 2 of its 3 internal outcomes (see this function's own return
    # points below) that collapse to caption=None, so a caller that needs to
    # know WHY (main.py's _describe_figure_with_progress, for
    # Figure.caption_status) can tell them apart without this function's
    # return type changing. Left unset (never a required 3rd positional arg)
    # so every existing 1-arg caller -- every loader passing this function
    # itself as its describe_figure callback (docx_loader.py etc., and the
    # 3 KB-ingestion routes below) -- stays byte-identical.
    #
    # Task 7 reuses this SAME dict for a second, independent key --
    # caption_status_out["title"] -- rather than adding a new parameter:
    # the vision model's short-title fallback for Figure.name, set only
    # when the figure is significant AND the model actually produced one.
    # Callers that don't care about it (every 1-arg caller above) simply
    # never read that key; this function never requires it to be present.
    #
    # Also carries "rasterized_bytes" (bytes, not str -- see this dict's
    # widened type) on a cache MISS only: the same rasterized bytes this
    # function computes below for the vision call itself, so a caller that
    # ALSO needs rasterized bytes afterward (main.py's figure-file storage
    # path) can reuse them instead of paying for a second, redundant
    # rasterization of the same image. Absent on a cache HIT (rasterization
    # never ran) -- that caller must still rasterize its own copy then.
    caption_status_out: dict[str, str | bytes] | None = None,
    user_id: str | None = None,
) -> str | None:
    # SCOPE NOTE (KB ingestion): this function is shared by SURVEY-mode
    # /ingest AND the three KB-ingestion routes below (/kb/ingest-url,
    # /kb/ingest-folder-url, /kb/ingest-item), so KB-indexed documents' figures
    # ALSO go through the vision significance filter -- with
    # document_context=None there, since KB ingestion has no whole-document AI
    # primer. Consequence, stated plainly: a figure the vision model judges
    # insignificant (decorative logo, placeholder block) gets caption=None and
    # is therefore NOT part of the indexed text, so it will not be retrievable
    # via KB search. This is an accepted side effect of routing every
    # describe_figure caller through one significance-aware implementation, not
    # an original requirement of the content-significance-filtering plan (whose
    # Global Constraints scoped both mechanisms to SURVEY mode) -- documented
    # rather than bypassed because a per-caller bypass flag is a larger,
    # separately-reviewable change.
    #
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
                if not cached_obj["significant"] and caption_status_out is not None:
                    caption_status_out["status"] = "insignificant"
                if not cached_obj["significant"]:
                    return None
                # Applied on read, not just at write time -- see
                # _strip_degenerate_continuation's own docstring for the
                # real bug this closes. A cache entry written by an
                # OLDER version of this same PROMPT_VERSION's parsing
                # logic (this repetition-strip fix landed after the
                # prompt/schema text it's keyed on last changed, so the
                # cache key alone would NOT have invalidated an already-
                # garbled entry) must still self-heal on the very next
                # read, not silently keep serving broken text for the
                # rest of its TTL.
                # Task 7: `.get`, not `["title"]` -- a cache entry written
                # before this field existed simply has no key, not a
                # malformed one; must not raise/miss the cache over it.
                if caption_status_out is not None and cached_obj.get("title"):
                    caption_status_out["title"] = cached_obj["title"]
                return _strip_degenerate_continuation(cached_obj["description"])
            except (json.JSONDecodeError, KeyError, UnicodeDecodeError):
                pass  # Treat an unparseable cache entry as a miss -- fall through to a live vision call.
    except Exception:
        logger.warning("Figure-caption cache read failed -- falling through to a live vision call", exc_info=True)

    describe_bytes, mime_type = _rasterize_for_vision(image_bytes)
    if caption_status_out is not None:
        caption_status_out["rasterized_bytes"] = describe_bytes
    result = _vision_client.describe_figure(describe_bytes, mime_type, document_context, user_id=user_id)
    if result is None:
        # The vision client's single "ambiguous result" outcome: a totally
        # unparseable response OR a well-formed significant=True whose
        # description came back blank (see _parse_figure_response's own
        # comment -- the blank-caption cache-poisoning case a confirmed live
        # incident produced is folded into this same None so there is exactly
        # ONE place the "don't memorize a glitch for a week" rule lives).
        # Not cached; self-heals on the next call/run instead of being locked
        # in. A genuine significant=False verdict is NOT ambiguous and falls
        # through to the cache write below.
        if caption_status_out is not None:
            caption_status_out["status"] = "vision_failed"
        return None
    try:
        _narration_redis.set(
            cache_key,
            json.dumps({"significant": result.significant, "description": result.description, "title": result.title}),
            ex=_FIGURE_CAPTION_CACHE_TTL_SECONDS,
        )
    except Exception:
        logger.warning("Figure-caption cache write failed -- caption still returned, just not cached", exc_info=True)
    if not result.significant and caption_status_out is not None:
        caption_status_out["status"] = "insignificant"
    # Task 7: only for a significant figure -- an insignificant one gets no
    # caption AND no fallback name from either source, same as before.
    if result.significant and result.title and caption_status_out is not None:
        caption_status_out["title"] = result.title
    return result.description if result.significant else None


class FigureCaptionOutcome(NamedTuple):
    """One figure's complete captioning result, as plain data returned to
    the calling thread.

    Everything /ingest needs to reassign onto the already-parsed
    CanonicalDoc, and nothing else -- so this work unit can run on a worker
    thread (see the post-parse captioning pass below) while every mutation,
    every narration publish, and every append to failed_figure_ids happens
    on the calling thread in figure-id order.

    `status` mirrors _describe_figure's caption_status_out["status"]
    ("insignificant" | "vision_failed" | None) and `title` its ["title"] --
    see Figure.caption_status' own docstring for what each means.
    `storage_failed` is the figure-file storage best-effort outcome; the
    caller folds it into CanonicalDoc.failed_figure_storage_ids, whose ORDER
    is user-visible (the orchestrator turns the list into a WarningRecord)."""

    figure_id: str
    caption: str | None
    status: str | None
    title: str | None
    storage_failed: bool


def _caption_and_store_one_figure(
    figure_id: str,
    image_bytes: bytes,
    document_context: str | None,
    job_id: str | None,
    user_id: str | None = None,
) -> FigureCaptionOutcome:
    """One figure's vision caption AND its figure-file storage, deliberately
    in ONE function.

    Splitting these two apart would reintroduce the "figure bytes rasterized
    twice per figure" bug a prior sweep item already closed: _describe_figure
    publishes the bytes it rasterized for the vision call out through
    caption_status_out["rasterized_bytes"] (on a cache MISS only), and the
    storage call below reads them back instead of paying for a second,
    redundant rasterization of the same image. That side channel lives for
    exactly one invocation of this function, so captioning and storage must
    stay co-located -- storage on the other side of a thread or phase
    boundary would have nothing to read and would silently rasterize again.

    Contains NO narration and NO shared-state mutation, which is what makes
    it safe to run on a worker thread: it returns everything the caller
    needs as plain data instead."""
    caption_status_out: dict[str, str | bytes] = {}
    # Fail-soft per figure, and NOT optional: before captioning moved out of
    # the parse walk, every loader wrapped its own describe_figure call in
    # exactly this try/except ("a vision failure must not abort the whole
    # document" -- see docx_loader._describe_rel and its three siblings), so a
    # 5xx/timeout/malformed response from the vision service left ONE figure
    # uncaptioned and the document still ingested. This function now runs
    # OUTSIDE those loaders, so without this the same exception escapes the
    # worker, propagates out of future.result()/the dispatch loop, and 500s
    # the entire /ingest request. Storage is deliberately skipped in this
    # branch too -- the pre-move code path piggybacked storage on the very
    # same call the loader's except swallowed, so a failed caption never
    # attempted a store either.
    try:
        caption = _describe_figure(image_bytes, document_context, caption_status_out, user_id=user_id)
    except Exception:  # noqa: BLE001 -- one figure's vision failure must not abort the whole document
        logger.warning("Vision captioning failed for %s -- figure left uncaptioned", figure_id, exc_info=True)
        return FigureCaptionOutcome(
            figure_id=figure_id, caption=None, status="vision_failed", title=None, storage_failed=False,
        )
    status = cast(str, caption_status_out["status"]) if "status" in caption_status_out else None
    title = cast(str, caption_status_out["title"]) if "title" in caption_status_out else None

    # Captured for every figure regardless of relevance -- figure_ids
    # relevance isn't known until /level runs (see llm_leveling.py's
    # analyze_section), so everything is stored now and pruned down later
    # (pipeline.worker.ts, once the real WorkItemTree exists). Best-effort:
    # any failure here (network, oversized bytes compress_figure_for_storage
    # can't open even after rasterization) must never fail the captioning it
    # is piggybacking on -- a figure that doesn't get stored simply won't be
    # attachable/viewable later. Uses the SAME rasterized bytes
    # _describe_figure (above) used for captioning -- not the original
    # `image_bytes` -- confirmed real gap: an EMF/WMF figure captioned fine
    # here but compress_figure_for_storage (Pillow-only, no EMF/WMF support)
    # silently failed on the un-converted original bytes, so a real,
    # successfully-described figure was never storable.
    # `caption_status_out["rasterized_bytes"]` carries those SAME bytes out
    # when _describe_figure actually rasterized (a cache miss) -- reused here
    # instead of a second, redundant rasterization of the same image. Absent
    # on a cache hit (rasterization never ran that time), so this still falls
    # back to rasterizing its own copy in that case.
    storage_failed = False
    if job_id is not None and _figure_file_client is not None:
        try:
            cached_rasterized = caption_status_out.get("rasterized_bytes")
            if isinstance(cached_rasterized, bytes):
                rasterized_bytes = cached_rasterized
            else:
                rasterized_bytes, _ = _rasterize_for_vision(image_bytes)
            compressed = compress_figure_for_storage(rasterized_bytes)
            if compressed is not None:
                _figure_file_client.store(job_id, figure_id, compressed[0], compressed[1])
        except Exception:
            logger.warning(
                "Figure-file storage failed for %s -- it will not be attachable in ADO", figure_id, exc_info=True
            )
            storage_failed = True
    return FigureCaptionOutcome(
        figure_id=figure_id, caption=caption, status=status, title=title, storage_failed=storage_failed,
    )


def _reassign_figure_captions(doc: CanonicalDoc, outcomes: list[FigureCaptionOutcome]) -> None:
    """Writes each figure's post-parse caption back onto the already-built
    tree, by figure id. The ONE place the tree is mutated by the captioning
    pass -- always on the calling thread, always in figure-id order.

    Two fields, not one, and the second is the load-bearing one:

    - Figure.caption, the vision model's own prose.
    - The PAIRED inline FIGURE-kind Block's text. tree_builder._figure_line
      parses the caption back OUT of block.text ("[FIGURE: {caption or
      'none'}]"), and BOTH /level paths use that -- not Figure.caption -- to
      decide figure_ids vs uncaptioned_figure_ids (tree_builder.py's three
      node-building paths and llm_leveling.py's span-fold attribution). A
      reassignment that set Figure.caption alone would leave every captioned
      figure classified as uncaptioned and drop every caption out of every
      rendered section.

    Blocks are paired to figures POSITIONALLY -- the i-th FIGURE-kind block
    is doc.figures[i] -- by inverting tree_builder.figure_id_by_block_id,
    the codebase's own shared pairing helper. Deliberately NOT by
    source_ref: that helper's own docstring records why ("source_ref alone
    is ambiguous for docx's own floating-image fallback path, which can give
    several figures the identical (0, 0) placeholder ref").

    The block-text write is CONDITIONAL on a real caption existing, which is
    what preserves docx's Caption-paragraph behavior unchanged. That branch
    (docx_loader.py) reads `figures[-1].caption is None` DURING parsing to
    decide whether the author's own caption paragraph becomes the rendered
    text -- and under deferred captioning that is always None, so it always
    fires and always writes "[FIGURE: {author caption}]". Overwriting here
    only when vision produced real prose lands on exactly the same final
    string as the old inline order did in both cases: vision prose wins when
    it exists, the author's caption remains the fallback when it doesn't,
    and "[FIGURE: none]" remains the fallback when neither exists."""
    block_id_by_figure_id = {
        figure_id: block_id for block_id, figure_id in figure_id_by_block_id(doc).items()
    }
    blocks_by_id = {block.id: block for block in doc.blocks}
    figures_by_figure_id = {figure.id: figure for figure in doc.figures}
    for outcome in outcomes:
        figure = figures_by_figure_id.get(outcome.figure_id)
        if figure is None:
            # Defensive only -- the lockstep-append invariant makes this
            # unreachable. Never silently drop a caption without a trace.
            logger.warning(
                "Captioned figure %s has no matching Figure in the parsed document -- caption discarded",
                outcome.figure_id,
            )
            continue
        if outcome.caption is None:
            continue
        figure.caption = outcome.caption
        block_id = block_id_by_figure_id.get(outcome.figure_id)
        block = blocks_by_id.get(block_id) if block_id is not None else None
        if block is not None:
            block.text = f"[FIGURE: {outcome.caption}]"


# Lazily constructed (NOT at import time, unlike _vector_store above) --
# CriteriaRetriever's constructor makes a real embed() HTTP call to embed
# the corpus, and eagerly doing that at module-import time would make every
# test that imports `app.main` (most of the ingestion test suite) depend on
# a live embed proxy. Built on first actual SURVEY-mode-with-scoring request
# instead, and cached from then on (the corpus is static, no need to
# re-embed it every request). A failure to build it (embed proxy down,
# network error) degrades to ungrounded scoring (criteria_retriever=None)
# rather than failing the whole SURVEY job -- same "fail open" philosophy
# as the dedup check in dry-run.service.ts.
# Keyed by user_id (None included -- a caller with no identity still gets
# its own cache slot) rather than a single global instance: the orchestrator
# now requires X-Req2Ado-User-Id on every /llm/embed call with no shared/
# global fallback credential, so the one-time corpus embed a CriteriaRetriever
# does at construction must run under a REAL user's own Open WebUI
# connection, not a "whichever request happens to build it first" identity.
# Each user's own retriever is still built and cached exactly once (the
# corpus is static, tiny, and cheap to re-embed once per user) -- the
# resolve-once-per-key pattern OpenWebUiClientFactory already uses for the
# same reason.
_criteria_retrievers: dict[str | None, CriteriaRetriever | None] = {}
_criteria_retrievers_build_attempted: set[str | None] = set()


def _get_criteria_retriever(user_id: str | None) -> CriteriaRetriever | None:
    if user_id in _criteria_retrievers_build_attempted:
        return _criteria_retrievers[user_id]
    _criteria_retrievers_build_attempted.add(user_id)
    try:
        _criteria_retrievers[user_id] = CriteriaRetriever(_embed_client, user_id=user_id)
    except Exception:
        logger.warning("Failed to build CriteriaRetriever for user_id=%s -- SURVEY quality scoring will run ungrounded", user_id, exc_info=True)
        _criteria_retrievers[user_id] = None
    return _criteria_retrievers[user_id]


def _build_survey_tree_with_scoring(
    doc: CanonicalDoc,
    client: OrchestratorLlmClient,
    user_id: str | None,
    link_type_catalog: list[dict] | None,
    job_id: str | None,
    model: str | None = None,
    primer_context: str | None = None,
) -> WorkItemTree:
    """Wraps build_survey_tree so BOTH the (possibly network-calling)
    CriteriaRetriever construction above AND the tree-building itself run
    inside run_in_threadpool -- constructing the retriever inline in the
    async /level route (before dispatching to the threadpool) would block
    the event loop for its httpx call, the exact problem run_in_threadpool
    below is already there to avoid for build_survey_tree itself.

    user_id is optional: when the caller omits it (no KB scope known yet),
    build_survey_tree skips KB retrieval entirely and behaves exactly as it
    did before KB retrieval existed. The Knowledge Base is scoped by this
    submitting user's identity, NOT any ADO area path (see
    KbVectorStore's own docstring) -- a job's ADO destination is unrelated
    to which KB documents its owner has ingested. link_type_client is only
    wired up when a catalog was actually supplied -- passing it
    unconditionally would make every survey call (including every
    pre-existing caller that omits this param) issue an extra
    infer_trace_links call, changing behavior for callers this must leave
    untouched. An empty catalog is treated the same as no catalog at all --
    infer_trace_links has nothing to validate against, so skipping it
    matches pipeline.worker.ts's documented degraded-mode contract (empty
    catalog -> empty trace_links, never blocking the rest of the job).

    job_id is optional: when the caller omits it (no job context, e.g. a
    direct test/curl call), no narration is published -- build_survey_tree
    behaves exactly as it did before narration existed. job_id_scope is
    entered here (this is where job_id is first available on the thread that
    actually does the work, since this function runs inside
    run_in_threadpool) so every logger.warning/exception below it in the
    call stack picks up job_id correlation automatically, with no
    parameter threading through llm_leveling.py's internals."""
    progress_callback = None
    if job_id is not None:
        progress_callback = NarrationPublisher(_narration_redis, job_id).publish
    with job_id_scope(job_id):
        return build_survey_tree(
            doc,
            analysis_client=client,
            scoring_client=client,
            criteria_retriever=_get_criteria_retriever(user_id),
            user_id=user_id,
            embed_client=_embed_client,
            vector_store=_kb_vector_store,
            link_type_client=client if link_type_catalog else None,
            link_type_catalog=link_type_catalog,
            # Same client, same "only wired when actually usable" convention as
            # link_type_client above -- verification is meaningless without KB
            # retrieval itself being enabled (user_id set), and only applies to
            # the non-tool-capable fallback path in the first place (§5c).
            kb_relevance_client=client if user_id else None,
            progress_callback=progress_callback,
            model=model,
            debug_capture=_debug_capture,
            # Confirmed real gap: this was never passed at all, so every
            # deterministically-built node kept its raw
            # extract_baseline_title-derived title (e.g. "The P." from "The
            # P. S shall include electronic fuses...") and empty tags in
            # production, even though title_and_tags_for_rows/
            # _apply_title_tag_pass were both fully built and tested. Same
            # client as everything else above -- OrchestratorLlmClient
            # implements the TitleTagClient protocol directly.
            title_tag_client=client,
            # Same client, implements SynthesisClient directly -- the actual
            # quality fix for deterministic leaves flagged needs_synthesis
            # (see id_hierarchy.HierarchyRow's own docstring): a fragment or
            # spec-table cell gets rewritten into a real requirement
            # statement instead of being emitted verbatim.
            synthesis_client=client,
            # Same client, implements ParentSummaryClient directly -- an
            # Epic/Feature's title AND description were both a verbatim
            # copy of the source heading text (confirmed real gap, live:
            # "Controls:", "Over 28V VDC input" read as literal section
            # titles, not ADO's own strategic-goal/capability framing).
            parent_summary_client=client,
            # Same client, implements ConflictJudgeClient directly -- real
            # capability gap closed here: this codebase previously had no
            # conflict/contradiction detection anywhere (see
            # _detect_conflicting_duplicates's own docstring).
            conflict_client=client,
            # Same client, implements RootGroupingClient directly -- closes
            # a document with no single top heading (e.g. AirPro's 77
            # disconnected root nodes, see _regroup_disconnected_roots's
            # own docstring) into a coherent hierarchy, structure-only.
            grouping_client=client,
            branch_concurrency=settings.survey_branch_concurrency,
            # Chunk-level counterpart, independent dial (the two never
            # compound -- see Settings.survey_chunk_concurrency's own
            # comment). Default 1 = the previous strictly-sequential
            # behavior for all five chunked enhancement passes.
            chunk_concurrency=settings.survey_chunk_concurrency,
            primer_context=primer_context,
            # Same client, implements TitleDistillationClient directly --
            # 300553's smart-title fallback: a stage-1 title too generic/
            # short to be useful gets replaced once the node's real
            # description exists to distill a better one from (see
            # _author_branch_content's own gate for the actual quality check).
            title_distillation_client=client,
        )


class DedupCheckRequest(BaseModel):
    text: str
    title: str
    area_path: str
    # Settings-window-driven override (NEW-07) -- orchestrator's own
    # AppSettings row; omitted (None) falls through to
    # check_for_duplicates's own 0.90 default, identical to before this
    # field existed.
    threshold: float | None = None
    # The submitting user's identity, forwarded to judge_duplicate_pair's
    # own per-call user_id param (see OrchestratorLlmClient's own
    # X-Req2Ado-User-Id threading) so this route's LLM tie-break judge call
    # resolves the caller's own Open WebUI connection instead of failing
    # 401 against the orchestrator's now-mandatory per-user auth. None for
    # any caller that doesn't have a user identity handy -- the judge call
    # simply fails the same way any other unauthenticated /llm/* call does.
    user_id: str | None = None


class DedupUpsertRequest(BaseModel):
    item_id: str
    text: str
    title: str
    area_path: str
    # See DedupCheckRequest.user_id's own doc comment -- same purpose, this
    # route's own /llm/embed call needs it to resolve a per-user connection.
    user_id: str | None = None


class DedupUpsertBatchRequest(BaseModel):
    items: list[DedupUpsertRequest]
    # Batch-wide, not per-item -- every item in one batch upsert comes from
    # the SAME job's confirm() run (see JobsService.confirm() /
    # ingestion-http.client.ts's upsertDedupEntriesBatch), so one shared
    # user_id for the whole request is correct, not a per-item field.
    user_id: str | None = None


class DedupDeleteRequest(BaseModel):
    item_id: str
    area_path: str


class KbIngestUrlRequest(BaseModel):
    url: str
    user_id: str
    doc_type: str | None = None
    recursive: bool = False  # ignored by /kb/ingest-url (single doc); folder route only
    # "retrieve" (default, None also means this) or "always_include" -- see
    # KbVectorStore.upsert_chunk's own docstring. Ignored by
    # /kb/ingest-folder-url (single-doc routes only) -- a whole folder of
    # files being unconditionally injected into every prompt is a much
    # larger blast radius than one deliberately-chosen standards doc, so
    # this stays scoped to the single-document upload path for now.
    retrieval_mode: str | None = None
    # Optional per-request override for the shared SharePoint token -- set
    # by the orchestrator when a user has rotated the token via
    # POST /kb/sharepoint/reconnect (stored in its credential vault, not
    # this process's env). Falls back to settings.sharepoint_token when
    # absent, same as before this field existed.
    graph_token: str | None = None


class KbIngestItemRequest(BaseModel):
    name: str
    item_id: str
    download_url: str
    user_id: str
    doc_type: str | None = None
    retrieval_mode: str | None = None
    graph_token: str | None = None


class KbBrowseFolderRequest(BaseModel):
    url: str
    graph_token: str | None = None


class KbBrowseChildrenRequest(BaseModel):
    drive_id: str
    item_id: str
    graph_token: str | None = None


class KbSharePointStatusRequest(BaseModel):
    graph_token: str | None = None


class KbSharePointStatusResult(BaseModel):
    status: str  # "not_configured" | "valid" | "invalid" | "unreachable"
    expires_in_seconds: int | None = None


class ChatTurnItem(BaseModel):
    type: str
    title: str
    description: str
    childType: str | None = None
    qualityIssues: list[str] = []


class ChatTurnMessage(BaseModel):
    role: str
    content: str


class ChatTurnRequest(BaseModel):
    item: ChatTurnItem
    history: list[ChatTurnMessage] = []
    message: str
    model: str | None = None
    user_id: str | None = None


@app.get("/health")
def health() -> dict[str, bool]:
    # Liveness: process is up, nothing more. Deliberately does NOT check
    # Chroma -- a k8s liveness-probe failure restarts the pod, the wrong
    # response to "a dependency blipped" (that's what /ready is for).
    # Previously the ONLY health endpoint, unconditional {ok:True}.
    return {"ok": True}


@app.get("/ready")
def ready() -> Response:
    chroma_ok = _vector_store.ping()
    # Real gap this closes: an outage of the KB store (every SURVEY job's
    # grounding depends on it, not just dedup) had no healthcheck at all --
    # a completed job with a silently-empty KB context was indistinguishable
    # from "no KB attached" from the outside. Both stores are independent
    # Chroma collections behind the same client/mode config (see
    # KbVectorStore's own docstring) -- either one being down is a real
    # readiness failure, not just dedup's.
    kb_chroma_ok = _kb_vector_store.ping()
    ok = chroma_ok and kb_chroma_ok
    body = {"ok": ok, "chroma": chroma_ok, "kbChroma": kb_chroma_ok}
    if not ok:
        return JSONResponse(status_code=503, content=body)
    return JSONResponse(status_code=200, content=body)


@app.get("/debug/{job_id}")
def get_debug_captures(job_id: str) -> list[dict[str, str]]:
    """Every raw-model-response capture recorded for a soft-failure warning
    during this job's SURVEY run (see app.debug_capture) -- proxied by the
    orchestrator's own GET /jobs/:id/debug route (ownership-checked there;
    this endpoint is service-to-service only, same trust boundary as every
    other ingestion route). Empty list if nothing was captured -- the common
    case, since capture only fires on an actual soft failure."""
    return _debug_capture.list_captures(job_id)


_UPLOAD_READ_CHUNK_BYTES = 1024 * 1024


@app.post("/ingest", response_model=CanonicalDoc)
async def ingest(
    file: UploadFile,
    redact: bool = False,
    languages: str = "eng",
    skip_vision: bool = False,
    mode: str = "baseline",
    # Optional -- present only for a real job submission (pipeline.worker.ts
    # passes job.id), absent for /jobs/preview's own call (which has no job
    # yet to narrate for). Lets this route publish real parse-stage
    # progress on the SAME job-events channel /level's SURVEY narration
    # already uses, instead of the parse stage being a total black box --
    # confirmed live against a real 39-figure document that the "Parsing
    # document..." UI showed zero detail for however many minutes the
    # figures' sequential vision-LLM calls took.
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
    # Optional -- identifies which user's vaulted Open WebUI credential the
    # orchestrator's /llm/vision proxy should use for this request's figure
    # captioning (see OrchestratorVisionClient.describe_figure's own
    # X-Req2Ado-User-Id doc comment). Same optional query-param convention as
    # job_id/primer_context above. Sent by every real job submission
    # (ingestion-http.client.ts's ingest(), threading job.userId through
    # pipeline.worker.ts) -- omitted only for a caller with genuinely no
    # user context (e.g. /jobs/preview, which sets skip_vision anyway, so
    # vision never fires there). None here degrades to "no identity
    # available," not a fabricated fallback, and the orchestrator's own 401
    # on /llm/vision is the correct, honest failure signal for that case.
    user_id: str | None = None,
) -> CanonicalDoc:
    # skip_vision: /jobs/preview (orchestrator) only needs blockCount/
    # sectionCount/fileType to show the user before they even pick a mode --
    # it never reads figure captions. Without this, every embedded image in
    # a merely-previewed document paid the full per-image vision-LLM
    # inference cost (observed live: a single small image made preview take
    # 28s instead of ~30ms) for output nobody uses. Real job submission
    # (pipeline.worker.ts) never sets this -- captions still matter there.
    #
    # mode: BASELINE is contractually verbatim/no-AI -- describe_figure must
    # never run for it regardless of skip_vision or LLM_VISION_MODEL, so a
    # figure's caption cannot become model-authored text inside a contract-
    # baseline System.Description. Only the literal string "survey" opens the
    # vision gate below (fail-safe default, same direction as /level's own
    # `if mode == "survey"` fork) -- anything else, including an unrecognized
    # value, is treated as baseline.
    # Previously `tmp.write(await file.read())` -- the whole upload was
    # buffered into memory unconditionally, with no size guard at this
    # layer at all (the orchestrator's own upload-size check happens before
    # it forwards a file here, but this endpoint is independently reachable
    # and had zero protection if called directly). Now streams in bounded
    # chunks and aborts as soon as the configured cap is exceeded, rather
    # than reading the entire body first and checking after the fact.
    max_bytes = settings.max_upload_size_mb * 1024 * 1024
    suffix = Path(file.filename or "").suffix
    total_bytes = 0
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
        while chunk := await file.read(_UPLOAD_READ_CHUNK_BYTES):
            total_bytes += len(chunk)
            if total_bytes > max_bytes:
                Path(tmp_path).unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"file exceeds the {settings.max_upload_size_mb}MB upload limit",
                )
            tmp.write(chunk)

    narration_publisher = NarrationPublisher(_narration_redis, job_id) if job_id else None
    vision_active = _vision_client is not None and not skip_vision and mode == "survey"

    describe_figure_fn = None
    # Populated below on a store() failure (figure captioned fine, but its
    # bytes never made it to storage) -- surfaced on the response as
    # CanonicalDoc.failed_figure_storage_ids since storage happens here, in
    # /ingest, not in /level, so it can never become a WorkItemTree
    # IntegrityWarning; the orchestrator turns a non-empty list here into
    # its own synthesized WarningRecord (mirrors ado_verification_failed's
    # precedent -- see pipeline.worker.ts).
    failed_figure_ids: list[str] = []
    # figure_id -> "insignificant"|"vision_failed", populated below (only
    # while vision_active) via _describe_figure's caption_status_out
    # side-channel -- patched onto doc.figures[i].caption_status once `doc`
    # exists (see below), since a Figure model isn't constructed until the
    # loader returns. Empty (and doc.figures[*].caption_status left at its
    # None default) whenever vision_active is False, matching sub-fix (i)'s
    # "never disambiguate insignificant/failed when vision never ran" rule.
    figure_caption_status: dict[str, str] = {}
    # Task 7: figure_id -> the vision model's own short title, same
    # side-channel/patch-after-doc-exists shape as figure_caption_status
    # above. Only ever used as a FALLBACK once `doc` exists (see the patch
    # loop below) -- a figure the document itself already named via Task 4
    # keeps that name unconditionally.
    figure_title: dict[str, str] = {}
    # Every figure's original bytes, in loader-append order -- collected
    # during the parse, captioned afterward (see the post-parse captioning
    # pass below). The collector deliberately does NOTHING but record and
    # return None: the loaders' own lockstep-append invariant means the Nth
    # call corresponds to figure id f"f{N-1}", so recording in call order is
    # all the id bookkeeping this needs. Returning None is safe for every
    # loader: each one already treats a None caption as the normal
    # "uncaptioned figure" outcome (that is exactly what it gets when vision
    # is disabled and describe_figure is None at all, and what its own
    # per-figure except returns on a vision failure), so the figure list and
    # the ids it produces are identical either way.
    collected_figure_bytes: list[bytes] = []
    if vision_active:

        def _collect_figure_bytes(image_bytes: bytes) -> str | None:
            collected_figure_bytes.append(image_bytes)
            return None

        describe_figure_fn = _collect_figure_bytes

    try:
        # run_in_threadpool: dispatch_by_extension can now make a real
        # network call per figure (vision description) when
        # LLM_VISION_MODEL is configured, on top of the CPU-bound
        # parsing/OCR work it already did -- must not block the event loop
        # (same reasoning as /level's SURVEY path).
        doc = await run_in_threadpool(
            dispatch_by_extension,
            file.filename or "",
            tmp_path,
            languages=languages,
            describe_figure=describe_figure_fn,
        )
        # Real page numbers for a docx's own blocks/tables/figures -- a docx
        # carries none in its own file format (see docx_pagination.py's own
        # module docstring; pagination is a rendering-time computation, not
        # document structure). Deliberately called HERE, at the route level,
        # rather than inside load_docx/dispatch_by_extension themselves:
        # this is an OPTIONAL, route-gated enrichment (the
        # docx_page_alignment_enabled kill switch below, plus its own
        # narration events) that pays an expensive docx->PDF conversion, so
        # it stays a decision /ingest makes once per request instead of a
        # cost every caller of the loaders silently inherits. Needs
        # `tmp_path` (still on disk -- the `finally` below hasn't run yet
        # ), not `doc.document.path` (dispatch_by_extension already
        # rewrote every SourceRef.document_path to the ORIGINAL filename by
        # the time doc is returned -- see
        # dispatch._normalize_document_identity). settings.docx_page_
        # alignment_enabled is a kill switch (default on) for disabling
        # this without a code deploy; annotate_docx_pages' own blanket
        # try/except already makes a conversion/alignment FAILURE
        # transparent (doc returned unchanged) -- this flag instead skips
        # even ATTEMPTING it.
        docx_uploaded = Path(file.filename or "").suffix.lower() == ".docx"
        if settings.docx_page_alignment_enabled and docx_uploaded:
            if narration_publisher is not None:
                narration_publisher.publish(
                    LevelingProgress(
                        phase="page_alignment",
                        branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                        kb_grounded=False, kb_citations=[],
                    )
                )
            doc, page_alignment = await run_in_threadpool(annotate_docx_pages, doc, tmp_path)
            if narration_publisher is not None:
                narration_publisher.publish(
                    LevelingProgress(
                        phase="page_alignment",
                        branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                        kb_grounded=False, kb_citations=[],
                        page_align_page_count=page_alignment.page_count,
                        page_align_anchored_ratio=page_alignment.anchored_ratio,
                    )
                )
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    # POST-PARSE CAPTIONING PASS -- phase 2 of two, now bounded-concurrent.
    # Parsing (above) collected every figure's bytes in loader-append order
    # without making a single vision call; this pass captions them with at
    # most settings.vision_caption_concurrency in flight, and phase 3
    # (_reassign_figure_captions) writes the results back by figure id.
    #
    # Runs HERE, after the try/finally, so it operates on the FINAL `doc`
    # (including whatever annotate_docx_pages returned, which can replace
    # Block/SourceRef objects). It needs no tmp_path -- the bytes are
    # already in hand -- so the finally's unlink above is harmless. And it
    # must run BEFORE the caption_status/name patch loop and the parse_done
    # narration below, both of which read what it produces.
    #
    # Three parts, and the split is the whole correctness story:
    #  - DISPATCH, on this thread: submit every figure's work unit, then walk
    #    the results in submission order, firing each figure's "starting"
    #    narration LAZILY -- immediately before that figure's own result is
    #    consumed, never all up front (see the loop's own comment).
    #  - WORKERS: _caption_and_store_one_figure and nothing else. It has no
    #    shared-state mutation and no narration by construction (see its own
    #    docstring), which is what makes it safe here -- and it keeps
    #    captioning and figure-file storage together, so the
    #    rasterized-bytes reuse a prior fix introduced still holds.
    #  - MERGE, on this thread, BY SUBMISSION INDEX (never completion order)
    #    and one figure at a time as its result arrives: fire that figure's
    #    "captioned" narration, populate the
    #    caption_status/title side channels, append storage failures, and
    #    reassign onto the tree. Everything user-visible therefore comes out
    #    in document order: ProgressBanner derives its overall percentage
    #    from the LAST narration event's figureIndex and the frontend's
    #    NarrationEvent carries no timestamp or sequence field at all, so an
    #    out-of-order index is a backwards-moving progress bar; and
    #    failed_figure_storage_ids' order reaches the user as a
    #    WarningRecord.
    #
    # Exact, for every format: parsing has already finished, so the real
    # figure count is simply how many the collector saw. This replaced a
    # per-format precount that existed only because inline captioning
    # narrated before the total was knowable -- a whole second document walk
    # for docx/pptx, a hardcoded 1 for images, and an explicitly APPROXIMATE
    # pypdf xobject count for pdf (which the loaders' own suppression/dedupe
    # gates could legitimately reduce). The denominator the user sees is now
    # the number of figures that will actually be captioned.
    figure_total = len(collected_figure_bytes)
    figure_outcomes: list[FigureCaptionOutcome] = []
    if collected_figure_bytes:
        def _publish_figure_start(figure_position: int) -> None:
            if narration_publisher is None:
                return
            narration_publisher.publish(
                LevelingProgress(
                    phase="describe_figure",
                    branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                    kb_grounded=False, kb_citations=[],
                    figure_index=figure_position + 1, figure_count=figure_total,
                )
            )

        def _caption_one(figure_position: int) -> FigureCaptionOutcome:
            # primer_context is the /ingest route param; _describe_figure's
            # own parameter is named document_context -- this is the one
            # place that boundary rename happens. Two byte-identical figures
            # could in principle race the same caption cache key here and
            # both make a live call; harmless, and unreachable within one
            # document anyway, since every loader already dedupes identical
            # figures by sha256 before the collector ever sees the second.
            return _caption_and_store_one_figure(
                f"f{figure_position}",
                collected_figure_bytes[figure_position],
                primer_context,
                job_id,
                user_id=user_id,
            )

        def _merge_one(outcome: FigureCaptionOutcome) -> None:
            """Everything one finished figure changes, all on the CALLING
            thread and all at the moment that figure's result is consumed."""
            figure_outcomes.append(outcome)
            if outcome.status is not None:
                figure_caption_status[outcome.figure_id] = outcome.status
            if outcome.title is not None:
                figure_title[outcome.figure_id] = outcome.title
            if outcome.storage_failed:
                failed_figure_ids.append(outcome.figure_id)
            if narration_publisher is not None:
                # caption is None exactly when the vision model judged this
                # figure non-significant (or vision failed) -- both cases get
                # the same honest "nothing here" narration copy.
                display_caption = (
                    outcome.caption if outcome.caption is not None
                    else "this figure has no discernible technical content"
                )
                narration_publisher.publish(
                    LevelingProgress(
                        phase="describe_figure",
                        branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                        kb_grounded=False, kb_citations=[],
                        figure_index=int(outcome.figure_id[1:]) + 1,
                        figure_caption=display_caption, figure_count=figure_total,
                        # Distinct from display_caption above -- see
                        # LevelingProgress.figure_caption_status's own docstring.
                        figure_caption_status=outcome.status,
                    )
                )

        caption_concurrency = settings.vision_caption_concurrency
        if caption_concurrency <= 1 or len(collected_figure_bytes) <= 1:
            # Byte-identical to this pass's pre-concurrency form: one figure
            # at a time, in document order, with no ThreadPoolExecutor
            # constructed at all -- zero new risk for every deployment that
            # hasn't opted into concurrency. Same guard shape
            # llm_leveling.py's own branch/batch fan-outs use.
            for figure_position in range(len(collected_figure_bytes)):
                _publish_figure_start(figure_position)
                _merge_one(_caption_one(figure_position))
        else:
            with ThreadPoolExecutor(max_workers=caption_concurrency) as executor:
                futures = [
                    executor.submit(_caption_one, figure_position)
                    for figure_position in range(len(collected_figure_bytes))
                ]
                # Consumed by INDEX (list position of the future), never by
                # completion order -- and each figure's "starting" event is
                # published LAZILY, immediately before its own result is
                # pulled, exactly as bounded_chunks.run_chunks_bounded's
                # generator lets its callers do. Publishing all the starts up
                # front instead (which this loop used to do) fires the whole
                # phase's narration back-to-back in microseconds: the progress
                # bar jumps to ~100% of the figure phase and then freezes for
                # the entire pass, and every caption lands in one burst at the
                # end. Same regression, same fix, as the chunked-pass
                # narration a sibling sweep item already corrected.
                for figure_position, future in enumerate(futures):
                    _publish_figure_start(figure_position)
                    _merge_one(future.result())
        _reassign_figure_captions(doc, figure_outcomes)

    doc.failed_figure_storage_ids = failed_figure_ids
    doc.vision_active = vision_active
    # Patch each figure's caption_status from the per-request side channel
    # populated above -- can't be set until now since the Figure objects
    # themselves don't exist until dispatch_by_extension returns `doc`.
    # Empty (no-op loop) whenever vision_active is False, so caption_status
    # stays at its None default for every figure in that case (sub-fix (i)'s
    # tree-level warning covers that case instead -- see main.py's /level
    # route and _append_vision_disabled_warning below).
    if figure_caption_status or figure_title:
        _figures_by_id = {figure.id: figure for figure in doc.figures}
        for _figure_id, _status in figure_caption_status.items():
            _figure = _figures_by_id.get(_figure_id)
            if _figure is not None:
                _figure.caption_status = _status
        # Task 7: ONLY a fallback -- applied when the loader itself found no
        # document caption for this figure (figure_utils.py's
        # extract_figure_title, used by PDF and docx -- docx via its own
        # Caption paragraph style). A figure the document already named
        # keeps that name unconditionally; the vision title never overrides
        # it.
        for _figure_id, _title in figure_title.items():
            _figure = _figures_by_id.get(_figure_id)
            if _figure is not None and _figure.name is None:
                _figure.name = _title

    if narration_publisher is not None:
        narration_publisher.publish(
            LevelingProgress(
                phase="parse_done",
                branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                kb_grounded=False, kb_citations=[],
                block_count=len(doc.blocks), table_count=len(doc.tables), figure_count=len(doc.figures),
            )
        )
        # One event per Table, right after parse_done -- answers "did my
        # tables ingest correctly" (row count + deterministic-detection
        # qualifying status) up front, rather than the user having to wait
        # for analysis/scoring to find out a table was mis-parsed.
        for table_index, table in enumerate(doc.tables, start=1):
            # Real bug (confirmed live): rows_from_table returns only the
            # ID-hierarchy-QUALIFYING rows (legitimately [] for a table
            # whose content just isn't ID-shaped) -- using that as the
            # reported row count made every non-qualifying table read as
            # "0 row(s)", indistinguishable from a genuinely empty/mis-
            # parsed table. table.rows is the real raw row count; qualifying
            # status is reported separately, never conflated with size.
            qualifying_rows = rows_from_table(table)
            narration_publisher.publish(
                LevelingProgress(
                    phase="table_detected",
                    branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
                    kb_grounded=False, kb_citations=[],
                    table_id=table.id, table_row_count=len(table.cells), table_qualifies=bool(qualifying_rows),
                    table_index=table_index, table_count=len(doc.tables),
                )
            )

    if redact:
        doc = redact_canonical_doc(doc)
    return doc


def _append_vision_disabled_warning(
    tree: WorkItemTree, doc: CanonicalDoc, mode: str,
) -> WorkItemTree:
    """Sub-fix (i) of issue 4(b): a single TREE-level warning (never one per
    figure) explaining every one of this tree's uncaptioned_figure_ids at
    once, whenever vision never even ran for this document (doc.vision_active
    is False, set once by /ingest -- see CanonicalDoc.vision_active's own
    docstring for why this is carried on `doc` rather than a new /level query
    param) AND the document actually has at least one figure (a figure-less
    document has nothing this warning would explain). Applied uniformly to
    BOTH mode's builders from this one call site in /level, rather than
    threaded into build_survey_tree/build_baseline_tree separately -- those
    have several internal return points each (headingless/flat-list/
    structured for BASELINE); wrapping the route's own return value here
    guarantees exactly one emission per request regardless of which internal
    path produced the tree.

    Gated to `mode == "survey"` only (final whole-branch review finding):
    BASELINE mode never activates vision by design (see the `vision_active`
    computation above, which requires `mode == "survey"`), so `doc.
    vision_active` is unconditionally False for every BASELINE job with at
    least one figure -- this is an expected, permanent, non-actionable fact
    for that mode, not something worth flagging on literally every BASELINE
    run. SURVEY jobs where vision was explicitly turned off still get the
    warning, since there it reflects a real per-job configuration choice
    worth surfacing."""
    if mode == "survey" and not doc.vision_active and doc.figures:
        tree.warnings.append(
            IntegrityWarning.make(
                WarningKind.VISION_CAPTIONING_DISABLED,
                f"Vision captioning was disabled for this run -- {len(doc.figures)} figure(s) have no description as a result.",
            )
        )
    return tree


def _enforce_requirement_only_fields(tree: WorkItemTree) -> WorkItemTree:
    """Customer ID (WorkItemNode.customer_id), classification
    (WorkItemNode.tags), and the SE coverage reference
    (WorkItemNode.se_coverage_ref) are all per-Requirement attributes --
    never applied to Epic/Feature. Customer ID is additionally never
    fabricated when no real document-authored identifier exists;
    se_coverage_ref is never auto-populated at all, under any
    circumstance (always None out of ingestion -- see its own docstring).
    Every node-construction site in tree_builder.py/id_tree_builder.py/
    llm_leveling.py already gets this right on its own, but this belt-and-
    suspenders pass, applied uniformly to BOTH mode's builders from this
    one call site (same VISION_CAPTIONING_DISABLED precedent immediately
    above -- fires exactly once regardless of BASELINE/SURVEY mode or
    which internal builder path produced the tree), makes the invariant
    provable rather than dependent on every current and future
    construction site individually staying correct.

    Non-Requirement nodes: customer_id/se_coverage_ref forced to None,
    tags forced to [] unconditionally (Epic/Feature never carry any of
    these, even if some future change accidentally set one). A stripped
    Epic/Feature value is a silently-corrected internal invariant, not
    reviewer-actionable, so it gets no warning -- unlike customer_id below.
    se_coverage_ref never warns even on a Requirement: unlike a missing
    Customer ID, an absent SE coverage reference is the expected default
    (nothing to extract, ever), not a review-worthy gap.

    Requirement nodes with no customer_id: left as None (never invented),
    but flagged in ONE tree-level MISSING_SOURCE_REFERENCE warning listing
    every affected node -- matching this codebase's established one-per-
    tree, not one-per-node, dedup convention (see DROPPED_BLOCKS/
    ZERO_NODES).

    Guards against a value that both stage 1 (model self-report) and
    stage 3 (table-fallback extraction) can individually pass as verbatim-
    grounded and yet still be wrong -- e.g. a recurring product/variant
    name mentioned in the source text, mistaken for a per-row customer-
    assigned identifier. Neither stage has visibility into what value
    landed on any OTHER node, so this whole-tree pass is the only layer
    that can catch it: a genuine customer ID is unique to ONE requirement
    by definition, so any value shared by 2+ nodes ACROSS THE WHOLE TREE
    gets stripped from every node that carries it (never guessing which,
    if any, is genuinely correct), flagged via its own
    DUPLICATE_CUSTOMER_ID warning, separate from MISSING_SOURCE_REFERENCE
    (that one means "no id was ever offered"; this one means "an id WAS
    offered but couldn't be trusted"). Computed BEFORE the missing-id loop
    above, over the ORIGINAL per-node values, so a node stripped here is
    reported only in the duplicate warning, not double-counted as merely
    "missing" too. Confirmed live case and the two prior mechanisms this
    backstops: docs/handoff-heading-tier-detector-and-customer-id-fixes.md."""
    customer_id_counts: dict[str, int] = {}
    for node in tree.nodes:
        if node.type == WorkItemType.REQUIREMENT and node.customer_id:
            customer_id_counts[node.customer_id] = customer_id_counts.get(node.customer_id, 0) + 1
    duplicate_values = {value for value, count in customer_id_counts.items() if count > 1}

    missing_node_ids: list[str] = []
    duplicate_node_ids_by_value: dict[str, list[str]] = {}
    for node in tree.nodes:
        if node.type != WorkItemType.REQUIREMENT:
            node.customer_id = None
            node.tags = []
            node.se_coverage_ref = None
        elif node.customer_id in duplicate_values:
            duplicate_node_ids_by_value.setdefault(node.customer_id, []).append(node.local_id)
            node.customer_id = None
        elif node.customer_id is None:
            missing_node_ids.append(node.local_id)
    for value, node_ids in duplicate_node_ids_by_value.items():
        tree.warnings.append(
            IntegrityWarning.make(
                WarningKind.DUPLICATE_CUSTOMER_ID,
                f"Customer ID '{value}' was reported on {len(node_ids)} different Requirements -- "
                "a real customer ID is unique to one requirement, so it was removed from all of them "
                "rather than guessing which (if any) is correct; review and add the real ID manually "
                "if the source document has one.",
                node_ids=node_ids,
                detail={"duplicateValue": value},
            )
        )
    if missing_node_ids:
        tree.warnings.append(
            IntegrityWarning.make(
                WarningKind.MISSING_SOURCE_REFERENCE,
                f"{len(missing_node_ids)} Requirement(s) have no document-authored Customer ID / "
                "source-requirement-number -- none was invented; review and add one manually if the "
                "source document has one that couldn't be automatically extracted.",
                node_ids=missing_node_ids,
            )
        )
    return tree


@app.post("/level", response_model=WorkItemTree)
async def level(
    doc: CanonicalDoc,
    mode: str = "baseline",
    user_id: str | None = None,
    link_type_catalog: str | None = None,
    model: str | None = None,
    job_id: str | None = None,
    primer_context: str | None = None,
) -> WorkItemTree:
    if mode == "survey":
        # One real client instance satisfies SectionAnalysisClient (and every
        # other build_survey_tree Protocol). run_in_threadpool:
        # OrchestratorLlmClient's HTTP calls are synchronous (httpx.Client,
        # not an async client) — calling build_survey_tree inline in this
        # async route would block ingestion's single-worker event loop for
        # the whole job's duration, starving every other concurrent request
        # (including /health). Moving the blocking work to FastAPI's
        # threadpool keeps the loop free.
        # link_type_catalog arrives as a JSON-encoded query param (matches
        # the existing lightweight query-param style user_id here already
        # uses) rather than restructuring the request body around
        # CanonicalDoc — the orchestrator is the only caller that populates it.
        # model is an optional per-job override of the orchestrator's own
        # LLM_CHAT_MODEL default (see OpenWebUiClient.chat's opts.model) --
        # unset means "use whatever the orchestrator is configured with",
        # matching pre-model-selection behavior exactly. Also resolved by
        # build_survey_tree's own _resolve_caps(model) for branch-size cap +
        # tool-calling capability (§5c/§6).
        # num_ctx (§6 of the whole-document redesign): Ollama's actual
        # runtime context window isn't what a model's architectural max
        # implies -- without setting it explicitly, Ollama truncates to its
        # own small default regardless of how large a prompt this proxies,
        # so the §3 whole-document gate's promise ("fits budget -> analyzed
        # in one call") wouldn't actually hold for a local model. Sized from
        # the SAME _resolve_caps(model) budget build_survey_tree itself uses
        # for the gate decision, so num_ctx and the gate never disagree. A
        # genuine OpenAI-compat backend (the production frontier-model
        # proxy) ignores this unrecognized field -- harmless to always send.
        # caps_client=probe_client: _resolve_caps's optional live /api/show
        # lookup (for a model NOT already in _MODEL_CAPS) is a real,
        # synchronous httpx.Client HTTP call (same convention as every
        # other OrchestratorLlmClient method) -- run in its OWN threadpool
        # dispatch, never inline in this async route, for the exact reason
        # build_survey_tree's own call below is already threadpool-
        # dispatched. probe_client needs no num_ctx of its own (show_model's
        # request doesn't use it); construction itself is cheap/sync
        # (no I/O), so building a second instance below with the now-known
        # num_ctx is simpler than mutating this one after the fact.
        probe_client = OrchestratorLlmClient(
            settings.orchestrator_url, settings.llm_proxy_bearer, model=model,
            top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P,
        )
        num_ctx = (
            await run_in_threadpool(_resolve_caps, model, probe_client, user_id)
        ).context_budget_tokens
        client = OrchestratorLlmClient(
            settings.orchestrator_url, settings.llm_proxy_bearer, model=model, num_ctx=num_ctx,
            top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P, cache=_llm_response_cache,
        )
        catalog = json.loads(link_type_catalog) if link_type_catalog else None
        tree = await run_in_threadpool(
            _build_survey_tree_with_scoring, doc, client, user_id, catalog, job_id, model, primer_context
        )
        return _enforce_requirement_only_fields(_append_vision_disabled_warning(tree, doc, mode))
    return _enforce_requirement_only_fields(
        _append_vision_disabled_warning(build_baseline_tree(doc), doc, mode)
    )


class ScoreItemRequest(BaseModel):
    """CR-7d rescore: re-judge ONE already-formalized requirement's current
    title+description after a manual/AI-chat edit, without re-running the
    whole SURVEY pipeline. `category_checklist`, when supplied (the item's
    OWN previously-scored categoryScores keys), forces the rescore to judge
    the SAME rubric as the original scoring pass -- see
    score_single_requirement_text's own docstring."""

    description: str
    category_checklist: list[str] | None = None
    user_id: str | None = None
    model: str | None = None


class ScoreItemResponse(BaseModel):
    quality_score: int | None
    quality_issues: list[str]
    quality_category_scores: dict[str, int] | None
    # SWEEP.md section 7's abstain channel, serialized as its plain string
    # value ('high'|'medium'|'low') rather than the enum -- this is the JSON
    # response the orchestrator's IngestionHttpClient.scoreItem parses. null
    # when the model said nothing usable (see scoring._parse_confidence).
    quality_confidence: str | None


@app.post("/score-item", response_model=ScoreItemResponse)
async def score_item(body: ScoreItemRequest) -> ScoreItemResponse:
    if not body.description.strip():
        raise HTTPException(status_code=400, detail="description must not be blank")
    kb_context = None
    if body.user_id:
        kb_context, _ = retrieve_context(body.user_id, body.description, _embed_client, _kb_vector_store)
    # Mirrors /level's own construct-probe-then-construct-real pattern (see
    # that route's comment for why _resolve_caps's optional live /api/show
    # lookup must be threadpool-dispatched, not run inline in an async
    # route). Unlike main.py's two module-level singleton clients -- which
    # genuinely have no per-job model to probe against, and are documented
    # as correctly-by-design without numCtx -- this route DOES carry a real
    # model (body.model), so the same caps resolution applies directly.
    # top_k/min_p are the same model-independent Gemma4 repetition-collapse
    # mitigation constants every other correctly-configured client gets;
    # without them the sibling topK/minP forwarding fix inside
    # score_requirements_for_document (which this route reaches via
    # score_single_requirement_text) was silently inert on this route.
    probe_client = OrchestratorLlmClient(
        settings.orchestrator_url, settings.llm_proxy_bearer, model=body.model,
        top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P,
    )
    num_ctx = (
        await run_in_threadpool(_resolve_caps, body.model, probe_client, body.user_id)
    ).context_budget_tokens
    client = OrchestratorLlmClient(
        settings.orchestrator_url, settings.llm_proxy_bearer, model=body.model, num_ctx=num_ctx,
        top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P,
    )
    score, issues, category_scores, confidence = score_single_requirement_text(
        body.description, client, _get_criteria_retriever(body.user_id), kb_context, body.category_checklist,
        user_id=body.user_id,
    )
    return ScoreItemResponse(
        quality_score=score, quality_issues=issues, quality_category_scores=category_scores,
        quality_confidence=confidence.value if confidence is not None else None,
    )


class EnhanceItem(BaseModel):
    id: str
    # The leaf's CURRENT verbatim text -- what the failed first-run call was
    # given (a failed item kept its verbatim text).
    text: str
    # 'Epic' | 'Feature' | 'Requirement' -- only a Requirement keeps tags
    # from a synthesis response (see id_tree_builder.synthesis_updates).
    type: str
    # " > "-joined parent chain titles, root first. Synthesis pass only.
    context: str = ""


class EnhanceItemsRequest(BaseModel):
    """Post-hoc retry of the optional enhancement passes that failed during a
    run (see WarningKind.ENHANCEMENT_CALL_FAILED), for just the affected
    items. `parent_summary` is deliberately not retryable here -- it needs
    every descendant's text, which the caller doesn't send."""

    enhancement_pass: Literal["title_tag", "synthesis"]
    items: list[EnhanceItem]
    user_id: str | None = None
    model: str | None = None


class EnhancedItem(BaseModel):
    title: str | None = None
    tags: list[str] | None = None
    # Synthesis only: new description, with the hash/score recomputed the
    # same way the pipeline does.
    description: str | None = None
    grounding_score: float | None = None
    fidelity_hash: str | None = None


class EnhanceItemsResponse(BaseModel):
    results: dict[str, EnhancedItem]
    # Ids the model returned nothing usable for (or that had blank text).
    omitted: list[str]


# Same size the pipeline's own passes chunk at -- one LLM call per request.
_ENHANCE_ITEMS_MAX = _TITLE_TAG_CHUNK_SIZE


@app.post("/enhance-items", response_model=EnhanceItemsResponse)
async def enhance_items(body: EnhanceItemsRequest) -> EnhanceItemsResponse:
    if not body.items:
        raise HTTPException(status_code=400, detail="items must not be empty")
    if len(body.items) > _ENHANCE_ITEMS_MAX:
        raise HTTPException(
            status_code=400, detail=f"at most {_ENHANCE_ITEMS_MAX} items per request",
        )
    try:
        node_types = {item.id: WorkItemType(item.type) for item in body.items}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"unknown item type: {error}") from error

    # Blank text can't be enhanced; report it rather than spend a call on it.
    sendable = [item for item in body.items if item.text.strip()]
    blank_ids = [item.id for item in body.items if not item.text.strip()]
    if not sendable:
        return EnhanceItemsResponse(results={}, omitted=blank_ids)

    # Same construct-probe-then-construct-real pattern as /score-item, for
    # the same reasons (num_ctx needs the model's caps, which is a blocking
    # lookup that must not run inline in an async route).
    probe_client = OrchestratorLlmClient(
        settings.orchestrator_url, settings.llm_proxy_bearer, model=body.model,
        top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P,
    )
    num_ctx = (
        await run_in_threadpool(_resolve_caps, body.model, probe_client, body.user_id)
    ).context_budget_tokens
    client = OrchestratorLlmClient(
        settings.orchestrator_url, settings.llm_proxy_bearer, model=body.model, num_ctx=num_ctx,
        top_k=_SURVEY_TOP_K, min_p=_SURVEY_MIN_P,
    )

    try:
        if body.enhancement_pass == "title_tag":
            raw = await run_in_threadpool(
                client.title_and_tags_for_rows,
                {item.id: item.text for item in sendable},
                body.user_id,
            )
        else:
            raw = await run_in_threadpool(
                client.synthesize_leaf_requirements,
                {item.id: {"text": item.text, "context": item.context} for item in sendable},
                body.user_id,
            )
    except Exception as error:
        # The caller treats a 502 as "this batch failed" and leaves every
        # item exactly as it was -- retry is a pure enhancement, like the
        # pipeline passes it mirrors.
        logger.warning("enhance-items %s call failed: %s", body.enhancement_pass, error)
        raise HTTPException(status_code=502, detail=f"enhancement call failed: {error}") from error

    results: dict[str, EnhancedItem] = {}
    omitted = list(blank_ids)
    for item in sendable:
        entry = (raw or {}).get(item.id)
        if not isinstance(entry, dict) or not entry:
            omitted.append(item.id)
            continue
        if body.enhancement_pass == "title_tag":
            updates = title_tag_updates(entry)
        else:
            updates = synthesis_updates(entry, item.text, node_types[item.id])
        if not updates:
            omitted.append(item.id)
            continue
        results[item.id] = EnhancedItem(
            title=updates.get("title"),
            tags=[tag.value for tag in updates["tags"]] if "tags" in updates else None,
            description=updates.get("description"),
            grounding_score=updates.get("grounding_score"),
            fidelity_hash=updates.get("fidelity_hash"),
        )
    return EnhanceItemsResponse(results=results, omitted=omitted)


@app.post("/dedup/check", response_model=DuplicateCheckResult)
async def dedup_check(body: DedupCheckRequest) -> DuplicateCheckResult:
    # body.threshold is None when the caller didn't override it (the
    # orchestrator's own Settings-window lookup failed or wasn't wired) --
    # only pass an explicit kwarg when it's actually set, so
    # check_for_duplicates's own default (0.90) governs otherwise, exactly
    # as before this field existed.
    kwargs = {"threshold": body.threshold} if body.threshold is not None else {}
    return check_for_duplicates(
        body.text,
        body.title,
        item_id="",
        area_path=body.area_path,
        embed_client=_embed_client,
        vector_store=_vector_store,
        judge_client=_dedup_judge_client,
        user_id=body.user_id,
        **kwargs,
    )


@app.post("/dedup/upsert")
async def dedup_upsert(body: DedupUpsertRequest) -> dict[str, bool]:
    title_embedding, description_embedding = _embed_client.embed([body.title, body.text], user_id=body.user_id)
    embedding = blend_embeddings(title_embedding, description_embedding)
    # document=body.text: stores the item's original text alongside its
    # embedding, so a future check_for_duplicates call can run its
    # numeric-literal guard (X7) against the actual matched text.
    _vector_store.upsert(body.item_id, embedding, body.area_path, document=body.text)
    return {"ok": True}


@app.post("/dedup/delete")
async def dedup_delete(body: DedupDeleteRequest) -> dict[str, bool]:
    # Counterpart to /dedup/upsert -- a dedup_skip match downgraded to
    # 'create' because its ADO work item no longer exists (see
    # verifyExistingAdoIdsStillExist) must have its stale Chroma entry
    # removed too, or it keeps matching future jobs against a dead id.
    _vector_store.delete(body.item_id, body.area_path)
    return {"ok": True}


@app.post("/dedup/upsert-batch")
async def dedup_upsert_batch(body: DedupUpsertBatchRequest) -> dict[str, bool]:
    # Previously every confirmed work item triggered its own single-item
    # /dedup/upsert call (one embed() round-trip per item) from
    # JobsService.confirm()'s per-node loop, despite embed() already
    # accepting a list. Batches all items' titles AND texts into ONE
    # embed() call (2N texts, not N) -- still one round trip.
    if not body.items:
        return {"ok": True}
    n = len(body.items)
    embeddings = _embed_client.embed(
        [item.title for item in body.items] + [item.text for item in body.items], user_id=body.user_id,
    )
    title_embeddings, description_embeddings = embeddings[:n], embeddings[n:]
    blended_embeddings = [
        blend_embeddings(title_embedding, description_embedding)
        for title_embedding, description_embedding in zip(title_embeddings, description_embeddings)
    ]

    # Group by area_path before calling vector_store.upsert_many -- one
    # Chroma round trip per distinct area path instead of one per item
    # (previously: N individual upsert() calls, undercutting this
    # endpoint's own batching intent, which only batched the embed() call).
    # Each DedupUpsertRequest item carries its own area_path, so this must
    # not assume every item in the batch shares one -- in practice every
    # item in one confirm() call shares the submitting job's single
    # areaPath (see JobsService's dedupUpsertItems), but the grouping here
    # stays correct even if that ever stops holding.
    items_by_area_path: dict[str, list[tuple[str, list[float], str]]] = {}
    for item, embedding in zip(body.items, blended_embeddings):
        items_by_area_path.setdefault(item.area_path, []).append((item.item_id, embedding, item.text))

    for area_path, items in items_by_area_path.items():
        _vector_store.upsert_many(items, area_path)
    return {"ok": True}


@app.post("/kb/ingest-url", response_model=IngestResult)
async def kb_ingest_url(body: KbIngestUrlRequest) -> IngestResult:
    # Token from env (SHAREPOINT_TOKEN / GRAPH_TOKEN). GraphClient raises
    # ValueError if unset — mapped to 400 below. ingest_document_from_url
    # makes synchronous httpx calls; run in the threadpool like /level and
    # the old /kb/sync so it never blocks the single-worker event loop.
    try:
        graph_client = GraphClient(body.graph_token or settings.sharepoint_token or "", settings.graph_base_url)
        return await run_in_threadpool(
            ingest_document_from_url,
            body.url,
            body.user_id,
            body.doc_type,
            graph_client,
            _embed_client,
            _kb_vector_store,
            # KB ingestion shares SURVEY's figure-significance filter (with no
            # document_context) -- an insignificant figure is dropped and will
            # not be KB-retrievable. See _describe_figure's own SCOPE NOTE.
            # Closes over body.user_id (this route's real, wire-supplied
            # identity) so the vision call carries the correct
            # X-Req2Ado-User-Id -- _describe_figure itself is per-user-safe
            # (user_id is a per-call arg, never stored), but the loader's
            # `describe_figure` callback contract is a single-bytes-arg
            # Callable, so the closure is what threads user_id through.
            describe_figure=(
                (lambda image_bytes: _describe_figure(image_bytes, user_id=body.user_id))
                if _vision_client is not None else None
            ),
            checklist_client=_checklist_client,
            retrieval_mode=body.retrieval_mode,
        )
    except ValueError as exc:
        # SSRF/scheme/host/size/content-type violation, or missing token.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GraphApiError as exc:
        # Surface Graph's own status where it maps cleanly; else 502.
        status = exc.status if exc.status in (401, 403, 404) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.post("/kb/ingest-folder-url", response_model=FolderIngestResult)
async def kb_ingest_folder_url(body: KbIngestUrlRequest) -> FolderIngestResult:
    # Same token/threadpool reasoning as /kb/ingest-url. Unlike the
    # single-document route, per-file failures are collected into the
    # response rather than raised — one bad file must not abort the batch.
    # Listing the folder itself (validate_share_url, list_folder_children)
    # can still fail with ValueError/GraphApiError, mapped the same way.
    try:
        graph_client = GraphClient(body.graph_token or settings.sharepoint_token or "", settings.graph_base_url)
        return await run_in_threadpool(
            ingest_folder_from_url,
            body.url,
            body.user_id,
            body.doc_type,
            graph_client,
            _embed_client,
            _kb_vector_store,
            body.recursive,
            # KB ingestion shares SURVEY's figure-significance filter (with no
            # document_context) -- an insignificant figure is dropped and will
            # not be KB-retrievable. See _describe_figure's own SCOPE NOTE.
            # Closes over body.user_id -- see /kb/ingest-url's identical comment.
            describe_figure=(
                (lambda image_bytes: _describe_figure(image_bytes, user_id=body.user_id))
                if _vision_client is not None else None
            ),
            checklist_client=_checklist_client,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GraphApiError as exc:
        # 400 included here (unlike the single-doc route): Graph's own
        # response to /children on a non-folder driveItem is a 400, and that
        # is a client input error ("this link isn't a folder"), not a
        # Graph-unreachable 502.
        status = exc.status if exc.status in (400, 401, 403, 404) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.post("/kb/ingest-item", response_model=IngestResult)
async def kb_ingest_item(body: KbIngestItemRequest) -> IngestResult:
    # Ingests exactly one file already seen via /kb/browse-folder or
    # /kb/browse-children, addressed by its pre-signed Graph download URL --
    # lets the tree view's per-row "ingest" action work without that file's
    # own sharing link. Same token/threadpool/error-mapping reasoning as
    # every other Graph-backed route here.
    try:
        graph_client = GraphClient(body.graph_token or settings.sharepoint_token or "", settings.graph_base_url)
        return await run_in_threadpool(
            ingest_folder_child,
            body.name,
            body.item_id,
            body.download_url,
            body.doc_type,
            body.user_id,
            graph_client,
            _embed_client,
            _kb_vector_store,
            # KB ingestion shares SURVEY's figure-significance filter (with no
            # document_context) -- an insignificant figure is dropped and will
            # not be KB-retrievable. See _describe_figure's own SCOPE NOTE.
            # Closes over body.user_id -- see /kb/ingest-url's identical comment.
            describe_figure=(
                (lambda image_bytes: _describe_figure(image_bytes, user_id=body.user_id))
                if _vision_client is not None else None
            ),
            checklist_client=_checklist_client,
            retrieval_mode=body.retrieval_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GraphApiError as exc:
        status = exc.status if exc.status in (401, 403, 404) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.delete("/kb/documents")
async def kb_delete_document(user_id: str, source_file: str, source_id: str) -> dict[str, bool]:
    # Wraps KbVectorStore.delete_file_chunks (kb_vector_store.py), which
    # already exists but was previously only called internally by re-ingest
    # (ingest_service.py) to clear stale chunks before writing fresh ones --
    # no HTTP route existed to call it standalone for a real user-initiated
    # remove. run_in_threadpool: same reasoning as every other route here --
    # Chroma's client is synchronous I/O, must not block the event loop.
    await run_in_threadpool(_kb_vector_store.delete_file_chunks, user_id, source_file, source_id)
    return {"ok": True}


@app.delete("/kb/collection")
async def kb_purge_collection(user_id: str) -> dict[str, bool]:
    # Admin/CLI-only remediation (see docs/runbook.md) for a deleted-and-
    # recreated ADO account whose new session resolves to the same
    # descriptor-derived user_id as the old one -- KbVectorStore.purge_user
    # irreversibly drops the ENTIRE collection, not just one file's chunks
    # (contrast with kb_delete_document above). run_in_threadpool: same
    # reasoning as every other Chroma-touching route here.
    #
    # Rejects a blank/whitespace-only user_id explicitly: this delete is
    # irreversible, so a malformed query string must 400 loudly rather than
    # either silently no-op against a nonexistent collection or (if it ever
    # collided with a real descriptor) drop the wrong user's KB.
    if not user_id.strip():
        raise HTTPException(status_code=400, detail="user_id is required")
    await run_in_threadpool(_kb_vector_store.purge_user, user_id)
    return {"ok": True}


@app.post("/kb/browse-folder", response_model=list[FolderChildSummary])
async def kb_browse_folder(body: KbBrowseFolderRequest) -> list[FolderChildSummary]:
    # Read-only listing of a shared folder's immediate children -- no
    # ingest side effects, unlike /kb/ingest-folder-url. Lets a user see
    # what's inside a SharePoint link before deciding whether/what to
    # ingest. Same token/error-mapping/threadpool reasoning as every other
    # Graph-backed route here.
    try:
        graph_client = GraphClient(body.graph_token or settings.sharepoint_token or "", settings.graph_base_url)
        return await run_in_threadpool(browse_shared_folder, body.url, graph_client)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GraphApiError as exc:
        status = exc.status if exc.status in (400, 401, 403, 404) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.post("/kb/browse-children", response_model=list[FolderChildSummary])
async def kb_browse_children(body: KbBrowseChildrenRequest) -> list[FolderChildSummary]:
    # Same as /kb/browse-folder, for a subfolder reached during tree
    # expansion (addressed by drive_id + item_id, not a share URL -- see
    # browse_service.browse_subfolder's docstring).
    try:
        graph_client = GraphClient(body.graph_token or settings.sharepoint_token or "", settings.graph_base_url)
        return await run_in_threadpool(browse_subfolder, body.drive_id, body.item_id, graph_client)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except GraphApiError as exc:
        status = exc.status if exc.status in (400, 401, 403, 404) else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.post("/kb/sharepoint/status", response_model=KbSharePointStatusResult)
async def kb_sharepoint_status(body: KbSharePointStatusRequest) -> KbSharePointStatusResult:
    # POST (not GET) so the token never rides in a query string / access log.
    # `body.graph_token` lets the orchestrator check a candidate token before
    # committing it to the vault (see /kb/sharepoint/reconnect there) as well
    # as the currently-effective one after rotation; falls back to this
    # process's own env var exactly like every other Graph-backed route.
    token = body.graph_token or settings.sharepoint_token
    if not token:
        return KbSharePointStatusResult(status="not_configured")
    expires_in_seconds = decode_jwt_expiry_seconds(token)
    try:
        graph_client = GraphClient(token, settings.graph_base_url)
        await run_in_threadpool(graph_client.validate)
    except GraphApiError as exc:
        status = "invalid" if exc.status in (401, 403) else "unreachable"
        return KbSharePointStatusResult(status=status, expires_in_seconds=expires_in_seconds)
    return KbSharePointStatusResult(status="valid", expires_in_seconds=expires_in_seconds)


@app.post("/chat/{job_id}/{local_id}/turn")
async def chat_turn(job_id: str, local_id: str, body: ChatTurnRequest) -> dict[str, bool]:
    # ChatLlmClient and RedisChatPublisher are fully async (httpx.AsyncClient,
    # redis.asyncio) — no run_in_threadpool needed for those, unlike /level
    # and /kb/ingest-*, which wrap synchronous httpx.Client calls. However,
    # run_chat_turn also calls retrieve_context, which IS a blocking sync
    # call (embed client + vector store I/O) — it's wrapped in
    # run_in_threadpool inside run_chat_turn itself (chat_service.py), so
    # this route stays non-blocking end-to-end. The caller (orchestrator's
    # ChatService) doesn't await this request's completion either way — see
    # chat.service.ts.
    chat_client = ChatLlmClient(settings.orchestrator_url, settings.llm_proxy_bearer)
    await run_chat_turn(
        job_id,
        local_id,
        body.item.model_dump(),
        [m.model_dump() for m in body.history],
        body.message,
        body.model,
        body.user_id,
        _embed_client,
        _kb_vector_store,
        chat_client,
        _chat_redis_publisher,
    )
    return {"ok": True}
