"""Where a requirement sits in its document, as text for the chat prompt.

Built from what the job already holds for the item (its parents, its siblings, its trace links, its figures and tables); nothing
here reads the source document, which is not kept after a job. Every part is capped, so the pack stays small whatever the document
looks like, and the tail (figures, tables) is what gives way first."""
from __future__ import annotations

from app.leveling.description_text import description_for_model

MAX_CONTEXT_CHARS = 3_000
_PARENT_DESCRIPTION_CHARS = 400
_MAX_SIBLINGS = 12
_MAX_LINKED = 8
_MAX_CAPTIONED = 6
_TITLE_CHARS = 120
_CAPTION_CHARS = 200


def _clip(text: object, limit: int) -> str:
    flat = " ".join(str(text).split()) if isinstance(text, str) else ""
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def _dicts(value: object) -> list[dict]:
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def render_context_pack(context: dict | None) -> str | None:
    """None when there is nothing to say, so a prompt without context stays free of an empty section."""
    if not isinstance(context, dict):
        return None
    lines: list[str] = []
    name = _clip(context.get("documentName"), _TITLE_CHARS)
    if name:
        lines.append(f"Document: {name}")
    for parent in _dicts(context.get("parents")):
        title = _clip(parent.get("title"), _TITLE_CHARS)
        if not title:
            continue
        kind = _clip(parent.get("type"), 20) or "Parent"
        description = _clip(description_for_model(parent.get("description")), _PARENT_DESCRIPTION_CHARS)
        lines.append(f"{kind}: {title}" + (f" -- {description}" if description else ""))
    siblings = [t for t in (_clip(s.get("title"), _TITLE_CHARS) for s in _dicts(context.get("siblings"))) if t][:_MAX_SIBLINGS]
    if siblings:
        lines.append("Neighbouring items under the same parent: " + "; ".join(siblings))
    linked = [
        f"{_clip(link.get('relation'), 40) or 'Related'}: {title}"
        for link in _dicts(context.get("linked"))
        if (title := _clip(link.get("title"), _TITLE_CHARS))
    ][:_MAX_LINKED]
    if linked:
        lines.append("Linked items: " + "; ".join(linked))
    figures = [
        _clip(f.get("name"), _TITLE_CHARS) + (f" ({caption})" if (caption := _clip(f.get("caption"), _CAPTION_CHARS)) else "")
        for f in _dicts(context.get("figures"))
        if _clip(f.get("name"), _TITLE_CHARS) or _clip(f.get("caption"), _CAPTION_CHARS)
    ][:_MAX_CAPTIONED]
    if figures:
        lines.append("Figures of this item: " + "; ".join(figures))
    tables = [t for t in (_clip(x.get("caption"), _CAPTION_CHARS) for x in _dicts(context.get("tables"))) if t][:_MAX_CAPTIONED]
    if tables:
        lines.append("Tables of this item: " + "; ".join(tables))
    if not lines:
        return None
    text = "Where this item sits in the document (keep the item consistent with its surroundings):\n" + "\n".join(lines)
    return text if len(text) <= MAX_CONTEXT_CHARS else text[: MAX_CONTEXT_CHARS - 1].rstrip() + "…"
