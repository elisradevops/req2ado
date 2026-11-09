import { marked } from 'marked';

// CommonMark's raw-HTML-passthrough rule treats any `<` immediately
// followed by a letter as the start of a real HTML tag -- a literal "<TBD>"
// placeholder in extracted spec text (confirmed real content pattern in
// this domain) would otherwise silently vanish from the rendered output
// instead of showing as text. Pre-escaping every `<` before parsing closes
// that off while leaving every markdown construct we actually want
// (**bold**, ~~strike~~, - lists, 1. lists) untouched, since none of them
// use `<`.
//
// EXCEPT `<table>...</table>` blocks: ingestion (tree_builder.py's
// _table_to_html) already renders these as trusted, pre-escaped HTML
// (cell text run through html.escape) specifically so ADO's rich-text
// field shows a real table, not a flattened row of text. Escaping the `<`
// here too would turn that HTML into a literal, unreadable line of `&lt;`
// noise in the final ADO work item -- these blocks must reach `marked`
// untouched so CommonMark's raw-HTML-block rule (which recognizes `table`
// as a block-level tag) passes them through as-is.
//
// `<table[^>]*>` (not a bare `<table>`) tolerates attributes on the
// opening tag: table-fidelity work has ingestion emitting real semantic
// HTML inside the block (`<thead>`, `<th>`, `colspan`/`rowspan`,
// `<caption>`) starting now, and will add `style="width:100%; ..."`
// directly on `<table>` itself in a later phase. Nested tags never
// affected matching -- the lazy `[\s\S]*?` already runs to the first
// `</table>` regardless of what's inside -- only the opening tag itself
// needed to stop assuming zero attributes.
const TABLE_BLOCK_PATTERN = /<table[^>]*>[\s\S]*?<\/table>/g;

function escapeAngleBrackets(text: string): string {
  let result = '';
  let lastIndex = 0;
  for (const match of text.matchAll(TABLE_BLOCK_PATTERN)) {
    result += text.slice(lastIndex, match.index).replace(/</g, '&lt;');
    result += match[0];
    lastIndex = match.index! + match[0].length;
  }
  result += text.slice(lastIndex).replace(/</g, '&lt;');
  return result;
}

/**
 * Converts a work item description (plain prose, or markdown authored via
 * chat/edit-mode -- **bold**, *italic*, ~~strikethrough~~, `-`/`1.` lists
 * with nesting) into the HTML Azure DevOps's System.Description field
 * expects. Deliberately emits plain semantic tags (<p>, <ul>, <strong>, ...)
 * with NO inline font-family or color -- ADO's own work-item form already
 * applies its own default rich-text styling (font stack, foreground/
 * background, including dark mode) to whatever markup lives in this field;
 * baking in our own font/color would fight that instead of matching it.
 * `breaks: true` turns a single '\n' (not just a blank line) into a line
 * break, matching what a reviewer typing into a plain <textarea> expects.
 */
export function toAdoDescriptionHtml(text: string): string {
  return marked.parse(escapeAngleBrackets(text), { gfm: true, breaks: true, async: false }) as string;
}

/**
 * A section ingestion generated (not the author's text): proposed acceptance criteria, or a "Needs author input" note. Held apart from
 * `description` so it reaches ADO only when the reviewer accepts it (criteria only; a needs-input note is informational and never written).
 */
export interface DiffProposal {
  kind: 'criteria' | 'needs-input';
  html: string;
}

// Ingestion appends each generated section as one flat <div data-r2a="..."> (escaped text inside, no nested div), after a newline. The shape is
// a contract with ingestion/app/leveling/acceptance_criteria.py (both sides have a test that pins it).
const PROPOSAL_SECTION_PATTERN = /\n?<div data-r2a="(criteria|needs-input)">[\s\S]*?<\/div>/g;

/** Splits every generated section off a description; the first one is the proposal. Without one, the text is returned as given. */
export function splitProposal(description: string): { description: string; proposal: DiffProposal | null } {
  if (typeof description !== 'string') return { description, proposal: null }; // a malformed node: nothing to split, nothing to hide
  let proposal: DiffProposal | null = null;
  const text = description.replace(PROPOSAL_SECTION_PATTERN, (section: string, kind: string) => {
    proposal ??= { kind: kind as DiffProposal['kind'], html: section.replace(/^\n/, '') };
    return '';
  });
  return { description: text, proposal };
}

/**
 * The System.Description to write for a diff entry: the author's text, plus the proposal's HTML (appended as real HTML, not escaped) only
 * when the reviewer accepted a criteria proposal. A diff made before proposals were held apart carries the section inside `description`
 * and no `proposal` key at all: it is stripped and never written.
 */
export function composeAdoDescriptionHtml(entry: { description: string; proposal?: DiffProposal | null; proposalAccepted?: boolean; isManual?: boolean }): string {
  // `proposal` is set (to null when there is none) on every entry of a current diff, and a manual entry is the reviewer's own text.
  const legacy = entry.proposal === undefined && !entry.isManual ? splitProposal(entry.description) : null;
  const text = legacy ? legacy.description : entry.description;
  const body = toAdoDescriptionHtml(text);
  const accepted = entry.proposalAccepted === true && entry.proposal?.kind === 'criteria';
  return accepted ? `${body}${entry.proposal!.html}` : body;
}

/**
 * Undoes ADO's own write-time HTML re-serialization, confirmed via a real
 * round-trip spike against a live work item (see
 * docs/superpowers/specs/2026-08-12-table-fidelity-design.md's Phase 0
 * findings): ADO does NOT store the exact bytes it's sent. It applies
 * exactly 3 cosmetic, non-semantic normalizations on every write --
 * confirmed on both a table-bearing description and a plain `<p>` one, so
 * this isn't table-specific:
 *   1. Unquotes a purely-numeric attribute value: `colspan="3"` -> `colspan=3`.
 *   2. Appends a trailing `;` to a `style="..."` value that doesn't already
 *      end with one.
 *   3. Adds one trailing space inside leaf text content immediately before
 *      a closing tag: `<td>GPU</td>` -> `<td>GPU </td>`.
 * Without reversing these, any comparison against ADO's stored value
 * (jobs.service.ts's validateCreatedTree) false-positives a "mismatch" on
 * literally every real item, since even unstyled plain-prose descriptions
 * hit normalization #3. This is intentionally a set of targeted string
 * reversals, not a general HTML canonicalizer -- broader drift in ADO's
 * serialization behavior should surface as a new confirmed mismatch here,
 * not be silently absorbed by an overly-permissive normalizer.
 */
export function normalizeAdoStoredHtml(storedHtml: string): string {
  return storedHtml
    .replace(/(colspan|rowspan)=(\d+)/g, '$1="$2"') // undo #1: ADO always emits these bare/unquoted; re-quote to match our own generator's output
    .replace(/style="([^"]*);"/g, 'style="$1"') // undo #2: strip the trailing `;` ADO always appends -- our own generator never emits one
    .replace(/ (<\/(?:td|th|p)>)/g, '$1'); // undo #3: drop ADO's added trailing space immediately before these closing tags (only td/th/p confirmed via the spike; extend if another leaf tag is ever caught by this same behavior)
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// One pass, so `&amp;lt;` becomes the text `&lt;` and is never decoded twice. Unknown entities stay as written.
function decodeEntities(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    })
    .replace(/ /g, ' ');
}

// Decoded text re-escaped, so literal text can never be mistaken for a tag.
function canonicalText(text: string): string {
  return decodeEntities(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Entities are decoded once (re-escaped by escapeAttrValue, `& < > "`, the same way on both sides), so `&`, `&amp;` and `&#38;` in an href compare equal
// (ADO stores `?a=1&b=2` as `&amp;`), `&#39;` and `&apos;` match a literal apostrophe, and `&quot;` is how a double quote survives double-quoting.
function canonicalAttrValue(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, ' ').trim();
}

function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ATTRIBUTE_PATTERN = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function canonicalTag(tag: string): { text: string; name: string | null; closing: boolean; selfClosing: boolean } {
  const inner = tag.slice(1, -1);
  const head = /^(\/?)([a-zA-Z][^\s/>]*)/.exec(inner);
  if (!head) return { text: `<${inner.replace(/\s+/g, ' ').trim()}>`, name: null, closing: false, selfClosing: false };
  const name = head[2].toLowerCase();
  const rest = inner.slice(head[0].length);
  const selfClosing = /\/\s*$/.test(rest);
  let attrs = '';
  for (const m of rest.matchAll(ATTRIBUTE_PATTERN)) {
    const attrName = m[1].toLowerCase();
    const rawValue = m[2] ?? m[3] ?? m[4];
    if (rawValue === undefined) {
      attrs += ` ${attrName}`;
      continue;
    }
    let value = canonicalAttrValue(rawValue);
    if (attrName === 'style') {
      value = value
        .split(';')
        .map((part) => part.trim().replace(/\s*:\s*/, ':'))
        .filter((part) => part !== '')
        .join(';');
    }
    attrs += ` ${attrName}="${escapeAttrValue(value)}"`;
  }
  return { text: `<${head[1]}${name}${attrs}${selfClosing ? '/' : ''}>`, name, closing: head[1] === '/', selfClosing };
}

/**
 * Comparison-only canonical form, applied to BOTH the expected and the ADO-stored
 * description. ADO re-serialises HTML on write beyond what normalizeAdoStoredHtml
 * reverses: it encodes apostrophes (`&#39;`), may emit `&nbsp;`, reflows whitespace
 * and rewrites style values. This erases only those cosmetic differences; words,
 * numbers and punctuation stay significant. Never use the result as stored HTML.
 *
 * Single tokenising pass: tags (`<[^<>]*>`, linear) and text are handled separately, so
 * escaped text (`&lt;b&gt;`) can never equal a real tag. Whitespace inside `<pre>` is kept.
 */
export function canonicalizeForCompare(html: string): string {
  const parts = html.split(/(<[^<>]*>)/);
  const tokens: { tag: boolean; text: string; pre: boolean }[] = [];
  let preDepth = 0;
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const tag = canonicalTag(part);
      if (tag.name === 'pre' && !tag.selfClosing) {
        if (tag.closing) preDepth = Math.max(0, preDepth - 1);
        else preDepth += 1;
      }
      tokens.push({ tag: true, text: tag.text, pre: false });
    } else if (part !== '') {
      tokens.push({ tag: false, text: canonicalText(part), pre: preDepth > 0 });
    }
  });
  let out = '';
  tokens.forEach((token, index) => {
    if (token.tag || token.pre) {
      out += token.text;
      return;
    }
    let text = token.text.replace(/\s+/g, ' ');
    if (index === 0 || tokens[index - 1].tag) text = text.replace(/^ /, '');
    if (index === tokens.length - 1 || tokens[index + 1].tag) text = text.replace(/ $/, '');
    out += text;
  });
  return out.trim();
}
