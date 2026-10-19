"""The portable strict-schema rules: what a response schema may use so that BOTH Azure OpenAI structured outputs and
Anthropic structured outputs accept it (the models behind the proxy come from both vendors).

Rules (from the vendors' structured-output documentation, intersected):
  * the root is an object;
  * every object lists all its properties as required and sets `additionalProperties: false`;
  * no free-form object (an object without `properties`): a map must be an array of {key, value} objects;
  * no numeric, string or array constraints, no `format`, no `uniqueItems`, no `$ref` or recursion;
  * `enum` values are scalars;
  * at most 100 properties in total and 5 levels of nesting.

The same rules, with the same test vectors (`shared/test-vectors/portable-schema.json`), live in the orchestrator
(`portable-schema.ts`), so a schema is judged the same way on both sides."""
from __future__ import annotations

FORBIDDEN_KEYWORDS = (
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "pattern", "format",
    "minItems", "maxItems", "uniqueItems", "contains", "minContains", "maxContains",
    "patternProperties", "propertyNames", "minProperties", "maxProperties", "$ref", "$defs", "definitions",
)
MAX_PROPERTIES = 100
MAX_DEPTH = 5


def portable_schema_violations(schema: dict) -> list[str]:
    """Sorted violation codes; empty when the schema is portable. A code is `<json-pointer>:<rule>` for a location, or a
    bare `root_not_object` / `too_many_properties` / `too_deep` for a whole-schema rule."""
    found: set[str] = set()
    counts = {"properties": 0, "depth": 0}
    if schema.get("type") != "object":
        found.add("root_not_object")
    _walk(schema, "", 1, found, counts)
    if counts["properties"] > MAX_PROPERTIES:
        found.add("too_many_properties")
    if counts["depth"] > MAX_DEPTH:
        found.add("too_deep")
    return sorted(found)


def _walk(node: object, pointer: str, depth: int, found: set[str], counts: dict[str, int]) -> None:
    if not isinstance(node, dict):
        return
    location = pointer or "/"
    for keyword in FORBIDDEN_KEYWORDS:
        if keyword in node:
            found.add(f"{location}:forbidden:{keyword}")
    enum = node.get("enum")
    if isinstance(enum, list) and any(isinstance(value, (dict, list)) for value in enum):
        found.add(f"{location}:enum_not_scalar")
    if node.get("type") == "object" or "properties" in node:
        properties = node.get("properties")
        if not isinstance(properties, dict):
            found.add(f"{location}:free_form_object")
            properties = {}
        else:
            counts["properties"] += len(properties)
            counts["depth"] = max(counts["depth"], depth)
            if node.get("additionalProperties") is not False:
                found.add(f"{location}:object_not_closed")
            if set(node.get("required", [])) != set(properties):
                found.add(f"{location}:not_all_required")
        for name, child in properties.items():
            _walk(child, f"{pointer}/properties/{name}", depth + 1, found, counts)
    items = node.get("items")
    if isinstance(items, dict):
        _walk(items, f"{pointer}/items", depth, found, counts)
    for key in ("anyOf", "allOf", "oneOf"):
        for index, child in enumerate(node.get(key, []) if isinstance(node.get(key), list) else []):
            _walk(child, f"{pointer}/{key}/{index}", depth, found, counts)
