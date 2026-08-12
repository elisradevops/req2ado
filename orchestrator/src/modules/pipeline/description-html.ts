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
