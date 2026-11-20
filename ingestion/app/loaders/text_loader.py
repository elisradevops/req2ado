from __future__ import annotations

import hashlib
from pathlib import Path

from markdown_it import MarkdownIt

from app.canonical.markup import html_to_markdown
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.loaders.encoding_utils import read_text_degrading, unsupported_encoding_note


def _sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_txt(path: str) -> CanonicalDoc:
    file_path = Path(path)
    text, had_decode_error = read_text_degrading(file_path)
    document = Document(path=path, format=DocumentFormat.TXT, sha256=_sha256_of(file_path))

    blocks: list[Block] = []
    block_id = 0
    if had_decode_error:
        blocks.append(unsupported_encoding_note(path, f"b{block_id}", "utf-8"))
        block_id += 1
    offset = 0
    for paragraph in (p for p in text.split("\n\n") if p.strip()):
        start = text.index(paragraph, offset)
        end = start + len(paragraph)
        offset = end
        blocks.append(
            Block(
                id=f"b{block_id}",
                kind=BlockKind.PARAGRAPH,
                text=paragraph.strip(),
                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
            )
        )
        block_id += 1
    return CanonicalDoc(document=document, blocks=blocks)


def load_markdown(path: str) -> CanonicalDoc:
    file_path = Path(path)
    text, had_decode_error = read_text_degrading(file_path)
    document = Document(path=path, format=DocumentFormat.MD, sha256=_sha256_of(file_path))

    md = MarkdownIt()
    tokens = md.parse(text)

    blocks: list[Block] = []
    block_id = 0
    if had_decode_error:
        blocks.append(unsupported_encoding_note(path, f"b{block_id}", "utf-8"))
        block_id += 1
    offset = 0
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token.type == "heading_open":
            level = int(token.tag[1])
            inline = tokens[i + 1]
            content = inline.content
            start = text.index(content, offset)
            end = start + len(content)
            offset = end
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.HEADING,
                    text=content,
                    heading_level=level,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            block_id += 1
            i += 3
            continue
        if token.type == "paragraph_open":
            # A paragraph nested directly inside a list item is a list item's
            # text, not a standalone paragraph (markdown-it wraps "loose" list
            # item content in its own paragraph_open/inline/paragraph_close).
            in_list_item = i > 0 and tokens[i - 1].type == "list_item_open"
            inline = tokens[i + 1]
            content = inline.content
            start = text.index(content, offset)
            end = start + len(content)
            offset = end
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.LIST_ITEM if in_list_item else BlockKind.PARAGRAPH,
                    text=content,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            block_id += 1
            i += 3
            continue
        if token.type in ("html_block", "fence", "code_block") and token.map:
            # Raw HTML and code are content of the item they sit under: an HTML body (a tracker's export saved as Markdown) is the item's
            # whole description. HTML becomes Markdown here; code is kept as a fenced block, word for word.
            if token.type == "html_block":
                content = html_to_markdown(token.content).strip()
            else:
                fence = f"```{token.info.strip()}\n" if token.type == "fence" else "```\n"
                content = f"{fence}{token.content.rstrip(chr(10))}\n```"
            if content:
                lines = text.splitlines(keepends=True)
                start = sum(len(line) for line in lines[: token.map[0]])
                end = sum(len(line) for line in lines[: token.map[1]])
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.PARAGRAPH,
                        text=content,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
                block_id += 1
        i += 1

    return CanonicalDoc(document=document, blocks=blocks)
