import { useEffect, useState, type JSX } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { httpClient } from '../api/httpClient.js';
import { PageHeader } from '../ui/PageHeader';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';

// Maps markdown elements onto this app's own type scale instead of the
// browser's unstyled defaults -- the same purpose MUI Typography variants
// served pre-migration, expressed as Tailwind utility classes.
const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-6 text-2xl font-bold tracking-tight first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-6 text-lg font-bold tracking-tight">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-5 text-base font-semibold">{children}</h3>,
  p: ({ children }) => <p className="mb-3 text-sm leading-relaxed text-ink-2">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-2">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 flex list-decimal flex-col gap-1 pl-5 text-sm text-ink-2">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-navy-600 underline underline-offset-2 hover:text-navy-700">
      {children}
    </a>
  ),
  code: ({ children }) => <code className="rounded-[3px] bg-surface-alt px-1 py-0.5 font-mono text-[13px] text-ink-1">{children}</code>,
  pre: ({ children }) => <pre className="mb-3 overflow-x-auto rounded-sm bg-surface-alt p-3 font-mono text-[13px] text-ink-1">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="mb-3 border-l-2 border-hairline-strong pl-3 text-sm text-ink-2 italic">{children}</blockquote>,
  hr: () => <hr className="my-4 border-hairline" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-hairline-strong bg-surface-alt px-2.5 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-3">{children}</th>,
  td: ({ children }) => <td className="border-b border-hairline px-2.5 py-1.5">{children}</td>,
};

export function Wiki(): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  function load(): void {
    setError(false);
    setContent(null);
    httpClient
      .get('/wiki', { responseType: 'text' })
      .then((response) => setContent(response.data))
      .catch(() => setError(true));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Wiki" description="Guidance for using req2ado" />
      <div className="mx-auto w-full max-w-[720px]">
        {error ? (
          <Alert severity="error">
            <div className="flex items-center justify-between gap-3">
              <span>Couldn't load the guide. Check your connection and try again.</span>
              <Button size="sm" variant="outline" onClick={load}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : content === null ? (
          <Card>
            <div className="flex flex-col gap-2.5 p-4">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </Card>
        ) : (
          <Card>
            <div className="p-4">
              <ReactMarkdown components={MARKDOWN_COMPONENTS}>{content}</ReactMarkdown>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
