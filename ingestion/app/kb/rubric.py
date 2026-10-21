"""The rubric a user is graded against, as the user sees and controls it.

Categories come from the user's knowledge base (derived by the model when the profile is built) or from the built-in default rubric. On top of
either the user can PIN a category (fix its name and pass condition), add one of their own, or remove one. These overrides are the user's
decision, not a sample: they apply to every job, chat turn, rescore and explanation, they survive a rebuild of the profile, and they are part of
the rubric's version (which is part of the job result cache key). A pin matches a category by its name or by any document wording merged into it,
so it keeps holding when a rebuild names the same quality differently."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel, Field

from app.kb.profile import Category, KbProfile, _key

MAX_PINNED = 20
MAX_REMOVED = 30
MAX_NAME = 80
MAX_CONDITION = 600


class RubricPin(BaseModel):
    name: str
    pass_condition: str


class RubricOverrides(BaseModel):
    pinned: list[RubricPin] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.pinned and not self.removed


def rubric_version(base_version: str, overrides: RubricOverrides) -> str:
    parts = [base_version, sorted((_key(p.name), p.name, p.pass_condition) for p in overrides.pinned), sorted(_key(n) for n in overrides.removed)]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:24]


def _wordings(category: Category) -> set[str]:
    return {_key(category.name), *(_key(m) for m in category.merged_from)}


def apply_overrides(base: KbProfile, overrides: RubricOverrides | None) -> KbProfile:
    """The base rubric with the user's pins, additions and removals applied. Unchanged (same version) without overrides."""
    if overrides is None or overrides.empty:
        return base
    removed = {_key(n) for n in overrides.removed}
    pins = {_key(p.name): p for p in overrides.pinned}
    used: set[str] = set()
    categories: list[Category] = []
    for category in base.categories:
        wordings = _wordings(category)
        if wordings & removed:
            continue
        # A pin named exactly like the category wins; otherwise one named like a wording merged into it (it keeps holding when a rebuild
        # names the same quality differently). A pin fixes one category only.
        match = next((k for k in [_key(category.name), *sorted(wordings)] if k in pins and k not in used), None)
        if match is None:
            categories.append(category)
            continue
        used.add(match)
        categories.append(category.model_copy(update={"name": pins[match].name, "pass_condition": pins[match].pass_condition}))
    for pin in overrides.pinned:
        if _key(pin.name) not in used:
            categories.append(Category(name=pin.name, pass_condition=pin.pass_condition, sources=["(pinned)"], merged_from=[pin.name]))
    return base.model_copy(update={"categories": categories, "version": rubric_version(base.version, overrides)})


def rubric_view(effective: KbProfile, base: KbProfile, overrides: RubricOverrides | None) -> dict[str, Any]:
    """What the user is shown: every category with its pass condition, whether it is pinned, where it comes from, and what was removed."""
    overrides = overrides or RubricOverrides()
    pinned = {_key(p.name) for p in overrides.pinned}
    base_wordings = [(_wordings(c), c.name) for c in base.categories]
    removed_keys = {_key(n) for n in overrides.removed}
    categories = []
    base_by_wording: dict[str, Category] = {}
    for base_category in base.categories:
        for wording in _wordings(base_category):
            base_by_wording.setdefault(wording, base_category)
    for category in effective.categories:
        custom = category.sources == ["(pinned)"]
        derived = None if custom else next((base_by_wording[k].pass_condition for k in [_key(category.name), *sorted(_wordings(category))] if k in base_by_wording), None)
        categories.append(
            {
                "name": category.name, "passCondition": category.pass_condition, "guidance": category.guidance, "basePassCondition": derived,
                "pinned": _key(category.name) in pinned, "origin": "custom" if custom else base.source,
                "sources": [] if custom else category.sources, "mergedFrom": category.merged_from,
            }
        )
    return {
        "version": effective.version, "source": base.source, "builtAt": base.built_at, "categories": categories,
        "removed": [name for wordings, name in base_wordings if wordings & removed_keys],
    }


def validate_overrides(pinned: list[dict], removed: list[str]) -> RubricOverrides:
    """The user's list, normalised (spaces collapsed), or a ValueError saying what is wrong with it."""
    def clean(text: object) -> str:
        return " ".join(str(text or "").split())

    if len(pinned) > MAX_PINNED:
        raise ValueError(f"at most {MAX_PINNED} pinned categories")
    if len(removed) > MAX_REMOVED:
        raise ValueError(f"at most {MAX_REMOVED} removed categories")
    pins: list[RubricPin] = []
    seen: set[str] = set()
    for item in pinned:
        name, condition = clean(item.get("name")), clean(item.get("pass_condition"))
        if not name or len(name) > MAX_NAME:
            raise ValueError(f"a category name must be 1-{MAX_NAME} characters")
        if not condition or len(condition) > MAX_CONDITION:
            raise ValueError(f"the pass condition of '{name[:40]}' must be 1-{MAX_CONDITION} characters")
        if _key(name) in seen:
            raise ValueError(f"category '{name[:40]}' is listed twice")
        seen.add(_key(name))
        pins.append(RubricPin(name=name, pass_condition=condition))
    gone = [clean(n) for n in removed if clean(n)]
    clash = next((n for n in gone if _key(n) in seen), None)
    if clash:
        raise ValueError(f"category '{clash[:40]}' is both pinned and removed")
    return RubricOverrides(pinned=pins, removed=gone)
