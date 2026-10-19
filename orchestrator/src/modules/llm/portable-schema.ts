// The portable strict-schema rules: what a response schema may use so that BOTH Azure OpenAI structured outputs and
// Anthropic structured outputs accept it (the models behind the proxy come from both vendors). Same rules and the same
// test vectors (`shared/test-vectors/portable-schema.json`) as ingestion's `portable_schema.py`.
//   - the root is an object; every object lists all its properties as required and has `additionalProperties: false`;
//   - no free-form object (a map must be an array of {key, value} objects);
//   - no numeric, string or array constraints, no `format`, no `$ref`/recursion; `enum` values are scalars;
//   - at most 100 properties in total and 5 levels of object nesting.

const FORBIDDEN_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format',
  'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains',
  'patternProperties', 'propertyNames', 'minProperties', 'maxProperties', '$ref', '$defs', 'definitions',
] as const;
const MAX_PROPERTIES = 100;
const MAX_DEPTH = 5;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Sorted violation codes (`<json-pointer>:<rule>`, or a bare whole-schema rule); empty when the schema is portable. */
export function portableSchemaViolations(schema: Json): string[] {
  const found = new Set<string>();
  const counts = { properties: 0, depth: 0 };
  if (schema.type !== 'object') found.add('root_not_object');
  walk(schema, '', 1, found, counts);
  if (counts.properties > MAX_PROPERTIES) found.add('too_many_properties');
  if (counts.depth > MAX_DEPTH) found.add('too_deep');
  return [...found].sort();
}

function walk(node: unknown, pointer: string, depth: number, found: Set<string>, counts: { properties: number; depth: number }): void {
  if (!isObject(node)) return;
  const location = pointer || '/';
  for (const keyword of FORBIDDEN_KEYWORDS) if (keyword in node) found.add(`${location}:forbidden:${keyword}`);
  if (Array.isArray(node.enum) && node.enum.some((value) => typeof value === 'object' && value !== null)) found.add(`${location}:enum_not_scalar`);
  if (node.type === 'object' || 'properties' in node) {
    let properties: Json = {};
    if (!isObject(node.properties)) {
      found.add(`${location}:free_form_object`);
    } else {
      properties = node.properties;
      counts.properties += Object.keys(properties).length;
      counts.depth = Math.max(counts.depth, depth);
      if (node.additionalProperties !== false) found.add(`${location}:object_not_closed`);
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
      const names = Object.keys(properties);
      if (required.size !== names.length || names.some((name) => !required.has(name))) found.add(`${location}:not_all_required`);
    }
    for (const [name, child] of Object.entries(properties)) walk(child, `${pointer}/properties/${name}`, depth + 1, found, counts);
  }
  if (isObject(node.items)) walk(node.items, `${pointer}/items`, depth, found, counts);
  for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
    const children = node[key];
    if (Array.isArray(children)) children.forEach((child, index) => walk(child, `${pointer}/${key}/${index}`, depth, found, counts));
  }
}
