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

// The only inline style ingestion's _table_to_html emits (Phase 1). Anything
// else in a `style="..."` attribute -- a color, a url(), an injection
// attempt riding along on a crafted source value -- is silently dropped.
// This is the file's one place that touches a `style` attribute at all, so
// the allowlist is intentionally this narrow rather than a general CSS
// parser.
type SafeCellStyle = { textAlign: 'left' | 'center' | 'right' | 'justify' };
const ALLOWED_TEXT_ALIGN_VALUES = new Set<string>(['left', 'center', 'right', 'justify']);

// Extracts ONLY `text-align` out of a raw `style` attribute string and
// returns a safe React style object built from a validated, closed enum --
// never interpolates the raw attribute value into anything that becomes a
// DOM attribute or style (the design spec's explicit security requirement).
// The `[a-z]+` capture group can only ever pick up a bare lowercase word --
// no colons/parens/semicolons -- so a crafted value like
// `background:url(javascript:alert(1))` or an out-of-enum alignment word
// simply fails the Set membership check below and is ignored, not passed
// through.
function parseSafeCellStyle(styleAttr: string | null): SafeCellStyle | undefined {
  if (!styleAttr) return undefined;
  const match = /\btext-align\s*:\s*([a-z]+)/i.exec(styleAttr);
  const value = match?.[1]?.toLowerCase();
  return value && ALLOWED_TEXT_ALIGN_VALUES.has(value) ? { textAlign: value as SafeCellStyle['textAlign'] } : undefined;
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

  return (
    <div className="mb-1.5 overflow-x-auto">
      <table className="w-full text-sm">
        {captionText && <caption className="pb-1 text-left text-xs text-ink-2">{captionText}</caption>}
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
