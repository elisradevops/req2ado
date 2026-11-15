import { useMemo } from 'react';
import { Ban, CircleCheck, CircleX, Clock, Minus, Pause, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { KbIngestBatch, KbIngestItem, KbIngestItemState } from '../api/kb';
import { cn } from '../lib/cn';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ProgressBar } from '../ui/ProgressBar';
import { Spinner } from '../ui/Spinner';

// Shows the batch the server is working through: how far it is, what each file is doing, and the few things the user can
// do about it (cancel, resume, retry the failures). State is always said in words and an icon, never by colour alone. It
// only shows what it is given: the polling lives in kbIngestStore.

const FILE_STATE: Record<KbIngestItemState, { word: string; Icon: LucideIcon | 'spinner'; className: string }> = {
  queued: { word: 'Waiting', Icon: Clock, className: 'text-ink-3' },
  running: { word: 'Adding…', Icon: 'spinner', className: 'text-live' },
  added: { word: 'Added', Icon: CircleCheck, className: 'text-ok-ink' },
  unchanged: { word: 'Unchanged', Icon: CircleCheck, className: 'text-ink-3' },
  failed: { word: 'Failed', Icon: CircleX, className: 'text-danger-ink' },
  skipped: { word: 'Skipped', Icon: Minus, className: 'text-ink-3' },
  cancelled: { word: 'Cancelled', Icon: Ban, className: 'text-ink-3' },
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

interface Props {
  batch: KbIngestBatch;
  // A problem talking to the server (the batch shown may be a little behind); null when none.
  error: string | null;
  // A user action is on its way.
  busy: boolean;
  onCancel: () => void;
  onRetryFailed: () => void;
  onResume: () => void;
  onDismiss: () => void;
  // Opens the ingestion report; the button is left out when the page has none.
  onOpenReport?: () => void;
}

function describeFile(item: KbIngestItem): { word: string; detail: string | null } {
  const retrying = item.state === 'queued' && item.attempts > 0 && item.reason !== null;
  const word = retrying ? 'Retrying' : FILE_STATE[item.state].word;
  if (item.state === 'added' || item.state === 'unchanged') {
    const chunks = item.chunksInStore !== null ? `${item.chunksInStore} ${plural(item.chunksInStore, 'chunk', 'chunks')}` : null;
    return { word, detail: item.reason ?? chunks };
  }
  // A stored reason that only repeats the state word ("cancelled") adds nothing beside it.
  return { word, detail: item.reason && item.reason.toLowerCase() !== word.toLowerCase() ? item.reason : null };
}

function FileStateIcon({ state }: { state: KbIngestItemState }): React.ReactElement {
  const { Icon, className } = FILE_STATE[state];
  if (Icon === 'spinner') return <Spinner className={cn('h-3.5 w-3.5', className)} />;
  return <Icon className={cn('h-4 w-4 flex-none', className)} aria-hidden="true" />;
}

export function KbIngestQueue({ batch, error, busy, onCancel, onRetryFailed, onResume, onDismiss, onOpenReport }: Props): React.ReactElement {
  const { counts } = batch;
  const items = batch.items ?? [];
  const done = counts.added + counts.unchanged + counts.failed + counts.skipped + counts.cancelled;
  const active = batch.status === 'queued' || batch.status === 'running';
  const paused = batch.status === 'paused';
  const finished = !active && !paused;
  const percent = counts.total === 0 ? 0 : (done / counts.total) * 100;

  const { headline, HeadlineIcon, detail } = useMemo(() => {
    if (active && batch.cancelRequested) {
      return { headline: 'Finishing the current file, then stopping…', HeadlineIcon: 'spinner' as const, detail: null };
    }
    if (active) {
      const current = Math.min(done + 1, counts.total);
      return { headline: `Adding ${current} of ${counts.total} ${plural(counts.total, 'file', 'files')}…`, HeadlineIcon: 'spinner' as const, detail: null };
    }
    if (paused) {
      return {
        headline: 'Paused',
        HeadlineIcon: Pause,
        detail: batch.pauseReason === 'sharepoint_token' ? 'The SharePoint token expired. Reconnect SharePoint above and this continues by itself.' : 'Waiting to continue.',
      };
    }
    if (batch.status === 'completed') {
      return {
        headline: counts.added > 0 ? `Added ${counts.added} ${plural(counts.added, 'file', 'files')}` : 'Everything was already up to date',
        HeadlineIcon: CircleCheck,
        detail: null,
      };
    }
    if (batch.status === 'completed_with_errors') return { headline: 'Finished with errors', HeadlineIcon: TriangleAlert, detail: null };
    if (batch.status === 'cancelled') return { headline: 'Cancelled', HeadlineIcon: Ban, detail: null };
    return { headline: 'Could not add any files', HeadlineIcon: CircleX, detail: null };
  }, [active, paused, batch.cancelRequested, batch.pauseReason, batch.status, counts.added, counts.total, done]);

  const summary = finished
    ? [
        batch.status === 'completed_with_errors' || batch.status === 'failed' || batch.status === 'cancelled' ? `${counts.added} added` : null,
        batch.status === 'completed' && counts.unchanged > 0 ? `${counts.unchanged} already up to date` : null,
        counts.failed > 0 ? `${counts.failed} failed` : null,
        counts.skipped > 0 ? `${counts.skipped} skipped` : null,
        counts.cancelled > 0 ? `${counts.cancelled} cancelled` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  // Read out when the batch starts and when it ends (or stops), not on every file: the text depends on status only.
  const announcement = active ? `Adding ${counts.total} ${plural(counts.total, 'file', 'files')} to the knowledge base.` : paused ? `Paused: ${detail}` : `Finished: ${headline}.`;

  return (
    <Card>
      <div role="region" aria-label="Knowledge base batch" className="flex flex-col gap-3 p-3.5">
        <p role="status" className="sr-only">
          {announcement}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-1">
            {HeadlineIcon === 'spinner' ? <Spinner className="h-3.5 w-3.5 text-live" /> : <HeadlineIcon className="h-4 w-4 flex-none text-ink-2" aria-hidden="true" />}
            {headline}
          </h3>
          {summary && <p className="text-xs text-ink-3">{summary}</p>}
          <div className="ml-auto flex items-center gap-1.5">
            {paused && (
              <Button size="sm" onClick={onResume} disabled={busy}>
                Resume
              </Button>
            )}
            {(active || paused) && (
              <Button size="sm" variant="outline" onClick={onCancel} disabled={busy || batch.cancelRequested}>
                {batch.cancelRequested ? 'Cancelling…' : 'Cancel'}
              </Button>
            )}
            {finished && counts.failed > 0 && batch.status !== 'cancelled' && (
              <Button size="sm" onClick={onRetryFailed} disabled={busy}>
                Retry {counts.failed} failed
              </Button>
            )}
            {finished && onOpenReport && (
              <Button size="sm" variant="outline" onClick={onOpenReport}>
                View report
              </Button>
            )}
            {finished && (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        </div>

        {(active || paused) && <ProgressBar label="Adding files to the knowledge base" value={percent} valueText={`${done} of ${counts.total} ${plural(counts.total, 'file', 'files')} done`} />}
        {detail && <p className="text-sm text-warning-ink">{detail}</p>}
        {error && <p className="text-xs text-warning-ink">{error}</p>}

        {items.length > 0 && (
          <ul aria-label="Files in this batch" className="flex max-h-64 flex-col divide-y divide-hairline overflow-y-auto rounded-sm border border-hairline">
            {items.map((item) => {
              const { word, detail: itemDetail } = describeFile(item);
              return (
                <li key={item.id} className="flex items-center gap-2.5 px-2.5 py-1.5 text-sm">
                  <FileStateIcon state={item.state} />
                  <span className="min-w-0 flex-1 truncate text-ink-1">
                    <bdi dir="auto">{item.name}</bdi>
                  </span>
                  <span className={cn('flex-none text-xs', FILE_STATE[item.state].className)}>
                    {word}
                    {itemDetail && <span className="text-ink-3"> · {itemDetail}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
