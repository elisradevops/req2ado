import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Layers, CircleCheck, TriangleAlert, Clock } from 'lucide-react';
import { getBatch, cancelQueuedFiles, type BatchDetail } from '../api/batches';
import { StatusChip } from '../components/StatusChip';
import { PageHeader } from '../ui/PageHeader';
import { Card } from '../ui/Card';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { StatTile } from '../ui/StatTile';
import { Tooltip } from '../ui/Tooltip';
import { useToast } from '../components/ToastProvider';
import { cn } from '../lib/cn';
import { TableHeaderCell } from '../ui/TableHeaderCell';
import { formatFileSize } from '../utils/fileSize';

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// A file in one of these statuses has nothing left to happen to it
// automatically -- polling keeps running as long as ANY file is NOT in
// this set (queued/pending/running/writing/diff_ready all still have real
// state ahead of them, even if diff_ready specifically requires a human
// action elsewhere to move forward).
const SETTLED_STATUSES = new Set(['succeeded', 'failed', 'rejected', 'cancelled', 'invalid', 'submit_failed', 'deleted']);

const NOTE_SEVERITY_MAP: Record<'info' | 'warning', 'info' | 'warning'> = { info: 'info', warning: 'warning' };

export function BatchStatus(): React.ReactElement {
  const { batchId } = useParams<{ batchId: string }>();
  const { showToast, showErrorToast } = useToast();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const isCancellingRef = useRef(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const load = useCallback(() => {
    if (!batchId) return;
    setLoadError(false);
    getBatch(batchId)
      .then((result) => {
        setBatch(result);
        setLoaded(true);
      })
      .catch(() => {
        setLoaded(true);
        setLoadError(true);
      });
  }, [batchId]);

  useEffect(load, [load]);

  const isSettled = batch ? batch.files.every((f) => SETTLED_STATUSES.has(f.status)) : false;

  // Polls every 5s (same cadence/pattern as JobsList's own auto-sync
  // interval) until every file has reached a settled state -- each file's
  // own live narration already exists on its own JobDetail page, so this
  // page only needs a coarse "did anything change" refresh, not SSE.
  useEffect(() => {
    if (!loaded || isSettled) return;
    const intervalId = setInterval(load, 5000);
    return () => clearInterval(intervalId);
  }, [loaded, isSettled, load]);

  async function handleCancelQueued(): Promise<void> {
    if (!batchId || isCancellingRef.current) return;
    isCancellingRef.current = true;
    setIsCancelling(true);
    try {
      await cancelQueuedFiles(batchId);
      showToast('Stopped queueing the remaining files.', 'success');
      load();
    } catch (err) {
      showErrorToast('Failed to stop queueing -- please try again.', err);
    } finally {
      isCancellingRef.current = false;
      setIsCancelling(false);
    }
  }

  if (!loaded) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Batch" />
        <Card>
          <div className="flex flex-col gap-2 p-3.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  if (loadError || !batch) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Batch" />
        <Alert severity="error">
          <div className="flex items-center justify-between gap-3">
            <span>Couldn't load this batch. Check your connection and try again.</span>
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  const { summary, files, notes } = batch;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Batch" description={batch.areaPath} />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile value={summary.filesTotal} label="Files" icon={Layers} interactive />
        <StatTile value={summary.filesAwaitingReview} label="Awaiting review" tone="default" accent interactive />
        <StatTile value={summary.filesSucceeded} label="Succeeded" tone="ok" icon={CircleCheck} interactive />
        <StatTile value={summary.filesFailed} label="Failed" tone={summary.filesFailed > 0 ? 'warning' : 'dim'} icon={TriangleAlert} interactive />
      </div>

      {notes.map((note) => (
        <Alert key={note.kind} severity={NOTE_SEVERITY_MAP[note.severity]}>
          {note.message}
        </Alert>
      ))}

      {summary.filesQueued > 0 && (
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 flex-none text-ink-3" />
          <span className="text-xs text-ink-3">{summary.filesQueued} file(s) still queued</span>
          <Button size="sm" variant="outline" onClick={handleCancelQueued} disabled={isCancelling} className="ml-auto">
            {isCancelling ? 'Stopping…' : 'Stop queueing remaining files'}
          </Button>
        </div>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline-strong">
                <TableHeaderCell className="py-2.5">File</TableHeaderCell>
                <TableHeaderCell className="py-2.5">Size</TableHeaderCell>
                <TableHeaderCell className="py-2.5">Status</TableHeaderCell>
                <TableHeaderCell className="py-2.5">Detail</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id} className={cn('border-t border-hairline', file.ordinal % 2 === 1 && 'bg-surface-alt/40')}>
                  <td className="px-3.5 py-2.5">
                    <span className="block truncate text-sm font-medium">{file.filename}</span>
                  </td>
                  <td className="px-3.5 py-2.5 font-mono text-xs">{formatFileSize(file.sizeBytes)}</td>
                  <td className="px-3.5 py-2.5">
                    <StatusChip status={file.status} />
                  </td>
                  <td className="px-3.5 py-2.5 text-xs">
                    {file.jobId ? (
                      <Link to={`/jobs/${file.jobId}`} className="font-medium text-accent hover:underline">
                        View job
                      </Link>
                    ) : file.error ? (
                      <Tooltip content={file.error}>
                        <span className="text-danger-ink">{file.error}</span>
                      </Tooltip>
                    ) : file.queuePosition != null ? (
                      <span className="text-ink-3">{file.queuePosition === 1 ? 'Next in line' : `${ordinal(file.queuePosition)} in line`}</span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
