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
// _table_to_html fold-in (ingestion/app/leveling/tree_builder.py), always
// exactly this shape (<table><tr><td>...</td></tr>...</table>, no
// thead/th). Treating this specific pattern as trusted mirrors the
// orchestrator's own write-back carve-out instead of enabling rehype-raw
// (which would treat ALL raw HTML in a description as trusted).
const TABLE_BLOCK_PATTERN = /<table>[\s\S]*?<\/table>/g;

// Reverses Python's html.escape(quote=True), which is what put these
// entities into the cell text in the first place -- &amp; last, so an
// already-escaped "&amp;lt;" doesn't get double-unescaped into "<".
function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseTrustedTableRows(tableHtml: string): string[][] {
  const rowMatches = tableHtml.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  return rowMatches.map((row) => {
    const cellMatches = row.match(/<td>[\s\S]*?<\/td>/g) ?? [];
    return cellMatches.map((cell) => unescapeHtmlEntities(cell.slice('<td>'.length, -'</td>'.length)));
  });
}

// Renders as real <table>/<tr>/<td> elements (never dangerouslySetInnerHTML)
// -- text content goes through React's normal child rendering, so this is
// exactly as safe against injection as any other React output.
function TrustedTable({ tableHtml }: { tableHtml: string }): React.ReactElement {
  const rows = parseTrustedTableRows(tableHtml);
  return (
    <div className="mb-1.5 overflow-x-auto">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="border-b border-hairline px-2.5 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
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
