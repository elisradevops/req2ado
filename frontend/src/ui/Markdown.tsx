import { Fragment } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Compact variant of Wiki.tsx's own MARKDOWN_COMPONENTS map, sized for a
// chat bubble rather than a full page (tighter margins, smaller type) --
// same app type scale/tokens, not a second visual language. react-markdown
// renders to real React elements (never dangerouslySetInnerHTML), so this
// is safe against arbitrary/untrusted text (e.g. an LLM reply) by
// construction -- no rehype-raw is used, so raw HTML in the source is
// escaped, not executed.
const CHAT_MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-1.5 text-sm leading-relaxed text-ink-1 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink-1">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="mb-1.5 flex list-disc flex-col gap-0.5 pl-4 text-sm text-ink-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-1.5 flex list-decimal flex-col gap-0.5 pl-4 text-sm text-ink-1 last:mb-0">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2 hover:text-accent-hover">
      {children}
    </a>
  ),
  code: ({ children }) => <code className="rounded-sm bg-surface-alt px-1 py-0.5 font-mono text-xs text-ink-1">{children}</code>,
  del: ({ children }) => <del className="text-ink-2">{children}</del>,
};

// remarkGfm: without it, react-markdown only supports CommonMark -- GFM
// extensions (~~strikethrough~~, which this app's description-editing UX
// explicitly advertises as supported, plus tables/autolinks) fall through
// as literal `~~text~~` instead of rendering as struck-through text
// (confirmed live: this was the actual bug before adding the plugin).
export function Markdown({ children }: { children: string }): React.ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={CHAT_MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}

// Matches orchestrator's description-html.ts TABLE_BLOCK_PATTERN exactly --
// the only raw HTML a description ever legitimately contains: BASELINE's
// _table_to_html fold-in (ingestion/app/leveling/tree_builder.py). Tolerates
// attributes on the opening <table> tag (e.g. a future table-level style)
// since the emitted shape now includes <thead>/<th>/colspan/rowspan/caption
// and per-cell alignment styles -- the bare `<table>`-only pattern this
// replaced would silently stop matching the moment ingestion added any of
// that, dumping the whole block through the untrusted markdown path as
// literal escaped text (the exact known-issues #17 bug class).
const TABLE_BLOCK_PATTERN = /<table[^>]*>[\s\S]*?<\/table>/g;

// Phase 1 allowlisted only `text-align`. Phase 2 extends the same
// one-known-property-at-a-time philosophy to background-color/color/border
// (cell-level) and width/border-collapse (table/col-level, below) -- each
// gets its own narrowly-targeted regex plus a strict value check, never a
// general CSS parser and never a pass-through of the raw attribute string.
// Anything else in a `style="..."` attribute -- a `background:url(...)`, an
// injection attempt riding along on a crafted source value -- is silently
// dropped. This is the file's one place that touches a `style` attribute at
// all, so the allowlist is intentionally this narrow rather than a general
// CSS parser. See the design spec's "Security: style-attribute injection"
// section: a crafted value riding along in a trusted-looking style
// attribute must never reach the DOM as anything other than a value that
// already passed one of these closed checks.
type SafeCellStyle = {
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  backgroundColor?: string;
  color?: string;
  border?: string;
};
const ALLOWED_TEXT_ALIGN_VALUES = new Set<string>(['left', 'center', 'right', 'justify']);

// Closed format ingestion is documented to emit for any color value: exactly
// 6 hex digits, nothing else. No named colors ("red"), no rgb()/rgba()/hsl(),
// no CSS custom properties (var(--x)) -- any of those would need their own
// bespoke parser to validate safely, and none of them are in ingestion's
// emitted vocabulary, so they are simply unsupported rather than
// half-validated.
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

// `background-color` is matched directly by name -- nothing else in a style
// string can be confused for it.
const BACKGROUND_COLOR_DECLARATION_PATTERN = /\bbackground-color\s*:\s*(#[0-9a-fA-F]{6})\b/i;

// `color` is trickier: "background-color" *contains* "color" as a literal
// substring, and a naive `/\bcolor\s*:/` would still satisfy `\b` right
// before the "color" inside "background-color" (a hyphen is a non-word
// character, so a word boundary exists there too). Without the negative
// lookbehind below, a cell with ONLY `background-color` set would
// spuriously also populate `color` by misreading part of that same
// declaration -- fabricating a text color the source never specified. The
// lookbehind requires that "color" NOT be immediately preceded by the
// literal text "background-", which is exactly and only the collision this
// needs to rule out.
const TEXT_COLOR_DECLARATION_PATTERN = /(?<!background-)\bcolor\s*:\s*(#[0-9a-fA-F]{6})\b/i;

// Extracts one color property by name and re-validates the captured value
// against the closed hex format -- belt-and-suspenders with the capture
// group's own `#[0-9a-fA-F]{6}` restriction, matching this file's existing
// habit of never trusting a single layer of validation for a value that
// flows into a DOM style.
function extractValidatedHexColor(styleAttr: string, declarationPattern: RegExp): string | undefined {
  const value = declarationPattern.exec(styleAttr)?.[1];
  return value && HEX_COLOR_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

// Ingestion emits the border property as the exact literal `border: 1px
// solid` and nothing else -- deliberately no color, so the browser's own
// `currentColor` fallback inherits ADO's theme text color and borders adapt
// automatically between light/dark themes (see the design spec's contrast
// section). Anything appended after "1px solid" -- a color, a different
// width or style keyword -- means the value isn't the exact literal
// ingestion emits, so the whole property is ignored rather than attempting
// to parse arbitrary border shorthand (a crafted `border: 1px solid
// red`-style value must never be partially trusted into "at least the width
// and style are fine").
function parseSafeBorder(styleAttr: string): string | undefined {
  const match = /\bborder\s*:\s*1px\s+solid\b([^;]*)/i.exec(styleAttr);
  if (!match) return undefined;
  const trailing = match[1].trim();
  return trailing.length === 0 ? '1px solid' : undefined;
}

// Extracts ONLY `text-align`, `background-color`, `color`, and `border` out
// of a raw `style` attribute string, each independently validated against
// its own closed format, and returns a safe React style object assembled
// from validated primitives only -- never the raw attribute value itself.
// Any unrecognized property (a `background:url(...)`, an out-of-enum
// alignment word, an out-of-format color, a border with anything appended)
// is simply absent from the returned object rather than passed through.
function parseSafeCellStyle(styleAttr: string | null): SafeCellStyle | undefined {
  if (!styleAttr) return undefined;
  const style: SafeCellStyle = {};

  const alignValue = /\btext-align\s*:\s*([a-z]+)/i.exec(styleAttr)?.[1]?.toLowerCase();
  if (alignValue && ALLOWED_TEXT_ALIGN_VALUES.has(alignValue)) {
    style.textAlign = alignValue as SafeCellStyle['textAlign'];
  }

  const backgroundColor = extractValidatedHexColor(styleAttr, BACKGROUND_COLOR_DECLARATION_PATTERN);
  if (backgroundColor) style.backgroundColor = backgroundColor;

  const color = extractValidatedHexColor(styleAttr, TEXT_COLOR_DECLARATION_PATTERN);
  if (color) style.color = color;

  const border = parseSafeBorder(styleAttr);
  if (border) style.border = border;

  return Object.keys(style).length > 0 ? style : undefined;
}

// `width` is validated as a percentage in [0, 100] -- ingestion only ever
// emits fractions-of-table-width converted to percentages (see the design
// spec's "Layout overflow" section: absolute source units like twips/EMU
// must never reach the renderer), so px/em/calc()/anything else is simply
// not a shape ingestion produces and is rejected rather than half-supported.
// This applies to `<col>` and `<table>` elements only -- `<td>`/`<th>` never
// carry a width in the emitted shape, so this is intentionally a separate
// function from `parseSafeCellStyle` rather than folded into it.
const WIDTH_PERCENT_DECLARATION_PATTERN = /\bwidth\s*:\s*(\d{1,3})%/i;
function parseSafeWidthPercent(styleAttr: string | null): string | undefined {
  if (!styleAttr) return undefined;
  const n = Number.parseInt(WIDTH_PERCENT_DECLARATION_PATTERN.exec(styleAttr)?.[1] ?? '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? `${n}%` : undefined;
}

// `border-collapse: collapse` is the one other table-level property
// ingestion emits (alongside `width: 100%`) -- validated as an exact
// literal match, the same closed-enum-of-one discipline as everything else
// here.
const BORDER_COLLAPSE_DECLARATION_PATTERN = /\bborder-collapse\s*:\s*collapse\b/i;

type SafeTableStyle = { width?: string; borderCollapse?: 'collapse' };

// Table-level style: only `width` and `border-collapse` are recognized --
// intentionally not the same allowlist as a cell's (a table has no
// background/color/border of its own in the emitted shape).
function parseSafeTableStyle(styleAttr: string | null): SafeTableStyle | undefined {
  if (!styleAttr) return undefined;
  const style: SafeTableStyle = {};
  const width = parseSafeWidthPercent(styleAttr);
  if (width) style.width = width;
  if (BORDER_COLLAPSE_DECLARATION_PATTERN.test(styleAttr)) style.borderCollapse = 'collapse';
  return Object.keys(style).length > 0 ? style : undefined;
}

// <col>-level style: only `width` is recognized.
function parseSafeColStyle(styleAttr: string | null): { width?: string } | undefined {
  const width = parseSafeWidthPercent(styleAttr);
  return width ? { width } : undefined;
}

// HTML's own limit for colspan is 1000 (rowspan 65534) -- reuse the smaller,
// stricter bound for both so a pathological or hand-crafted value can never
// blow up table layout.
const MAX_SPAN = 1000;

// Reads colspan/rowspan straight off the attribute string rather than
// trusting the DOM's own reflected `.colSpan`/`.rowSpan` IDL properties, so
// the validation here is explicit rather than an assumption about
// browser-internal clamping. Absent, non-integer, and non-positive values
// all return undefined (React then falls back to the HTML default of 1,
// matching "no colspan/rowspan attribute present" -- Phase 1 only emits the
// attribute at all when N > 1).
function parseSafeSpan(el: Element, attr: 'colspan' | 'rowspan'): number | undefined {
  const raw = el.getAttribute(attr);
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, MAX_SPAN);
}

// Renders one <tr>'s <th>/<td> children as real React cells.
// `rowEl.cells` is the standard HTMLTableRowElement IDL collection of only
// th/td children, in source order -- a grid position that ingestion
// SPANNED (absorbed by a preceding cell's colspan/rowspan) simply has no
// <td>/<th> in the source markup at all, so it naturally produces no React
// element here either; a genuine gap still has a real (empty) <td> and
// renders as an empty cell. No special-casing needed for either case.
function renderRow(rowEl: HTMLTableRowElement, rowKey: number): React.ReactElement {
  return (
    <tr key={rowKey}>
      {Array.from(rowEl.cells).map((cellEl, cellIndex) => {
        const colSpan = parseSafeSpan(cellEl, 'colspan');
        const rowSpan = parseSafeSpan(cellEl, 'rowspan');
        const style = parseSafeCellStyle(cellEl.getAttribute('style'));
        // .textContent decodes any HTML entities in the source (e.g.
        // "&lt;script&gt;" becomes the literal string "<script>") as a
        // plain JS string, not as markup -- putting that string into a
        // React text child is then re-escaped safely by React's own JSX
        // text-child rendering on output, so this can never become a real
        // element or execute (see Markdown.test.tsx's injection-safety
        // tests).
        const text = cellEl.textContent ?? '';
        return cellEl.tagName === 'TH' ? (
          <th
            key={cellIndex}
            colSpan={colSpan}
            rowSpan={rowSpan}
            style={style}
            className="border-b border-hairline px-2.5 py-1.5 text-left font-semibold"
          >
            {text}
          </th>
        ) : (
          <td key={cellIndex} colSpan={colSpan} rowSpan={rowSpan} style={style} className="border-b border-hairline px-2.5 py-1.5">
            {text}
          </td>
        );
      })}
    </tr>
  );
}

// Renders as real <table>/<thead>/<tbody>/<tr>/<th>/<td>/<caption> elements
// (never dangerouslySetInnerHTML) -- text content goes through React's
// normal child rendering, so this is exactly as safe against injection as
// any other React output. Parses the trusted block with the browser's own
// DOMParser instead of regex-matching literal tag substrings, so it walks
// the REAL shape ingestion emits (any attributes on <table>, <th> vs <td>,
// nested <thead>/<tbody>, colspan/rowspan, <caption>) structurally, instead
// of needing a new special case every time a feature adds an HTML shape --
// this is intentionally scoped to exactly that one shape (table ->
// thead/tbody -> tr -> th/td -> text), not a general-purpose sanitizing
// HTML-to-React converter.
function TrustedTable({ tableHtml }: { tableHtml: string }): React.ReactElement {
  const doc = new DOMParser().parseFromString(tableHtml, 'text/html');
  const tableEl = doc.querySelector('table');
  if (!tableEl) {
    // Defensive only: TABLE_BLOCK_PATTERN already guarantees this string
    // matched `<table...>...</table>`, so this branch should be
    // unreachable -- but a malformed fragment should never crash the panel.
    return <></>;
  }

  const headRows = tableEl.tHead ? Array.from(tableEl.tHead.rows) : [];
  // tBodies[0]: Phase 1's shape wraps all non-header rows in exactly one
  // <tbody>. The HTML5 tree-construction algorithm also auto-wraps any
  // stray <tr> that isn't already inside a thead/tbody/tfoot into an
  // implicit <tbody> during parsing, so this also covers today's
  // pre-rewrite bare <table><tr><td> shape with zero special-casing.
  const bodyRows = tableEl.tBodies[0] ? Array.from(tableEl.tBodies[0].rows) : [];
  const captionText = tableEl.caption?.textContent ?? '';
  const tableStyle = parseSafeTableStyle(tableEl.getAttribute('style'));

  // <colgroup> sits directly under <table>, alongside (not inside)
  // <thead>/<tbody>. `.children` filtered to COL (not
  // `.querySelectorAll('col')`, which would also reach a stray <col> nested
  // somewhere unexpected) reads only colgroup's own direct <col> children,
  // each with its own independently-validated width -- absent for today's
  // pre-Phase-2 shape with no <colgroup> at all, same zero-special-casing
  // default as headRows/bodyRows above.
  const colgroupEl = tableEl.querySelector('colgroup');
  const colEls = colgroupEl ? Array.from(colgroupEl.children).filter((el) => el.tagName === 'COL') : [];

  return (
    <div className="mb-1.5 overflow-x-auto">
      <table className="w-full text-sm" style={tableStyle}>
        {captionText && <caption className="pb-1 text-left text-xs text-ink-2">{captionText}</caption>}
        {colEls.length > 0 && (
          <colgroup>
            {colEls.map((colEl, colIndex) => (
              <col key={colIndex} style={parseSafeColStyle(colEl.getAttribute('style'))} />
            ))}
          </colgroup>
        )}
        {headRows.length > 0 && <thead>{headRows.map((row, rowIndex) => renderRow(row, rowIndex))}</thead>}
        <tbody>{bodyRows.map((row, rowIndex) => renderRow(row, rowIndex))}</tbody>
      </table>
    </div>
  );
}

// NodeDetailPanel-only variant: a BASELINE description can mix ordinary
// markdown prose with an embedded trusted <table> fold-in (assemble_description
// joins them with a newline) -- the shared chat `Markdown` above must stay
// raw-HTML-blind for untrusted text, so this splits out only the
// TABLE_BLOCK_PATTERN segments for trusted rendering and leaves everything
// else on the same markdown path as before, matching what
// toAdoDescriptionHtml's TABLE_BLOCK_PATTERN carve-out actually writes to ADO.
export function DescriptionMarkdown({ children }: { children: string }): React.ReactElement {
  const segments = children.split(TABLE_BLOCK_PATTERN);
  const tables = children.match(TABLE_BLOCK_PATTERN) ?? [];
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment && <Markdown>{segment}</Markdown>}
          {tables[index] && <TrustedTable tableHtml={tables[index]} />}
        </Fragment>
      ))}
    </>
  );
}
