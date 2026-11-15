import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Briefcase, Clock, Plus, RefreshCw, Trash2, RotateCw, Layers, TriangleAlert } from 'lucide-react';
import { listJobs, deleteJob, resubmitJob } from '../api/jobs';
import { useJobsStore, useJobs, type JobSummary } from '../store/jobsStore';
import { StatusChip } from '../components/StatusChip';
import { describeStoredFailure } from '../utils/failureCause';
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
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { TableHeaderCell } from '../ui/TableHeaderCell';
import { useToast } from '../components/ToastProvider';
import { usePageTitle } from '../hooks/usePageTitle';
import { formatRelativeTime } from '../utils/relativeTime';
import { useDenseView, useAutoSyncLedgers } from '../store/uiPreferencesStore';
import { cn } from '../lib/cn';
import { ARRIVE } from '../ui/motion';
import { formatDateTime } from '../utils/formatDateTime';
import { IconButton } from '../ui/IconButton';
import { groupJobs, isStaleJob, isStalledJob, rerunOf, shortJobId } from '../utils/jobGroups';
import { useUserId } from '../store/authStore';
import { jobStatusLabel } from '../utils/labels';

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

// The tiles. "Diff ready" counts the proposals still worth acting on, the same ones "Needs you" holds: a stale one is not counted here (it has
// its own label and the Hide stale checkbox), so the tile and the first group agree.
export function computeTileCounts(jobs: JobSummary[], now: Date): JobTileCounts {
  return {
    awaitingReview: jobs.filter((j) => j.status === 'diff_ready' && !isStaleJob(j, now)).length,
    running: jobs.filter((j) => matchesBucket(j.status, 'run')).length,
    rejected: jobs.filter((j) => j.status === 'rejected').length,
  };
}

// "Hide stale" is a per-viewer convenience (DESIGN.md §11.1b): off unless the person turned it on, remembered per user, every access guarded.
const HIDE_STALE_KEY = 'req2ado-hide-stale-jobs:';

function readHideStale(userId: string | null): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(HIDE_STALE_KEY + userId) === 'true';
  } catch {
    return false;
  }
}

function writeHideStale(userId: string | null, hidden: boolean): void {
  if (!userId) return;
  try {
    localStorage.setItem(HIDE_STALE_KEY + userId, String(hidden));
  } catch {
    // Best effort.
  }
}

export function JobsList(): React.ReactElement {
  usePageTitle('Jobs');
  const jobs = useJobs();
  const setJobs = useJobsStore((state) => state.setJobs);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusBucket>('all');
  const userId = useUserId();
  const [hideStale, setHideStale] = useState(() => readHideStale(userId));
  const [deleteTarget, setDeleteTarget] = useState<JobSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [resubmitTarget, setResubmitTarget] = useState<JobSummary | null>(null);
  const [isResubmitting, setIsResubmitting] = useState(false);
  const navigate = useNavigate();
  const { showToast, showErrorToast } = useToast();
  const denseView = useDenseView();
  const autoSyncLedgers = useAutoSyncLedgers();

  // Each refresh gets a number. A slow response that was started before a newer one must not overwrite it, and a list that keeps failing says
  // so once, not every 20 seconds, until a refresh works again.
  const loadSeq = useRef(0);
  const failureShown = useRef(false);

  function load(): void {
    const seq = ++loadSeq.current;
    listJobs()
      .then((result) => {
        if (seq !== loadSeq.current) return;
        failureShown.current = false;
        setLoadError(false);
        setJobs(result);
        setLoaded(true);
      })
      .catch((err) => {
        if (seq !== loadSeq.current) return;
        setLoaded(true);
        setLoadError(true);
        if (failureShown.current) return;
        failureShown.current = true;
        showErrorToast('Failed to load jobs.', err);
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
    } catch (err) {
      showErrorToast('Resubmit failed — the original file may not have been retained. Re-upload it as a new job instead.', err);
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
    } catch (err) {
      showErrorToast('Failed to delete job — please try again.', err);
    } finally {
      setIsDeleting(false);
    }
  }

  // One clock for staleness, grouping and the tile, read once per change of the list: they cannot disagree on a page left open.
  const now = useMemo(() => new Date(), [jobs]); // eslint-disable-line react-hooks/exhaustive-deps -- re-read when the list changes, not every render
  // What the search and the status filter leave, before "Hide stale": the stale count offered below is of THESE, so it never promises jobs
  // that the other filters already hide.
  const inView = useMemo(() => {
    const query = search.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesStatus = matchesBucket(job.status, statusFilter);
      const matchesQuery =
        !query ||
        job.originalFilename.toLowerCase().includes(query) ||
        job.areaPath.toLowerCase().includes(query) ||
        job.id.toLowerCase().includes(query);
      return matchesStatus && matchesQuery;
    });
  }, [jobs, search, statusFilter]);
  const staleCount = useMemo(() => inView.filter((job) => isStaleJob(job, now)).length, [inView, now]);
  const filteredJobs = useMemo(() => (hideStale ? inView.filter((job) => !isStaleJob(job, now)) : inView), [inView, hideStale, now]);
  // Needs-you first, then by local day.
  const jobGroups = useMemo(() => groupJobs(filteredJobs, now), [filteredJobs, now]);
  const tileCounts = useMemo(() => computeTileCounts(jobs, now), [jobs, now]);
  const reruns = useMemo(() => rerunOf(jobs), [jobs]);
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
            <Button variant="outline" onClick={() => navigate('/jobs/batch/new')}>
              <Layers className="h-4 w-4" /> New batch
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
                Diff ready
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
        // A failed load is not "no jobs": the error banner above carries it, with Retry.
        loadError ? null : (
          <Card>
            <EmptyState
              icon={Briefcase}
              title="No jobs yet"
              description="Upload a requirements document to get started."
              action={<Button onClick={() => navigate('/jobs/new')}>Create your first job</Button>}
            />
          </Card>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2.5">
            <TextField
              label="Search"
              placeholder="File name, area path or job id…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-[280px]"
            />
            <div className="inline-flex overflow-hidden rounded-sm border border-hairline-strong" role="group" aria-label="Filter by status">
              {(
                [
                  ['all', 'All'],
                  ['review', 'Diff ready'],
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
            {staleCount > 0 && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={hideStale}
                  onChange={(event) => {
                    setHideStale(event.target.checked);
                    writeHideStale(userId, event.target.checked);
                  }}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Hide stale ({staleCount.toLocaleString()})
              </label>
            )}
            {hideStale && staleCount > 0 && <span className="text-xs text-ink-3">{staleCount.toLocaleString()} stale hidden</span>}
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
                      {/* Columns drop as the width shrinks, least useful first, so Document and Status (what it is, what state) always stay and
                          "Created" and the row never clip: area below 1400 px, mode and items below 1100 px, id, created and actions below md. */}
                      <TableHeaderCell className={cn('whitespace-nowrap max-md:hidden', cellPaddingY)}>Job</TableHeaderCell>
                      <TableHeaderCell className={cn('whitespace-nowrap', cellPaddingY)}>Document</TableHeaderCell>
                      <TableHeaderCell className={cn('whitespace-nowrap max-[1099px]:hidden', cellPaddingY)}>Mode</TableHeaderCell>
                      <TableHeaderCell className={cn('whitespace-nowrap', cellPaddingY)}>Status</TableHeaderCell>
                      <TableHeaderCell className={cn('whitespace-nowrap max-[1099px]:hidden', cellPaddingY)}>Items</TableHeaderCell>
                      <TableHeaderCell className={cn('whitespace-nowrap max-[1399px]:hidden', cellPaddingY)}>Area path</TableHeaderCell>
                      <TableHeaderCell className={cn('whitespace-nowrap max-md:hidden', cellPaddingY)}>Created</TableHeaderCell>
                      <TableHeaderCell align="right" className={cn('whitespace-nowrap max-md:hidden', cellPaddingY)}>
                        <span className="sr-only">Actions</span>
                      </TableHeaderCell>
                    </tr>
                  </thead>
                  {/* One fade for the whole block, once, when the table first appears (DESIGN.md section 8.3): no per-row stagger, so every row behaves the same and nothing replays on sort, filter or refresh. */}
                  {/* One tbody per group, headed by a row group header: assistive technology reads "Today, 3 rows" as a group. */}
                    {jobGroups.map((group) => (
                      <tbody key={group.id} className={ARRIVE.fade}>
                        <tr className="border-t border-hairline-strong bg-surface-alt">
                          <th scope="rowgroup" colSpan={8} className="px-3.5 py-1.5 text-left text-xs font-semibold text-ink-2">
                            {group.title} · {group.jobs.length.toLocaleString()}
                          </th>
                        </tr>
                    {group.jobs.map((job) => (
                      <tr
                        key={job.id}
                        // A pointer convenience only: the keyboard and assistive tech use the document name's link below. The row is
                        // not itself a link or a tab stop, since it also holds the Resubmit and Delete buttons. A click on the link or a
                        // button is theirs, not the row's.
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest('a, button')) return;
                          navigate(`/jobs/${job.id}`);
                        }}
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
                        className={cn('group border-t border-hairline transition-colors duration-micro hover:bg-surface-alt cursor-pointer')}
                      >
                        <td className={cn('border-l-2 border-transparent px-3.5 transition-colors duration-fast group-hover:border-accent max-md:hidden', cellPaddingY)}>
                          <span className="font-mono text-xs text-ink-2">{shortJobId(job.id)}</span>
                        </td>
                        <td className={cn('px-3.5', cellPaddingY)}>
                          <span className="flex min-w-0 items-center gap-1.5">
                            <Link
                              to={`/jobs/${job.id}`}
                              aria-label={`View job ${job.id}: ${job.originalFilename}, ${jobStatusLabel(job.status).label}`}
                              className="block max-w-[14rem] truncate text-sm font-medium text-ink-1 hover:underline max-md:max-w-[7rem]"
                            >
                              {job.originalFilename}
                            </Link>
                            {job.batchId && (
                              <Tooltip content="Part of a batch upload — click to view the whole batch">
                                <Chip
                                  className="flex-none cursor-pointer border border-hairline-strong bg-surface-alt text-ink-2 hover:bg-canvas"
                                  onClick={(event) => {
                                    // The row itself navigates to the job on
                                    // click -- without this, clicking the
                                    // chip would also navigate there instead
                                    // of to the batch.
                                    event.stopPropagation();
                                    navigate(`/jobs/batch/${job.batchId}`);
                                  }}
                                >
                                  <Layers className="h-3 w-3" /> Batch
                                </Chip>
                              </Tooltip>
                            )}
                          </span>
                          {reruns.has(job.id) && <span className="block text-xs text-ink-3">Re-run of {reruns.get(job.id)}</span>}
                          {job.status === 'failed' && job.failureClass && (
                            <span className="block max-w-[14rem] truncate text-xs text-ink-3 max-md:max-w-[7rem]">
                              {describeStoredFailure({ failureClass: job.failureClass })?.summary}
                            </span>
                          )}
                        </td>
                        <td className={cn('px-3.5 max-[1099px]:hidden', cellPaddingY)}>
                          <ModeBadge mode={job.mode as 'baseline' | 'survey'} />
                        </td>
                        <td className={cn('px-3.5', cellPaddingY)}>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <StatusChip status={job.status} partial={job.status === 'diff_ready' && job.createdItemCount > 0} />
                            {isStalledJob(job, now) && (
                              <Tooltip content="Started over 12 hours ago and has not finished. The worker may have stopped: open the job to check, then resubmit it if it has.">
                                <Chip bg="var(--color-warning-soft)" color="var(--color-warning-ink)" className="border border-warning-border">
                                  <TriangleAlert className="h-3 w-3 flex-none" aria-hidden="true" />
                                  Stalled · {Math.floor((now.getTime() - Date.parse(job.createdAt)) / 3_600_000)} h
                                </Chip>
                              </Tooltip>
                            )}
                            {isStaleJob(job, now) && (
                              <Tooltip content="Waiting for review for over a week. The proposal was computed against Azure DevOps as it was then.">
                                <Chip bg="var(--color-warning-soft)" color="var(--color-warning-ink)" className="border border-warning-border">
                                  <Clock className="h-3 w-3 flex-none" aria-hidden="true" />
                                  Stale · {Math.floor((now.getTime() - Date.parse(job.createdAt)) / 86_400_000)} days
                                </Chip>
                              </Tooltip>
                            )}
                          </span>
                        </td>
                        <td className={cn('px-3.5 font-mono tabular-nums max-[1099px]:hidden', cellPaddingY)}>{job.itemCount}</td>
                        <td className={cn('px-3.5 font-mono text-xs max-[1399px]:hidden', cellPaddingY)}>
                          <Tooltip content={job.areaPath}>
                            <span className="block max-w-[14rem] truncate">{job.areaPath.split('\\').pop() || job.areaPath}</span>
                          </Tooltip>
                        </td>
                        <td className={cn('whitespace-nowrap px-3.5 text-xs max-md:hidden', cellPaddingY)}>
                          <Tooltip content={formatDateTime(job.createdAt)}>
                            <span>{formatRelativeTime(job.createdAt)}</span>
                          </Tooltip>
                        </td>
                        <td className={cn('whitespace-nowrap px-3.5 text-right max-md:hidden', cellPaddingY)}>
                          {!RUNNING_STATUSES.has(job.status) && (
                            // Revealed on hover/focus, not always-on -- a row of
                            // permanently-visible icon buttons on every row read
                            // as UI chrome competing with the actual data; this
                            // keeps them available (never removed from the tab
                            // order) while visually quiet until you're pointed at
                            // that specific row.
                            <span className="inline-flex gap-1 opacity-0 transition-opacity duration-instant group-hover:opacity-100 group-focus-within:opacity-100">
                              <IconButton
                                label={`Resubmit job ${job.id}`}
                                icon={RotateCw}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setResubmitTarget(job);
                                }}
                              />
                              <IconButton
                                label={`Delete job ${job.id}`}
                                icon={Trash2}
                                tone="danger"
                                onClick={(event) => {
                                  // The row itself navigates on click -- without
                                  // this, clicking Delete would also navigate to
                                  // the job before the dialog ever opened.
                                  event.stopPropagation();
                                  setDeleteTarget(job);
                                }}
                              />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                      </tbody>
                    ))}
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
        description="Runs the same source document again as a new job, using the same settings. If nothing in the document or destination has changed, writing the new job will link to the same Azure DevOps items instead of creating them again."
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
            ? 'This removes the job and its history from req2ado only — any work items already written to Azure DevOps are NOT deleted and must be removed there directly, if wanted. This cannot be undone.'
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
