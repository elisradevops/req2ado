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
          />
          <StatTile value={tileCounts.running} label="Running" />
          <StatTile value={itemsWritten} label="Items written" tone="ok" />
          <StatTile value={tileCounts.rejected} label="Rejected" tone="dim" />
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
                    statusFilter === bucket && 'bg-navy-600 text-white hover:bg-navy-600',
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
                    <tr>
                      <th className="whitespace-nowrap bg-surface-alt px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Document</th>
                      <th className="whitespace-nowrap bg-surface-alt px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Mode</th>
                      <th className="whitespace-nowrap bg-surface-alt px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Status</th>
                      <th className="whitespace-nowrap bg-surface-alt px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Items</th>
                      <th className="whitespace-nowrap bg-surface-alt px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Area Path</th>
                      <th className="whitespace-nowrap bg-surface-alt px-3.5 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Created</th>
                      <th className="whitespace-nowrap bg-surface-alt px-3.5 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
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
                        className="cursor-pointer border-t border-hairline transition-colors hover:bg-canvas focus-visible:bg-canvas animate-[listItemIn_180ms_ease-out_backwards]"
                        style={{ animationDelay: `${Math.min(index, 12) * 15}ms` }}
                      >
                        <td className="max-w-[200px] px-3.5 py-2.5">
                          <span className="block truncate text-sm font-medium">{job.originalFilename}</span>
                        </td>
                        <td className="px-3.5 py-2.5">
                          <ModeBadge mode={job.mode as 'baseline' | 'survey'} />
                        </td>
                        <td className="px-3.5 py-2.5">
                          <StatusChip status={job.status} />
                        </td>
                        <td className="px-3.5 py-2.5">{job.itemCount}</td>
                        <td className="max-w-[220px] px-3.5 py-2.5 font-mono text-xs">
                          <Tooltip content={job.areaPath}>
                            <span className="block truncate">{job.areaPath}</span>
                          </Tooltip>
                        </td>
                        <td className="whitespace-nowrap px-3.5 py-2.5 font-mono text-xs">
                          <Tooltip content={new Date(job.createdAt).toLocaleString()}>
                            <span>{formatRelativeTime(job.createdAt)}</span>
                          </Tooltip>
                        </td>
                        <td className="whitespace-nowrap px-3.5 py-2.5 text-right">
                          {!RUNNING_STATUSES.has(job.status) && (
                            <>
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
                            </>
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
        destructive
      />
    </div>
  );
}
