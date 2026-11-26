import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { deleteIngestedDocument, listIngestedDocuments, type IngestedDocument } from '../api/kb';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Skeleton } from '../ui/Skeleton';
import { KbUnlistedContentDialog } from './KbUnlistedContentDialog';
import { formatDate } from '../utils/formatDateTime';
import { plural } from '../utils/plural';

type LoadState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; documents: IngestedDocument[] };
type Filter = 'legacy' | 'unsupported' | null;

const LABEL: Record<'legacy' | 'unsupported', { word: string; why: string }> = {
  legacy: {
    word: 'Legacy',
    why: 'Added before req2ado recorded which SharePoint library it came from, so the folder tree below cannot find it. Remove it here.',
  },
  unsupported: {
    word: 'Not supported',
    why: 'req2ado does not read this type of file, so it adds nothing to your jobs. Remove it here.',
  },
};

// What the knowledge base already holds, read from this app's own record of ingested files. It needs no SharePoint connection, so a user whose
// token has expired can still see, and clean up, what their With AI review jobs are grounded against. Every file can be removed here (owner
// finding, 2026-11-26): a file the folder tree below cannot reach -- added before its library was recorded ("Legacy"), or of a type req2ado
// does not read ("Not supported") -- used to stay and keep grounding scoring. Those two kinds are labelled, can be shown alone, and removed
// together after one confirmation. Adding stays in the folder tree. `refreshKey` changes after a file is added or removed below: the list is
// read again in place, keeping what is shown until the new answer lands. `onRemoved` reports what a removal did, for the page to announce.
export function KbIngestedList({
  refreshKey = 0,
  onRemoved,
}: {
  refreshKey?: number;
  onRemoved?: (summary: { removed: number; failed: string[] }) => void;
}): React.ReactElement {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [checkOpen, setCheckOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>(null);
  const [pending, setPending] = useState<IngestedDocument[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [refreshKey, reloadKey]);

  if (state.kind === 'loading') return <Skeleton className="h-16 w-full" />;
  if (state.kind === 'error') return <Alert severity="error">Couldn't load the documents in your knowledge base. Try again in a moment.</Alert>;

  const counts = {
    legacy: state.documents.filter((d) => d.status === 'legacy').length,
    unsupported: state.documents.filter((d) => d.status === 'unsupported').length,
  };
  // A filter whose files are all gone falls away with its chip.
  const activeFilter = filter && counts[filter] > 0 ? filter : null;
  const shown = activeFilter ? state.documents.filter((d) => d.status === activeFilter) : state.documents;

  async function removePending(): Promise<void> {
    if (!pending || removing) return;
    setRemoving(true);
    const failed: string[] = [];
    // One at a time: each removal deletes the file's stored chunks and schedules the knowledge-base profile (and so scoring) to rebuild.
    for (const document of pending) {
      try {
        await deleteIngestedDocument(document.id);
      } catch {
        failed.push(document.name);
      }
    }
    setRemoving(false);
    setPending(null);
    setReloadKey((key) => key + 1);
    onRemoved?.({ removed: pending.length - failed.length, failed });
  }

  const single = pending?.length === 1 ? pending[0] : null;

  return (
    <Card>
      <div className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-title">
            In your knowledge base <span className="font-normal text-ink-3">{state.documents.length.toLocaleString('en-US')}</span>
          </h2>
          <Button variant="ghost" size="sm" onClick={() => setCheckOpen(true)}>
            Check for unlisted content
          </Button>
        </div>
        {(counts.legacy > 0 || counts.unsupported > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {(['legacy', 'unsupported'] as const)
              .filter((kind) => counts[kind] > 0)
              .map((kind) => (
                <Button
                  key={kind}
                  size="sm"
                  variant={activeFilter === kind ? 'primary' : 'outline'}
                  aria-pressed={activeFilter === kind}
                  title={LABEL[kind].why}
                  onClick={() => setFilter(activeFilter === kind ? null : kind)}
                >
                  {`${LABEL[kind].word} · ${counts[kind]}`}
                </Button>
              ))}
            {activeFilter && (
              <Button size="sm" variant="outline" className="ml-auto text-danger-ink" onClick={() => setPending(shown)}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {`Remove all ${shown.length}`}
              </Button>
            )}
          </div>
        )}
        {state.documents.length === 0 ? (
          <p className="text-sm text-ink-2">No documents yet. Browse a folder below and add files to use them as reference.</p>
        ) : (
          <ul aria-label="In your knowledge base" className="flex flex-col divide-y divide-hairline text-sm">
            {shown.map((document) => {
              const label = document.status === 'legacy' || document.status === 'unsupported' ? LABEL[document.status] : null;
              return (
                <li key={document.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                  <span dir="auto" className="min-w-0 flex-1 truncate font-medium text-ink-1">
                    {document.name}
                  </span>
                  {label && (
                    <span className="text-xs font-medium text-warning-ink" title={label.why}>
                      {label.word}
                    </span>
                  )}
                  <span className="text-xs text-ink-3">
                    {typeof document.chunkCount === 'number' ? plural(document.chunkCount, 'chunk') : 'chunks not counted'}
                  </span>
                  <span className="text-xs text-ink-3">{document.retrievalMode === 'always_include' ? 'Always included' : 'Used when relevant'}</span>
                  <span className="text-xs text-ink-3">Added {formatDate(document.ingestedAt)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${document.name} from your knowledge base`}
                    title="Remove from your knowledge base"
                    onClick={() => setPending([document])}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => !open && !removing && setPending(null)}
        title={single ? 'Remove this document from the knowledge base?' : `Remove ${pending?.length ?? 0} files from the knowledge base?`}
        description={
          single ? (
            <>
              <strong>
                <bdi dir="auto">{single.name}</bdi>
              </strong>{' '}
              will no longer be judged against or cited by With AI review jobs. This deletes its stored content and cannot be undone.
            </>
          ) : (
            <>
              These {pending?.length ?? 0} files will no longer be judged against or cited by With AI review jobs. This deletes their stored
              content and cannot be undone.
            </>
          )
        }
        confirmLabel={single ? 'Remove document' : `Remove ${pending?.length ?? 0} files`}
        onConfirm={() => void removePending()}
        isConfirming={removing}
        variant="destructive"
      />
      <KbUnlistedContentDialog open={checkOpen} onOpenChange={setCheckOpen} />
    </Card>
  );
}
