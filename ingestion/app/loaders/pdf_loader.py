from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Callable

import pdfplumber
from pypdf import PdfReader

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table, TableCell


@lru_cache(maxsize=8)
def cached_pdf_reader(path: str) -> PdfReader:
    # load_pdf_with_ocr_fallback previously called page_has_extractable_text
    # once per page in an `any(...)` scan pass, then again in the main loop
    # -- each call constructed a brand-new PdfReader(path) (itself an O(pages)
    # parse), so a P-page document did ~2P full-document reparses, O(P^2)
    # total. Caching the reader per path (bounded small LRU, not unbounded --
    # this is a request-scoped ingestion process, not a long-lived server
    # cache that should grow forever) turns that into one real parse.
    return PdfReader(path)


def page_has_extractable_text(path: str, page_index: int) -> bool:
    reader = cached_pdf_reader(path)
    page = reader.pages[page_index]
    text = page.extract_text() or ""
    return len(text.strip()) > 0


def _inside_any_bbox(obj: dict, bboxes: list[tuple[float, float, float, float]]) -> bool:
    ox0, otop, ox1, obottom = obj.get("x0", 0), obj.get("top", 0), obj.get("x1", 0), obj.get("bottom", 0)
    return any(x0 <= ox0 and ox1 <= x1 and top <= otop and obottom <= bottom for x0, top, x1, bottom in bboxes)


def _paragraph_tops(filtered_page, paragraphs: list[str]) -> list[float]:
    """One vertical (`top`) position per paragraph, for merging with table
    bboxes into real document order (§12). `extract_words()` and
    `extract_text()` walk the SAME word stream in the SAME top-to-bottom,
    left-to-right reading order -- consuming `len(paragraph.split())` words
    per paragraph, in sequence, gives each paragraph's real top position
    without fuzzy text re-matching against the already-extracted string."""
    words = iter(filtered_page.extract_words())
    tops: list[float] = []
    for paragraph in paragraphs:
        first_word = next(words, None)
        tops.append(first_word["top"] if first_word else 0.0)
        for _ in range(max(len(paragraph.split()) - 1, 0)):
            next(words, None)
    return tops


def load_pdf(
    path: str, describe_figure: Callable[[bytes], str] | None = None, text_only: bool = False
) -> CanonicalDoc:
    """`describe_figure`, when provided, is called with each embedded
    image's raw bytes and must return a short text description -- used to
    replace the `[FIGURE: none]` placeholder with real content (see
    app/vision/orchestrator_vision_client.py). None (the default) preserves
    the original placeholder-only behavior exactly. A describe_figure
    failure for one image must not abort the whole document -- caught and
    falls back to the placeholder for that image only.

    `text_only` (default False, byte-identical to every call site that
    predates this flag): skips page.find_tables() (pdfplumber's dominant
    per-page cost) and the pypdf image-enumeration pass -- for a caller that
    only needs each page's real TEXT (see app/loaders/docx_pagination.py's
    page-alignment use, which converts a docx to PDF purely to borrow this
    function's already-correct per-page text extraction, and has no use for
    the converted PDF's own tables/figures)."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF, sha256=sha256)

    blocks: list[Block] = []
    tables: list[Table] = []
    figures: list[Figure] = []
    block_id = 0
    table_id = 0
    figure_id = 0

    with pdfplumber.open(path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            # §12/§13: table bboxes (page.find_tables()) drive BOTH fixes at
            # once -- (a) filtering table-region chars out before
            # extract_text() stops table cell text ALSO becoming a duplicate
            # paragraph block (previously page.extract_text() and
            # page.extract_tables() both read the same page unfiltered); (b)
            # each table's bbox top, merged by position against each
            # paragraph's own top (_paragraph_tops), gives tables a real
            # document-order slot instead of the previous (0,0) placeholder.
            # text_only skips this (pdfplumber's dominant per-page cost) --
            # see load_pdf's own docstring. found_tables/table_bboxes empty
            # means filtered_page falls back to the unfiltered page below,
            # same as a page with no tables at all.
            found_tables = [] if text_only else page.find_tables()
            table_bboxes = [t.bbox for t in found_tables]
            filtered_page = page.filter(lambda obj: not _inside_any_bbox(obj, table_bboxes)) if table_bboxes else page

            text = filtered_page.extract_text() or ""
            paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
            tops = _paragraph_tops(filtered_page, paragraphs)

            page_tables: list[Table] = []
            for found_table in found_tables:
                # Bare TableCells, no styling -- real PDF style/span
                # extraction (merge detection via bbox comparison, bold via
                # fontname, background via page.rects overlap) is Phase 4,
                # deliberately out of scope here. `cell or ""` already
                # collapses pdfplumber's `None` (which can mean either a
                # genuine gap OR a spanned position, see
                # docs/superpowers/specs/2026-08-12-table-fidelity-design.md)
                # to plain text -- correct for now since nothing downstream
                # reads colspan/rowspan for a PDF table yet, but Phase 4 must
                # NOT reuse this line verbatim, since it discards exactly the
                # bbox-presence signal that disambiguates span from gap.
                cells: list[list[TableCell]] = [[TableCell(text=cell or "") for cell in row] for row in found_table.extract()]
                page_tables.append(
                    Table(id=f"t{table_id}", cells=cells, source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0, page=page_number))
                )
                table_id += 1

            # pdfplumber's own page.images gives each image region's bbox
            # (for real-position ordering, same as tables above) but not a
            # standalone-decodable image file; pypdf's page.images gives the
            # real decodable bytes describe_figure needs but no position.
            # Best-effort correspondence: pdfplumber and pypdf both walk a
            # page's images in the same underlying content-stream order, so
            # pairing them positionally is the same kind of documented
            # approximation as a table's synthetic offset slot below -- not
            # a guaranteed identity, but the best available without a much
            # heavier cross-reference by image XObject name. If the two
            # libraries disagree on image count for this page (rare --
            # inline vs. XObject images can be counted differently), every
            # pypdf image is still captured (matching pre-fix behavior of
            # never dropping an image), just without a real position for
            # any index past what pdfplumber reported.
            # text_only skips the pypdf image-enumeration pass too -- see
            # load_pdf's own docstring. An empty page_images list here
            # degrades to the exact same code path a page with zero images
            # already takes below.
            page_images: list[tuple[float, object]] = []
            if not text_only:
                pypdf_page = cached_pdf_reader(path).pages[page_number - 1]
                plumber_tops = [im["top"] for im in page.images]
                page_images = [
                    (plumber_tops[i] if i < len(plumber_tops) else 0.0, pypdf_image)
                    for i, pypdf_image in enumerate(pypdf_page.images)
                ]

            # Merge paragraphs, tables, and images into real document order
            # by top position, then walk that merged order assigning ONE
            # shared monotonically increasing offset counter across all
            # three -- same technique docx_loader.py's body-walk uses,
            # adapted for pdf's lack of a single ordered element stream:
            # paragraph offsets are real char-length spans (unchanged from
            # before); a table or image gets a single synthetic slot in the
            # same counter (neither has a natural text length here, same as
            # before -- only their ORDER relative to paragraphs is new, not
            # a real char span). Previously every image on a page was always
            # appended after ALL of that page's paragraphs/tables regardless
            # of its real position -- interleaving them here gives each
            # figure the same real-position treatment tables already got.
            merged = sorted(
                [("paragraph", top, paragraph) for top, paragraph in zip(tops, paragraphs)]
                + [("table", bbox[1], table) for bbox, table in zip(table_bboxes, page_tables)]
                + [("image", top, pypdf_image) for top, pypdf_image in page_images],
                key=lambda entry: entry[1],
            )
            offset = 0
            for kind, _top, item in merged:
                if kind == "paragraph":
                    start = offset
                    end = start + len(item)
                    offset = end + 1
                    blocks.append(
                        Block(
                            id=f"b{block_id}",
                            kind=BlockKind.PARAGRAPH,
                            text=item,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                    block_id += 1
                elif kind == "table":
                    start = offset
                    end = start + 1
                    offset = end
                    table = item
                    # Re-keys the SAME table (built above with a real bbox-
                    # ordered page but a placeholder source_ref) with its
                    # real document-order offset -- carries every field
                    # forward (not just plain text), so this stays a no-op
                    # for content/styling once Phase 4 adds real PDF style
                    # extraction to the table-building pass above.
                    tables.append(
                        Table(
                            id=table.id,
                            cells=table.cells,
                            column_widths=table.column_widths,
                            border_style=table.border_style,
                            style_provenance=table.style_provenance,
                            caption=table.caption,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                else:
                    start = offset
                    end = start + 1
                    offset = end
                    pypdf_image = item
                    caption = None
                    if describe_figure is not None:
                        try:
                            caption = describe_figure(pypdf_image.data)
                        except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole document
                            caption = None
                    figures.append(
                        Figure(
                            id=f"f{figure_id}",
                            caption=caption,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                    blocks.append(
                        Block(
                            id=f"b{block_id}",
                            kind=BlockKind.FIGURE,
                            text=f"[FIGURE: {caption or 'none'}]",
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                    block_id += 1
                    figure_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
