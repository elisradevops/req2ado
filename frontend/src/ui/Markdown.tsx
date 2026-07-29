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
    <a href={href} target="_blank" rel="noreferrer" className="text-navy-600 underline underline-offset-2 hover:text-navy-700">
      {children}
    </a>
  ),
  code: ({ children }) => <code className="rounded-[3px] bg-surface-alt px-1 py-0.5 font-mono text-[12.5px] text-ink-1">{children}</code>,
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
