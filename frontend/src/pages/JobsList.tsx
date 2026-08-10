import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, Plus, RefreshCw, Trash2, RotateCw } from 'lucide-react';
import { listJobs, deleteJob, resubmitJob } from '../api/jobs';
import { useJobsStore, useJobs, type JobSummary } from '../store/jobsStore';
import { StatusChip } from '../components/StatusChip';
import { ModeBadge } from '../components/ModeBadge';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Card } from '../ui/Card';
import { Alert } from '../ui/Alert';
import { TextField } from '../ui/TextField';
import { Skeleton } from '../ui/Skeleton';
import { Tooltip } from '../ui/Tooltip';
import { InfoTip } from '../ui/Tooltip';
import { StatTile } from '../ui/StatTile';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../components/ToastProvider';
import { formatRelativeTime } from '../utils/relativeTime';
import { useDenseView, useAutoSyncLedgers } from '../store/uiPreferencesStore';
import { cn } from '../lib/cn';

// Curated buckets, not the raw seven-value backend enum -- "review" and
// "run" each cover more than one Job.status (JOB_STATUS_LABELS,
// utils/labels.ts), matching the prototype's segmented filter
// (all/review/run/done) rather than exposing snake_case statuses as filter
// options a user has to already know the meaning of.
type StatusBucket = 'all' | 'review' | 'run' | 'done';

const RUNNING_STATUSES = new Set(['pending', 'running', 'writing']);
const DONE_STATUSES = new Set(['succeeded', 'failed', 'rejected']);

function matchesBucket(status: string, bucket: StatusBucket): boolean {
  switch (bucket) {
    case 'review':
      return status === 'diff_ready';
    case 'run':
      return RUNNING_STATUSES.has(status);
    case 'done':
      return DONE_STATUSES.has(status);
    default:
      return true;
  }
}

interface JobTileCounts {
  awaitingReview: number;
  running: number;
  rejected: number;
}

function computeTileCounts(jobs: JobSummary[]): JobTileCounts {
  return {
    awaitingReview: jobs.filter((j) => j.status === 'diff_ready').length,
    running: jobs.filter((j) => matchesBucket(j.status, 'run')).length,
    rejected: jobs.filter((j) => j.status === 'rejected').length,
  };
}

export function JobsList(): React.ReactElement {
  const jobs = useJobs();
  const setJobs = useJobsStore((state) => state.setJobs);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusBucket>('all');
  const [deleteTarget, setDeleteTarget] = useState<JobSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [resubmitTarget, setResubmitTarget] = useState<JobSummary | null>(null);
  const [isResubmitting, setIsResubmitting] = useState(false);
  const navigate = useNavigate();
  const { showToast } = useToast();
  const denseView = useDenseView();
  const autoSyncLedgers = useAutoSyncLedgers();

  function load(): void {
    setLoadError(false);
    listJobs()
      .then((result) => {
        setJobs(result);
        setLoaded(true);
      })
      .catch(() => {
        setLoaded(true);
        setLoadError(true);
        showToast('Failed to load jobs.', 'error');
      });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  // Real background polling (Settings' "Auto-Sync Ledgers" toggle), not a
  // cosmetic setting -- load() itself never flips `loaded` back to false,
  // so this refresh never re-triggers the loading skeleton, only silently
  // refreshes the already-rendered table.
  useEffect(() => {
    if (!autoSyncLedgers) return;
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSyncLedgers]);

  const cellPaddingY = denseView ? 'py-1' : 'py-2.5';

  async function handleResubmit(): Promise<void> {
    if (!resubmitTarget) return;
    setIsResubmitting(true);
    try {
      const result = await resubmitJob(resubmitTarget.id);
      setResubmitTarget(null);
      showToast('Resubmitted as a new job.', 'success');
      navigate(`/jobs/${result.jobId}`);
    } catch {
      showToast('Resubmit failed — the original file may not have been retained. Re-upload it as a new job instead.', 'error');
    } finally {
      setIsResubmitting(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteJob(deleteTarget.id);
      setDeleteTarget(null);
      showToast('Job deleted.', 'success');
      load();
    } catch {
      showToast('Failed to delete job — please try again.', 'error');
    } finally {
      setIsDeleting(false);
    }
  }

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesStatus = matchesBucket(job.status, statusFilter);
      const matchesQuery = !query || job.areaPath.toLowerCase().includes(query) || job.id.toLowerCase().includes(query);
      return matchesStatus && matchesQuery;
    });
  }, [jobs, search, statusFilter]);

  const tileCounts = useMemo(() => computeTileCounts(jobs), [jobs]);
  const itemsWritten = useMemo(() => jobs.reduce((sum, job) => sum + job.createdItemCount, 0), [jobs]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Jobs"
        actions={
          <>
            <Button variant="outline" onClick={load} disabled={!loaded}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button onClick={() => navigate('/jobs/new')}>
              <Plus className="h-4 w-4" /> New job
            </Button>
          </>
        }
      />
      {loaded && jobs.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatTile
            value={tileCounts.awaitingReview}
            label={
              <span className="inline-flex items-center gap-1">
                Awaiting review
                <InfoTip content="The document has been analyzed and a hierarchy is proposed. Nothing is written to Azure DevOps until you open the job and confirm it." />
              </span>
            }
            accent
            interactive
          />
          <StatTile value={tileCounts.running} label="Running" interactive />
          <StatTile value={itemsWritten} label="Items written" tone="ok" interactive />
          <StatTile value={tileCounts.rejected} label="Rejected" tone="dim" interactive />
        </div>
      )}
      {loadError && (
        <Alert severity="error">
          <div className="flex items-center justify-between gap-3">
            <span>Couldn't load jobs. Check your connection and try again.</span>
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {!loaded ? (
        <Card>
          <div className="flex flex-col gap-2 p-3.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </Card>
      ) : jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={Briefcase}
            title="No jobs yet"
            description="Upload a requirements document to get started."
            action={<Button onClick={() => navigate('/jobs/new')}>Create your first job</Button>}
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2.5">
            <TextField
              label="Search"
              placeholder="Area path or job id…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-[280px]"
            />
            <div className="inline-flex overflow-hidden rounded-sm border border-hairline-strong" role="group" aria-label="Filter by status">
              {(
                [
                  ['all', 'All'],
                  ['review', 'Awaiting review'],
                  ['run', 'Running'],
                  ['done', 'Done'],
                ] as [StatusBucket, string][]
              ).map(([bucket, label]) => (
                <button
                  key={bucket}
                  type="button"
                  aria-pressed={statusFilter === bucket}
                  onClick={() => setStatusFilter(bucket)}
                  className={cn(
                    'border-l border-hairline-strong px-2.5 py-1.5 text-xs font-semibold text-ink-2 first:border-l-0 hover:bg-canvas',
                    statusFilter === bucket && 'bg-accent text-white hover:bg-accent',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {filteredJobs.length === 0 ? (
            <Card>
              <EmptyState icon={Briefcase} title="No jobs match your filters" description="Try a different search term or status." />
            </Card>
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    {/* No tinted background on this row -- confirmed live:
                        with the Actions column's only header content being
                        a zero-width sr-only label (its body cells hold two
                        icon buttons, real content only), this browser's
                        table-layout:auto sizing leaves a real, uncovered
                        gap at the table's right edge that a tinted
                        background would expose as a hard color seam. A
                        border under the row (matching how this app already
                        separates header/body elsewhere) signals "header"
                        just as clearly without depending on every column
                        summing to exactly the table's width. bg-surface
                        (opaque, matching the Card) is still needed despite
                        matching the row below it -- sticky rows scroll over
                        body content and must not show it through. */}
                    <tr className="sticky top-0 z-10 border-b border-hairline-strong bg-surface">
                      <th className={cn('whitespace-nowrap px-3.5 text-left text-micro font-semibold uppercase tracking-wide text-ink-3', cellPaddingY)}>Document</th>
                      <th className={cn('whitespace-nowrap px-3.5 text-left text-micro font-semibold uppercase tracking-wide text-ink-3', cellPaddingY)}>Mode</th>
                      <th className={cn('whitespace-nowrap px-3.5 text-left text-micro font-semibold uppercase tracking-wide text-ink-3', cellPaddingY)}>Status</th>
                      <th className={cn('whitespace-nowrap px-3.5 text-left text-micro font-semibold uppercase tracking-wide text-ink-3', cellPaddingY)}>Items</th>
                      <th className={cn('whitespace-nowrap px-3.5 text-left text-micro font-semibold uppercase tracking-wide text-ink-3', cellPaddingY)}>Area Path</th>
                      <th className={cn('whitespace-nowrap px-3.5 text-left text-micro font-semibold uppercase tracking-wide text-ink-3', cellPaddingY)}>Created</th>
                      <th className={cn('whitespace-nowrap px-3.5 text-right text-micro font-semibold uppercase tracking-wide text-ink-3', cellPaddingY)}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredJobs.map((job, index) => (
                      <tr
                        key={job.id}
                        onClick={() => navigate(`/jobs/${job.id}`)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            navigate(`/jobs/${job.id}`);
                          }
                        }}
                        tabIndex={0}
                        role="link"
                        aria-label={`View job ${job.id}`}
                        // DESIGN.md §7 names "JobsList rows" as a
                        // .hoverable-row consumer -- but that class's
                        // ::before rail is an absolutely-positioned pseudo-
                        // element, and confirmed live (debug cell outlines):
                        // a <tr> with a positioned pseudo-element child
                        // makes this browser miscompute every real <td>'s
                        // column position in this table, shifting the whole
                        // row's cells one column to the right relative to
                        // the header. Replicated the same tint+border+rail
                        // outcome locally without a pseudo-element: the tint
                        // and top hairline stay plain Tailwind on the <tr>;
                        // the rail moves to a real border-left on the first
                        // <td> below (toggled via `group`), which is a
                        // normal box-model property, not a positioned box,
                        // so it cannot confuse column layout the same way.
                        className="group border-t border-hairline transition-colors duration-fast hover:bg-surface-alt cursor-pointer animate-[listItemIn_var(--duration-base)_var(--ease-out)_backwards]"
                        style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
                      >
                        <td className={cn('border-l-2 border-transparent px-3.5 transition-colors duration-fast group-hover:border-accent', cellPaddingY)}>
                          <span className="block truncate text-sm font-medium">{job.originalFilename}</span>
                        </td>
                        <td className={cn('px-3.5', cellPaddingY)}>
                          <ModeBadge mode={job.mode as 'baseline' | 'survey'} />
                        </td>
                        <td className={cn('px-3.5', cellPaddingY)}>
                          <StatusChip status={job.status} />
                        </td>
                        <td className={cn('px-3.5 font-mono tabular-nums', cellPaddingY)}>{job.itemCount}</td>
                        <td className={cn('px-3.5 font-mono text-xs', cellPaddingY)}>
                          <Tooltip content={job.areaPath}>
                            <span className="block truncate">{job.areaPath}</span>
                          </Tooltip>
                        </td>
                        <td className={cn('whitespace-nowrap px-3.5 font-mono text-xs', cellPaddingY)}>
                          <Tooltip content={new Date(job.createdAt).toLocaleString()}>
                            <span>{formatRelativeTime(job.createdAt)}</span>
                          </Tooltip>
                        </td>
                        <td className={cn('whitespace-nowrap px-3.5 text-right', cellPaddingY)}>
                          {!RUNNING_STATUSES.has(job.status) && (
                            // Revealed on hover/focus, not always-on -- a row of
                            // permanently-visible icon buttons on every row read
                            // as UI chrome competing with the actual data; this
                            // keeps them available (never removed from the tab
                            // order) while visually quiet until you're pointed at
                            // that specific row.
                            <span className="inline-flex gap-1 opacity-0 transition-opacity duration-instant group-hover:opacity-100 group-focus-within:opacity-100">
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Resubmit job ${job.id}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setResubmitTarget(job);
                                }}
                              >
                                <RotateCw className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Delete job ${job.id}`}
                                onClick={(event) => {
                                  // The row itself navigates on click -- without
                                  // this, clicking Delete would also navigate to
                                  // the job before the dialog ever opened.
                                  event.stopPropagation();
                                  setDeleteTarget(job);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
      <ConfirmDialog
        open={resubmitTarget != null}
        onOpenChange={(open) => !open && setResubmitTarget(null)}
        title="Resubmit this job?"
        description="Runs the same source document again as a new job, using the same settings. If nothing in the document or destination has changed, Confirm on the new job will reuse the same Azure DevOps items rather than creating duplicates."
        confirmLabel="Resubmit"
        onConfirm={handleResubmit}
        isConfirming={isResubmitting}
      />
      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete this job?"
        description={
          deleteTarget?.status === 'succeeded'
            ? 'This removes the job and its history from req2ado only -- any work items already written to Azure DevOps are NOT deleted and must be removed there directly, if wanted. This cannot be undone.'
            : 'This permanently removes the job and its history from req2ado. This cannot be undone.'
        }
        confirmLabel="Delete job"
        onConfirm={handleDelete}
        isConfirming={isDeleting}
        variant="destructive"
      />
    </div>
  );
}
