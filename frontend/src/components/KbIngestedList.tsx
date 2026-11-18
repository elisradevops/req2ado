import { useEffect, useState } from 'react';
import { listIngestedDocuments, type IngestedDocument } from '../api/kb';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';
import { KbUnlistedContentDialog } from './KbUnlistedContentDialog';
import { formatDate } from '../utils/formatDateTime';
import { plural } from '../utils/plural';

type LoadState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; documents: IngestedDocument[] };

// What the knowledge base already holds, read from this app's own record of ingested files. It needs no SharePoint connection, so a user whose
// token has expired can still see what their SURVEY jobs are grounded against. Read-only: adding and removing stay in the folder tree below.
// `refreshKey` changes after a file is added or removed below: the list is read again in place, keeping what is shown until the new answer lands.
export function KbIngestedList({ refreshKey = 0 }: { refreshKey?: number }): React.ReactElement {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [checkOpen, setCheckOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listIngestedDocuments()
      .then((documents) => {
        if (!cancelled) setState({ kind: 'ready', documents });
      })
      .catch(() => {
        // A failed refresh keeps the list already shown; only a first load that fails is an error.
        if (!cancelled) setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error' }));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (state.kind === 'loading') return <Skeleton className="h-16 w-full" />;
  if (state.kind === 'error') return <Alert severity="error">Couldn't load the documents in your knowledge base. Try again in a moment.</Alert>;

  return (
    <Card>
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-title">
            In your knowledge base <span className="font-normal text-ink-3">{state.documents.length.toLocaleString('en-US')}</span>
          </h2>
          <Button variant="ghost" size="sm" onClick={() => setCheckOpen(true)}>
            Check for unlisted content
          </Button>
        </div>
        {state.documents.length === 0 ? (
          <p className="text-sm text-ink-2">No documents yet. Browse a folder below and add files to use them as reference.</p>
        ) : (
          <ul aria-label="In your knowledge base" className="flex flex-col divide-y divide-hairline text-sm">
            {state.documents.map((document) => (
              <li key={document.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                <span dir="auto" className="min-w-0 flex-1 truncate font-medium text-ink-1">
                  {document.name}
                </span>
                <span className="text-xs text-ink-3">
                  {typeof document.chunkCount === 'number' ? plural(document.chunkCount, 'chunk') : 'chunks not counted'}
                </span>
                <span className="text-xs text-ink-3">{document.retrievalMode === 'always_include' ? 'Always included' : 'Used when relevant'}</span>
                <span className="text-xs text-ink-3">Added {formatDate(document.ingestedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <KbUnlistedContentDialog open={checkOpen} onOpenChange={setCheckOpen} />
    </Card>
  );
}
