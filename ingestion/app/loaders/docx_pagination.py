# ingestion/app/loaders/docx_pagination.py
from __future__ import annotations

import bisect
import logging
import os
import re
import subprocess
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader

from app.canonical.model import CanonicalDoc, SourceRef
from app.loaders.pdf_loader import load_pdf

logger = logging.getLogger(__name__)

# A docx file carries NO page numbers anywhere in its own file format --
# pagination is a rendering-time computation, not document structure (the
# only OOXML artifact close to it, w:lastRenderedPageBreak, is empty on any
# docx never opened+saved by real MS Word, which includes every
# machine-generated fixture this codebase creates). Real page numbers for a
# docx's own blocks/tables/figures are instead derived by converting it to
# PDF via headless LibreOffice (see Dockerfile's own comment for why
# libreoffice-writer specifically) and aligning its blocks against the
# independently-parsed PDF's own real per-page text (pdf_loader.py already
# gets this right for an actual PDF).

# Env-overridable so a slow/contended CI or production box can raise this
# without a code deploy -- a full docx->PDF conversion is a much larger,
# more variable cost than emf_converter.py's own sub-second per-figure
# conversions (whole-document layout, not one small embedded image).
_DEFAULT_CONVERT_TIMEOUT_SECONDS = 180.0
_CONVERT_TIMEOUT_SECONDS = float(
    os.environ.get("DOCX_TO_PDF_CONVERT_TIMEOUT_SECONDS", _DEFAULT_CONVERT_TIMEOUT_SECONDS)
)

# A genuine PDF render is never this small -- guards against soffice
# reporting success (exit 0) while having written a truncated/empty file,
# the same "trust but verify the output, not just the exit code" pattern
# a subprocess-wrapping best-effort function should follow.
_MIN_OUTPUT_FILE_BYTES = 1024


def convert_docx_to_pdf(docx_path: str, out_dir: str) -> str | None:
    """Best-effort docx->PDF conversion via headless LibreOffice -- the SAME
    subprocess pattern app/vision/emf_converter.py already uses for
    EMF/WMF->PNG, just a different target format/component (Writer, not
    Draw). Returns None on ANY failure (missing soffice binary, timeout,
    non-zero exit, or a missing/too-small output file) -- NEVER raises: this
    is piggybacking on an /ingest call that must complete regardless of
    whether real page-number provenance can be derived for this document.

    -env:UserInstallation=<a per-call profile dir under out_dir> gives THIS
    invocation its own soffice user profile -- without it, two concurrent
    conversions (this one, or this one racing emf_converter.py's own calls)
    contend on ONE shared default profile's lock file. Harmless for
    emf_converter.py's own sub-second conversions, but a real latent bug
    once a call can run for a meaningful fraction of
    _CONVERT_TIMEOUT_SECONDS -- fixed here, and (see emf_converter.py's own
    comment) applied there too alongside this change."""
    try:
        profile_dir = Path(out_dir) / "lo_profile"
        subprocess.run(
            [
                "soffice",
                "--headless",
                f"-env:UserInstallation=file://{profile_dir}",
                "--convert-to",
                "pdf",
                "--outdir",
                out_dir,
                docx_path,
            ],
            capture_output=True,
            timeout=_CONVERT_TIMEOUT_SECONDS,
            check=True,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    output_path = Path(out_dir) / f"{Path(docx_path).stem}.pdf"
    if not output_path.exists() or output_path.stat().st_size < _MIN_OUTPUT_FILE_BYTES:
        return None
    return str(output_path)


# Below this many normalized chars, a block is too short to anchor safely
# (real risk of a spurious match against unrelated PDF text, e.g. a bare
# "Notes" heading) -- resolved by bracket interpolation instead (see
# annotate_pages_from_pdf).
_MIN_ANCHOR_CHARS = 12

# A prefix probe used when the FULL normalized text of a block fails to
# match -- handles a paragraph that got split by a page-break-inserted
# header/footer in the PDF render. Any hit via this probe is flagged lower
# ("interpolated") confidence, never treated as an exact match.
_PREFIX_PROBE_CHARS = 40

# Bounds the forward search window AFTER the first successful anchor --
# keeps worst-case cost/tests deterministic on a long document without a
# wall-clock timeout. The very first anchor search (before any anchor has
# been found at all) is deliberately unbounded -- front matter before the
# first anchor may need an arbitrarily long search.
_FORWARD_WINDOW = 200_000

# A low anchored_ratio means the docx->PDF conversion produced structurally
# different content (silent soffice failure, an encrypted/corrupted
# document, something pathological) -- below this, the WHOLE alignment is
# discarded rather than trusting a handful of possibly-coincidental matches.
_MIN_ANCHOR_RATIO = 0.6

_SOFT_HYPHEN = "­"
_ZERO_WIDTH_SPACE = "​"
_NON_ALNUM_SPACE_PATTERN = re.compile(r"[^a-z0-9\s]")
_WHITESPACE_RUN_PATTERN = re.compile(r"\s+")


def _normalize_for_alignment(text: str) -> str:
    """Normalizes text identically on both sides of the docx/PDF comparison
    -- NFKC first (fixes ligatures like the single-codepoint "ﬁ" that PDF
    text extraction often returns as, vs. docx's own "fi"), then casefold,
    strip soft hyphens/zero-width spaces (both common PDF-extraction
    artifacts around line-wrapped words), drop everything that isn't
    alphanumeric or whitespace (punctuation/quote-style differences between
    the two extractions), then collapse whitespace runs."""
    normalized = unicodedata.normalize("NFKC", text).casefold()
    normalized = normalized.replace(_SOFT_HYPHEN, "").replace(_ZERO_WIDTH_SPACE, "")
    normalized = _NON_ALNUM_SPACE_PATTERN.sub("", normalized)
    normalized = _WHITESPACE_RUN_PATTERN.sub(" ", normalized)
    return normalized.strip()


@dataclass(frozen=True)
class PageAlignment:
    """Result of annotate_pages_from_pdf -- surfaced to the caller (see
    annotate_docx_pages) for narration (page count + anchored ratio) and
    directly asserted on in tests, independent of inspecting `doc` itself.
    `applied=False` means the confidence gate discarded the WHOLE alignment
    -- every element in `doc` is guaranteed untouched in that case (the
    other half of the "never a mixed state" invariant)."""

    applied: bool
    anchored_ratio: float
    page_count: int


@dataclass(frozen=True)
class _Anchor:
    start_offset: int
    page: int
    page_end: int
    provenance: str | None


def _build_page_index(pdf_doc: CanonicalDoc) -> tuple[str, list[int], list[int]] | None:
    """Concatenates pdf_doc's own per-page text (already correctly
    page-numbered by pdf_loader.load_pdf) into one string S, in page order,
    recording each page's own start offset into S -- gives page_at(pos) a
    simple bisect lookup. None when pdf_doc has no page-numbered blocks at
    all (nothing to align against)."""
    pages: dict[int, list[str]] = {}
    for block in pdf_doc.blocks:
        page = block.source_ref.page
        if page is None:
            continue
        pages.setdefault(page, []).append(block.text)
    if not pages:
        return None
    ordered_pages = sorted(pages)
    text_parts: list[str] = []
    page_starts: list[int] = []
    offset = 0
    for page in ordered_pages:
        page_starts.append(offset)
        for raw_text in pages[page]:
            normalized = _normalize_for_alignment(raw_text)
            if not normalized:
                continue
            text_parts.append(normalized)
            offset += len(normalized)
            text_parts.append(" ")
            offset += 1
    return "".join(text_parts), page_starts, ordered_pages


def annotate_pages_from_pdf(
    doc: CanonicalDoc, pdf_doc: CanonicalDoc, pdf_page_count: int | None = None
) -> PageAlignment:
    """PURE function (no I/O): aligns `doc`'s (the ORIGINAL docx-derived
    CanonicalDoc) blocks/tables/figures against `pdf_doc`'s (the converted
    PDF, independently parsed by pdf_loader.load_pdf) real per-page text,
    assigning real page/page_end/page_provenance on every element of `doc`
    IN PLACE via SourceRef.model_copy (never mutating a SourceRef's own
    fields directly -- a SourceRef instance may be shared by reference
    elsewhere, e.g. a WorkItemNode created before this ever ran).

    `pdf_page_count`, when supplied by the caller (annotate_docx_pages,
    which has the real converted PDF file in hand and can ask pypdf/
    pdfplumber for its exact page count), overrides the page count this
    function would otherwise infer as the highest page number appearing in
    `pdf_doc.blocks` -- inference alone silently undercounts a document
    whose trailing page(s) produced no extractable text at all (a true
    blank page). Purely an accuracy improvement for the "after the last
    anchor" bucket's page_end; omitting it (the default) is used by every
    pure-function unit test below, which construct pdf_doc directly and
    have no real PDF file to query.

    Either EVERY element in `doc` gets a real page (this function's return
    has applied=True), or NONE of them do (applied=False, `doc` left
    completely untouched) -- see PageAlignment's own docstring. This
    matters because tree_builder.py's _order_key sorts by `(page or 0,
    start_offset)`: a None/unassigned element collapses to page 0 and sorts
    to the very front of the WHOLE document, which could misfile a
    table/figure into the wrong work item if only SOME elements were
    annotated."""
    page_index = _build_page_index(pdf_doc)
    if page_index is None:
        return PageAlignment(applied=False, anchored_ratio=0.0, page_count=pdf_page_count or 0)
    text_blob, page_starts, page_numbers = page_index
    total_page_count = page_numbers[-1]
    if pdf_page_count is not None:
        total_page_count = max(total_page_count, pdf_page_count)

    def page_at(pos: int) -> int:
        idx = bisect.bisect_right(page_starts, pos) - 1
        idx = min(max(idx, 0), len(page_numbers) - 1)
        return page_numbers[idx]

    # --- Anchor pass: walk doc.blocks (the ORIGINAL docx blocks) in
    # document order, searching for each one's own normalized text inside
    # the PDF's normalized text blob. ---
    # (block_start_offset, s_start, s_end, provenance)
    raw_anchors: list[tuple[int, int, int, str | None]] = []
    placeholder_block_ids: set[str] = set()
    anchorable_total_chars = 0
    anchored_chars = 0
    cursor = 0
    forward_bound: int | None = None  # None == unbounded, until the first successful anchor
    for block in doc.blocks:
        ref = block.source_ref
        if ref.start_offset == 0 and ref.end_offset == 0:
            # docx_loader's own placeholder for a floating/unmatched image
            # rel -- see its trailing relationship loop. Never a real
            # anchor candidate (its text is a synthetic "[FIGURE: ...]"
            # wire format, not real document prose) -- handled as its own
            # whole-document-range case below, unconditionally.
            placeholder_block_ids.add(block.id)
            continue
        normalized = _normalize_for_alignment(block.text)
        if len(normalized) < _MIN_ANCHOR_CHARS:
            continue
        anchorable_total_chars += len(normalized)
        end_bound = len(text_blob) if forward_bound is None else min(forward_bound, len(text_blob))
        pos = text_blob.find(normalized, cursor, end_bound)
        provenance: str | None = None
        match_len = len(normalized)
        if pos == -1:
            prefix = normalized[:_PREFIX_PROBE_CHARS]
            pos = text_blob.find(prefix, cursor, end_bound)
            if pos == -1:
                continue  # leave unanchored -- resolved by interpolation below
            provenance = "interpolated"
            match_len = len(prefix)
        raw_anchors.append((ref.start_offset, pos, pos + match_len, provenance))
        anchored_chars += len(normalized)
        cursor = pos  # not pos + match_len -- allows the next block to still
        # match if blocks overlap in S (e.g. a heading whose text is a
        # substring of the following paragraph's own PDF-rendered text).
        forward_bound = cursor + _FORWARD_WINDOW

    anchored_ratio = (anchored_chars / anchorable_total_chars) if anchorable_total_chars else 0.0
    if anchored_ratio < _MIN_ANCHOR_RATIO:
        logger.warning(
            "docx page alignment discarded -- anchored_ratio %.2f below the %.2f confidence "
            "gate (the docx->PDF conversion likely produced structurally different content)",
            anchored_ratio,
            _MIN_ANCHOR_RATIO,
        )
        return PageAlignment(
            applied=False, anchored_ratio=anchored_ratio, page_count=total_page_count
        )

    anchors = [
        _Anchor(
            start_offset=start_offset,
            page=page_at(s_start),
            page_end=page_at(max(s_end - 1, s_start)),
            provenance=provenance,
        )
        for start_offset, s_start, s_end, provenance in raw_anchors
    ]
    anchor_start_offsets = [a.start_offset for a in anchors]
    anchor_by_start_offset = {a.start_offset: a for a in anchors}

    def resolve_unanchored(start_offset: int) -> tuple[int, int, str]:
        """Bracket-interpolation rule for any element (an unanchored block,
        or any table/figure -- neither is ever itself an anchor candidate)
        keyed purely by its own document-order position relative to the
        anchored blocks -- see this module's own docstring for the
        five-case rule this implements."""
        idx = bisect.bisect_right(anchor_start_offsets, start_offset)
        prev_anchor = anchors[idx - 1] if idx > 0 else None
        next_anchor = anchors[idx] if idx < len(anchors) else None
        if prev_anchor is None:
            # before the first anchor
            return 1, next_anchor.page, "interpolated"
        if next_anchor is None:
            # after the last anchor
            return prev_anchor.page, total_page_count, "interpolated"
        if prev_anchor.page == next_anchor.page:
            return prev_anchor.page, prev_anchor.page, "interpolated"
        # different pages either side -- an honest range, not false precision
        return prev_anchor.page, next_anchor.page, "interpolated"

    def assign(ref: SourceRef, is_placeholder: bool) -> SourceRef:
        if is_placeholder:
            return ref.model_copy(
                update={"page": 1, "page_end": total_page_count, "page_provenance": "interpolated"}
            )
        anchor = anchor_by_start_offset.get(ref.start_offset)
        if anchor is not None:
            return ref.model_copy(
                update={
                    "page": anchor.page,
                    "page_end": anchor.page_end,
                    "page_provenance": anchor.provenance,
                }
            )
        page, page_end, provenance = resolve_unanchored(ref.start_offset)
        return ref.model_copy(
            update={"page": page, "page_end": page_end, "page_provenance": provenance}
        )

    for block in doc.blocks:
        block.source_ref = assign(block.source_ref, block.id in placeholder_block_ids)
    for table in doc.tables:
        table.source_ref = assign(table.source_ref, False)
    for figure in doc.figures:
        is_placeholder = figure.source_ref.start_offset == 0 and figure.source_ref.end_offset == 0
        figure.source_ref = assign(figure.source_ref, is_placeholder)

    return PageAlignment(applied=True, anchored_ratio=anchored_ratio, page_count=total_page_count)


def annotate_docx_pages(doc: CanonicalDoc, docx_path: str) -> tuple[CanonicalDoc, PageAlignment]:
    """Thin orchestrator: docx->PDF (convert_docx_to_pdf) -> parse that PDF
    (pdf_loader.load_pdf, text_only=True -- page alignment only needs
    per-page TEXT, not the converted PDF's own tables/figures) ->
    align (annotate_pages_from_pdf). Wrapped in ONE blanket
    try/except Exception so this NEVER fails the /ingest call it's
    piggybacking on -- a failure here (soffice missing, a pathological
    document, an alignment bug) degrades to `doc` unchanged (no real page
    numbers), never a 500.

    Returns `(doc, PageAlignment)` rather than bare `doc` so the caller
    (app/main.py) can narrate real page count + anchored ratio on
    completion without re-deriving them from `doc` after the fact (page
    count alone would be recoverable by re-scanning `doc`, but
    anchored_ratio would not be, since a discarded alignment leaves every
    element's page as it started -- None, indistinguishable from "this
    document does not need alignment at all")."""
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = convert_docx_to_pdf(docx_path, tmpdir)
            if pdf_path is None:
                return doc, PageAlignment(applied=False, anchored_ratio=0.0, page_count=0)
            pdf_page_count = _pdf_page_count(pdf_path)
            pdf_doc = load_pdf(pdf_path, text_only=True)
            alignment = annotate_pages_from_pdf(doc, pdf_doc, pdf_page_count=pdf_page_count)
            return doc, alignment
    except Exception:  # noqa: BLE001 - must never fail the /ingest call it's piggybacking on
        logger.warning(
            "docx page alignment failed -- proceeding without real page numbers", exc_info=True
        )
        return doc, PageAlignment(applied=False, anchored_ratio=0.0, page_count=0)


def _pdf_page_count(pdf_path: str) -> int | None:
    """Best-effort real page count for the converted PDF (used only to
    widen the "after the last anchor" bucket's page_end beyond what
    inference-from-blocks would give when the PDF's own trailing page(s)
    produced no extractable text) -- None on any failure, in which case
    annotate_pages_from_pdf falls back to its own inference."""
    try:
        return len(PdfReader(pdf_path).pages)
    except Exception:  # noqa: BLE001 - best-effort only, see docstring
        return None
