import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getJob,
  confirmJob,
  getAudit,
  getEventHistory,
  getDebugCaptures,
  editDiffEntry,
  setDiffEntryExcluded,
  addDiffEntry,
  rescoreDiffEntry,
  rejectJob,
  cancelJob,
  deleteJob,
  resubmitJob,
  getSummary,
  type AuditEntry,
  type DebugCaptureEntry,
  type JobEventRecord,
  type JobSummaryReport,
} from '../api/jobs';
import { subscribeToJobEvents, isValidNarrationEvent, type JobStage, type NarrationEvent } from '../api/events';
import { loadRuntimeConfig } from '../api/config';
import { useOrgUrl } from '../store/authStore';
import { StatusChip } from '../components/StatusChip';
import { ModeBadge } from '../components/ModeBadge';
import { ProgressBanner } from '../components/ProgressBanner';
import { JobLifecycleSteps } from '../components/JobLifecycleSteps';
import { NarrationTicker } from '../components/NarrationTicker';
import { tickerFor } from '../utils/narrationTicker';
import { DiffTree, type DryRunDiffEntry } from '../components/DiffTree';
import { NodeDetailDialog } from '../components/NodeDetailDialog';
import { useToast } from '../components/ToastProvider';
import type { KbCitation } from '../components/KbCitationChips';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { Tabs } from '../ui/Tabs';
import { Skeleton } from '../ui/Skeleton';
import { Spinner } from '../ui/Spinner';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Tooltip } from '../ui/Tooltip';
import { DestinationBar } from '../components/DestinationBar';
import { Card } from '../ui/Card';
import { StatTile } from '../ui/StatTile';
import { TextField } from '../ui/TextField';
import { Select } from '../ui/Select';
import { CollapsibleWarnings } from '../components/CollapsibleWarnings';
import { FigureDescriptions, type FigureDescriptionEntry } from '../components/FigureDescriptions';
import { SectionResults, type SectionResultEntry } from '../components/SectionResults';
import type { WorkItemTypeCatalogEntry } from '../api/ado';
import { isRunDetailStatus, shouldShowTiles, shouldShowTabs, shouldShowFilterBar } from './jobDetailLayout';
import { FileX2 } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';

export function JobDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const orgUrl = useOrgUrl();
  const { showToast } = useToast();
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [kbCitations, setKbCitations] = useState<KbCitation[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Populated directly from the SSE callback on 'chunk_warning' events --
  // docs/ui-progress-review.md item #3: previously a mid-run chunk failure
  // was invisible until the whole job finished and `warnings` (above) got
  // its one-time post-completion value. Merged with `warnings` wherever
  // rendered (see the mergedWarnings useMemo below), not shown separately,
  // so a live warning doesn't disappear then reappear once the job
  // actually completes and the persisted list supersedes it.
  const [liveWarnings, setLiveWarnings] = useState<string[]>([]);
  const [diff, setDiff] = useState<DryRunDiffEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [stage, setStage] = useState<JobStage | null>(null);
  const [narrations, setNarrations] = useState<NarrationEvent[]>([]);
  // Populated directly from the SSE callback (not derived from the
  // capped `narrations` list above) -- a document with many figures can
  // produce more describe_figure events than the 50-narration cap allows,
  // which would otherwise evict early figures' captions before a reader
  // ever sees them. Keyed by figureIndex so the two events per figure
  // (before/after the vision call) collapse to one entry, the second
  // overwriting the first once the real caption arrives.
  const [figureCaptionsByIndex, setFigureCaptionsByIndex] = useState<Record<number, string>>({});
  // Populated directly from the SSE callback, same reasoning as
  // figureCaptionsByIndex above -- keyed by branchIndex so a section's
  // result stays visible regardless of the 50-narration cap on the general
  // activity log.
  const [sectionResultsByIndex, setSectionResultsByIndex] = useState<Record<number, SectionResultEntry>>({});
  const [tab, setTab] = useState<'tree' | 'audit'>('tree');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [debugCaptures, setDebugCaptures] = useState<DebugCaptureEntry[]>([]);
  // Durable counterpart to the live SSE narration stream -- fetched once a
  // job reaches a terminal status (see the effect below), since that's
  // exactly when the SSE connection closes and the client-side narration
  // array stops growing. Unlike that array (capped, gone on page reload),
  // this survives past the job's own completion/failure.
  const [eventHistory, setEventHistory] = useState<JobEventRecord[]>([]);
  const [summary, setSummary] = useState<JobSummaryReport | null>(null);
  // Real job creation time from the server -- NOT page-load/mount time, so
  // a refresh mid-run shows the actual elapsed duration instead of
  // resetting to zero. null until the job fetch below resolves.
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [areaPath, setAreaPath] = useState<string | null>(null);
  // Never wired into DestinationBar before -- iterationPath rendered as
  // permanently "not set" (the hatched pattern) and state as a bare "—"
  // regardless of what the job was actually configured with, since these
  // simply weren't read out of the job response at all.
  const [iterationPath, setIterationPath] = useState<string | null>(null);
  const [workItemState, setWorkItemState] = useState<string | null>(null);
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resubmitDialogOpen, setResubmitDialogOpen] = useState(false);
  const [filterAction, setFilterAction] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Resolved server-side and embedded directly in the job response (see
  // WorkItemTypeCatalogService) -- previously a separate frontend fetch
  // (useWorkItemTypeCatalog), triggered once areaPath resolved into a
  // project name; that round trip (and the client-side project-name
  // derivation it depended on) is gone now that the same server endpoint
  // that already knows the area path resolves this itself.
  const [typeCatalog, setTypeCatalog] = useState<Record<string, WorkItemTypeCatalogEntry> | null>(null);
  // Confirm and Reject are mutually exclusive, job-terminating writes -- a
  // synchronous ref guard (state alone is too slow: clicks before the first
  // re-render read the stale false from closure) prevents a double-submit
  // race between the two buttons or a double-click on either.
  const isMutatingRef = useRef(false);
  const [isMutating, setIsMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Separate guard from isMutatingRef/isMutating above -- those gate
  // Confirm/Reject/Cancel specifically; diff edits (exclude/save/add-child)
  // are a different mutation class and shouldn't disable those buttons.
  const isDiffMutatingRef = useRef(false);
  const [isDiffMutating, setIsDiffMutating] = useState(false);

  // Extracted so the error-state Retry button can re-run the same fetch,
  // not just the initial mount effect.
  function loadJob(): () => void {
    if (!id) return () => {};
    let cancelled = false;
    setLoadError(false);
    getJob(id)
      .then((job) => {
        if (cancelled) return;
        setStatus(job.status);
        setMode(job.mode);
        setKbCitations(job.kbCitations ?? []);
        setWarnings(job.warnings ?? []);
        // Seeds the FigureDescriptions panel from what's already durably
        // persisted (see Job.figureDescriptions) -- previously this panel
        // was fed ONLY by live SSE narration, so it went blank on reload or
        // when reopening a completed job even though the captions
        // themselves had already reached ADO. The live SSE handler below
        // writes into this SAME state and naturally overwrites these seeded
        // values during an active run.
        setFigureCaptionsByIndex((current) => {
          const seeded: Record<number, string> = {};
          for (const entry of job.figureDescriptions ?? []) {
            seeded[entry.figureIndex] = entry.caption;
          }
          return { ...seeded, ...current };
        });
        setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
        setStartedAt(job.createdAt);
        setAreaPath(job.areaPath);
        setIterationPath(job.iterationPath ?? null);
        setWorkItemState(job.state ?? null);
        setSourceFilename(job.originalFilename);
        setTypeCatalog(job.workItemTypeCatalog ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }

  useEffect(loadJob, [id]);

  useEffect(() => {
    if (!id || status !== 'diff_ready') return;
    let cancelled = false;
    getSummary(id)
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch(() => {
        // Best-effort: the stat tiles just don't render if this fails --
        // the diff tree itself (already loaded) remains fully usable.
      });
    return () => {
      cancelled = true;
    };
  }, [id, status]);

  // Fetched on every mount, regardless of status -- previously gated to
  // terminal statuses only, which meant reconnecting to (or refreshing) a
  // STILL-RUNNING job's page showed only the live SSE tail's bounded recent
  // window, nothing from before the reconnect. Confirmed live: this made a
  // multi-hour job's activity/figure counts look like they'd REGRESSED on
  // reload (e.g. 39 figures down to 20) even though nothing was actually
  // lost -- the durable history this fetches has always had everything,
  // the frontend just never asked for it while the job was still running.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    getEventHistory(id)
      .then((events) => {
        if (!cancelled) setEventHistory(events);
      })
      .catch(() => {
        // Best-effort: falls back to whatever's already in client-side
        // narration state / the plain AuditEntry message -- never blocks
        // rendering the rest of the page over this.
      });
    return () => {
      cancelled = true;
    };
  }, [id, status]);

  // isLive (not raw `status`) is the effect's dependency -- the stage
  // handler below flips status from 'pending' to 'running' on the very
  // first event (see setStatus call), and depending on `status` directly
  // would re-run this effect at that instant, tearing down and reopening
  // the EventSource. Any narration published in that reconnect gap was
  // silently dropped (only partially masked by the SSE controller's
  // replay-last-known-value behavior on reconnect). isLive stays true
  // across the pending->running transition, so the subscription survives
  // it untouched. 'writing' included for the same reason -- confirm() now
  // publishes its own stage/narration events (previously it published
  // nothing at all), and handleConfirm below sets status to 'writing'
  // optimistically, before its own confirmJob() call even resolves, so the
  // subscription needs to already be (or become) live for that status too.
  const isLive = status === 'pending' || status === 'running' || status === 'writing';
  useEffect(() => {
    if (!id || !isLive) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    loadRuntimeConfig().then((config) => {
      if (cancelled) return;
      unsubscribe = subscribeToJobEvents(
        id,
        config.apiBaseUrl,
        (nextStage) => {
          setStage(nextStage);
          setStatus((current) => (current === 'pending' ? 'running' : current));
          if (nextStage === 'diff_ready' || nextStage === 'failed' || nextStage === 'cancelled') {
            getJob(id).then((job) => {
              setStatus(job.status);
              setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
              // The mount-time fetch (loadJob above) almost always got {}
              // here -- the backend only resolves a real catalog once
              // dryRunDiff exists, which it doesn't yet while running.
              // Without this, WorkItemTypeBadge is stuck on its hardcoded
              // fallback icons/colors for the rest of the page's lifetime,
              // even though a real diff (and thus a real catalog) now exists.
              setTypeCatalog(job.workItemTypeCatalog ?? null);
            });
          }
        },
        (narration) => {
          // chunk_warning is deliberately EXCLUDED from `narrations` --
          // that array's `.at(-1)` drives the stepper's current-phase and
          // the ticker's status sentence (JobLifecycleSteps/tickerFor), and
          // a chunk_warning becoming "latest" would misleadingly replace a
          // real "Scoring quality..."-style status with a one-off soft
          // failure notice. It's captured below into liveWarnings instead,
          // which CollapsibleWarnings already renders independently.
          if (narration.phase !== 'chunk_warning') {
            // Cap accumulated narrations -- a long-running SURVEY job with
            // many branches could otherwise grow this list unboundedly for
            // the duration of the whole job.
            setNarrations((current) => [...current, narration].slice(-50));
          }
          if (narration.phase === 'describe_figure' && narration.figureIndex != null && narration.figureCaption) {
            const { figureIndex, figureCaption } = narration;
            setFigureCaptionsByIndex((current) => ({ ...current, [figureIndex]: figureCaption }));
          }
          if (narration.phase === 'section_complete' && narration.branchIndex != null && narration.sectionNodes) {
            const { branchIndex, sectionLabel, sectionNodes, kbGrounded, kbCitations } = narration;
            setSectionResultsByIndex((current) => ({
              ...current,
              [branchIndex]: {
                branchIndex,
                sectionLabel: sectionLabel ?? null,
                nodes: sectionNodes,
                kbGrounded,
                kbCitations,
              },
            }));
          }
          if (narration.phase === 'chunk_warning' && narration.warningMessage) {
            const { warningMessage } = narration;
            setLiveWarnings((current) => (current.includes(warningMessage) ? current : [...current, warningMessage]));
          }
        },
      );
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id, isLive]);

  // Merges the durable event-history fetch above with the live SSE tail --
  // JobEventPersistenceService (orchestrator) stores each event's raw
  // payload verbatim in `detail`, the exact same shape delivered over SSE,
  // so isValidNarrationEvent recovers real NarrationEvent objects from it
  // (plain stage-transition rows fail this check and are correctly
  // dropped -- they're a different concept, handled via onStage). Dedup
  // key mirrors JobEventPersistenceService's own backfill key (phase +
  // message) -- a historical entry already represented in the live tail
  // (the common case: the history fetch and an in-flight SSE connection
  // both cover the same recent window) is dropped rather than shown twice.
  const mergedNarrations = useMemo<NarrationEvent[]>(() => {
    const seen = new Set(narrations.map((n) => `${n.phase}|${n.message}`));
    const historical: NarrationEvent[] = [];
    for (const event of eventHistory) {
      if (isValidNarrationEvent(event.detail) && !seen.has(`${event.detail.phase}|${event.detail.message}`)) {
        historical.push(event.detail);
      }
    }
    return [...historical, ...narrations];
  }, [eventHistory, narrations]);

  // Backfills figureCaptionsByIndex from durable history too -- the live
  // SSE callback above only ever sees events published AFTER this page
  // connects, so a figure described before a reconnect/refresh mid-run
  // (this was the concrete live-confirmed regression: a 39-figure panel
  // came back showing only 20 after navigating away and back) would
  // otherwise never appear here. Functional update, seeded values only --
  // an already-known caption (from job.figureDescriptions or a live event)
  // always wins over a historical one racing it.
  useEffect(() => {
    const seeded: Record<number, string> = {};
    for (const event of eventHistory) {
      const detail = event.detail;
      if (isValidNarrationEvent(detail) && detail.phase === 'describe_figure' && detail.figureIndex != null && detail.figureCaption) {
        seeded[detail.figureIndex] = detail.figureCaption;
      }
    }
    if (Object.keys(seeded).length > 0) {
      setFigureCaptionsByIndex((current) => ({ ...seeded, ...current }));
    }
  }, [eventHistory]);

  const figureDescriptions = useMemo<FigureDescriptionEntry[]>(
    () =>
      Object.entries(figureCaptionsByIndex)
        .map(([figureIndex, caption]) => ({ figureIndex: Number(figureIndex), caption }))
        .sort((a, b) => a.figureIndex - b.figureIndex),
    [figureCaptionsByIndex],
  );

  const sectionResults = useMemo<SectionResultEntry[]>(
    () => Object.values(sectionResultsByIndex).sort((a, b) => a.branchIndex - b.branchIndex),
    [sectionResultsByIndex],
  );

  // While running: only liveWarnings has content (warnings is still []
  // from the one-time getJob fetch). Once terminal, warnings becomes the
  // real, authoritative post-completion list -- deduped against
  // liveWarnings by exact text so nothing shows twice.
  const mergedWarnings = useMemo(
    () => [...warnings, ...liveWarnings.filter((w) => !warnings.includes(w))],
    [warnings, liveWarnings],
  );

  async function handleConfirm(): Promise<void> {
    if (!id || !orgUrl || isMutatingRef.current) return;
    isMutatingRef.current = true;
    setIsMutating(true);
    setMutationError(null);
    setConfirmDialogOpen(false);
    // Optimistic, BEFORE awaiting confirmJob (which now itself takes real
    // minutes and only resolves once the whole write-back finishes) --
    // previously status only flipped to 'writing' AFTER this await
    // resolved, by which point the write-back was already done, so
    // ProgressBanner never had a chance to render during it at all.
    setStatus('writing');
    try {
      const result = await confirmJob(id);
      const job = await getJob(id);
      setStatus(job.status);
      showToast(`Confirmed — ${result.createdCount} work item(s) written to Azure DevOps.`, 'success');
    } catch {
      setMutationError('Confirm failed — the job may be safe to retry. Check the Audit tab for details.');
      // Re-sync with the server's actual status rather than leaving the
      // optimistic 'writing' stuck on screen after a failure -- confirm()
      // durably records partial progress (CreatedItemMapping) even on
      // failure, so job.status reflects the real, safe-to-retry state.
      const job = await getJob(id).catch(() => null);
      if (job) setStatus(job.status);
    } finally {
      isMutatingRef.current = false;
      setIsMutating(false);
    }
  }

  async function handleReject(): Promise<void> {
    if (!id || isMutatingRef.current) return;
    isMutatingRef.current = true;
    setIsMutating(true);
    setMutationError(null);
    try {
      await rejectJob(id);
      setStatus('rejected');
      setRejectDialogOpen(false);
      showToast('Job rejected — nothing was written to Azure DevOps.', 'success');
    } catch {
      setMutationError('Reject failed — please try again.');
    } finally {
      isMutatingRef.current = false;
      setIsMutating(false);
    }
  }

  // Unlike Reject (only ever hit from diff_ready, where the pipeline has
  // already stopped), cancelling a still-running job is cooperative on the
  // backend -- if it's currently blocked on ingestion's long /level call,
  // the status flip to 'cancelled' only takes effect at the pipeline's next
  // checkpoint, not this instant. setStatus('cancelled') here is optimistic
  // UI, not a guarantee the worker has actually stopped yet -- the eventual
  // SSE 'cancelled' stage event (or a future GET /jobs/:id) is what confirms
  // it really has.
  async function handleCancel(): Promise<void> {
    if (!id || isMutatingRef.current) return;
    isMutatingRef.current = true;
    setIsMutating(true);
    setMutationError(null);
    try {
      await cancelJob(id);
      setStatus('cancelled');
      setCancelDialogOpen(false);
      showToast('Cancel requested.', 'success');
    } catch {
      setMutationError('Cancel failed — please try again.');
    } finally {
      isMutatingRef.current = false;
      setIsMutating(false);
    }
  }

  async function handleResubmit(): Promise<void> {
    if (!id || isMutatingRef.current) return;
    isMutatingRef.current = true;
    setIsMutating(true);
    setMutationError(null);
    try {
      const result = await resubmitJob(id);
      setResubmitDialogOpen(false);
      showToast('Resubmitted as a new job.', 'success');
      navigate(`/jobs/${result.jobId}`);
    } catch {
      setMutationError('Resubmit failed — the original file may not have been retained (older jobs, or uploads over the size limit, aren\'t kept). Re-upload it as a new job instead.');
    } finally {
      isMutatingRef.current = false;
      setIsMutating(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!id || isMutatingRef.current) return;
    isMutatingRef.current = true;
    setIsMutating(true);
    setMutationError(null);
    try {
      await deleteJob(id);
      setDeleteDialogOpen(false);
      showToast('Job deleted.', 'success');
      navigate('/jobs');
    } catch {
      setMutationError('Delete failed — please try again.');
    } finally {
      isMutatingRef.current = false;
      setIsMutating(false);
    }
  }

  // Downloads the server-computed summary (GET /jobs/:id/summary) as a JSON
  // file -- a real, exportable report distinct from the diff itself.
  async function handleDownloadSummary(): Promise<void> {
    if (!id) return;
    try {
      const summary = await getSummary(id);
      const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `job-${id}-summary.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast('Failed to download summary — please try again.', 'error');
    }
  }

  async function handleToggleExclude(localId: string, excluded: boolean): Promise<void> {
    if (!id || isDiffMutatingRef.current) return;
    isDiffMutatingRef.current = true;
    setIsDiffMutating(true);
    try {
      const result = await setDiffEntryExcluded(id, localId, excluded);
      setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
    } catch {
      showToast('Failed to update — please try again.', 'error');
    } finally {
      isDiffMutatingRef.current = false;
      setIsDiffMutating(false);
    }
  }

  // Sequential, not Promise.all: setDiffEntryExcluded is a read-modify-write
  // against the job's whole dryRunDiff array server-side (jobs.service.ts)
  // -- concurrent calls would race and drop updates, not just be slower.
  async function handleBulkExclude(excluded: boolean): Promise<void> {
    if (!id || isDiffMutatingRef.current) return;
    const query = filterText.trim().toLowerCase();
    const targets = diff.filter((entry) => {
      const matchesAction = !filterAction || entry.action === filterAction;
      const matchesText = !query || entry.title.toLowerCase().includes(query);
      return matchesAction && matchesText && !!entry.excluded !== excluded;
    });
    if (targets.length === 0) return;
    isDiffMutatingRef.current = true;
    setIsDiffMutating(true);
    let succeeded = 0;
    try {
      for (const entry of targets) {
        const result = await setDiffEntryExcluded(id, entry.localId, excluded);
        setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
        succeeded += 1;
      }
      showToast(`${excluded ? 'Excluded' : 'Included'} ${succeeded} item${succeeded === 1 ? '' : 's'}.`, 'success');
    } catch {
      showToast(`Stopped after updating ${succeeded} of ${targets.length} item(s) — please retry.`, 'error');
    } finally {
      isDiffMutatingRef.current = false;
      setIsDiffMutating(false);
    }
  }

  async function handleSaveEdit(localId: string, patch: { title: string; description: string }): Promise<void> {
    if (!id) return;
    try {
      const result = await editDiffEntry(id, localId, patch);
      setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
      showToast('Changes saved.', 'success');
    } catch {
      showToast('Failed to save changes — please try again.', 'error');
    }
  }

  // CR-7d rescore: re-throws on failure so NodeDetailPanel's own
  // try/catch/finally (its loading-button guard) knows the call failed --
  // this function's job is persisting a success and surfacing a toast
  // either way, not owning the caller's local UI state.
  async function handleRescore(localId: string): Promise<void> {
    if (!id) return;
    try {
      const result = await rescoreDiffEntry(id, localId);
      setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
      showToast('Rescored.', 'success');
    } catch (err) {
      showToast('Failed to rescore — please try again.', 'error');
      throw err;
    }
  }

  async function handleAddChild(parentLocalId: string, input: { type: string; title: string; description: string }): Promise<void> {
    if (!id) return;
    try {
      const result = await addDiffEntry(id, { parentLocalId, ...input });
      setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
      showToast('Item added.', 'success');
    } catch {
      showToast('Failed to add item — please try again.', 'error');
    }
  }

  async function handleShowAudit(): Promise<void> {
    if (!id) return;
    setTab('audit');
    setAudit(await getAudit(id));
    // Best-effort: debug captures are a bonus explaining WHY a warning
    // fired, not a required part of the audit trail -- a failure here must
    // never block the (already-loaded) real AuditEntry rows from showing.
    try {
      setDebugCaptures(await getDebugCaptures(id));
    } catch {
      setDebugCaptures([]);
    }
  }

  const selectedEntry = diff.find((entry) => entry.localId === selectedId) ?? null;

  // localId -> title lookup across the WHOLE job's diff -- lets
  // TraceLinkChips resolve an intraJob trace link's target to a real title
  // instead of showing its raw internal id (e.g. "br0_n7"). See
  // TraceLinkChips.tsx's own doc comment.
  const traceTargetTitles = useMemo(
    () => Object.fromEntries(diff.map((e) => [e.localId, e.title])) as Record<string, string>,
    [diff],
  );

  // localId -> full entry lookup -- lets NodeDetailPanel look up a 'create'
  // entry's own parent (by parentLocalId) to check whether the PARENT
  // already resolved to 'reuse'/'dedup_skip' (a real existing ADO item),
  // so it can tell the reviewer "this will be linked under an existing
  // parent" instead of leaving that only implicit in the parent row's own
  // badge, several rows away in the tree.
  const diffByLocalId = useMemo(() => Object.fromEntries(diff.map((e) => [e.localId, e])), [diff]);

  // DESIGN.md §11.4.1 -- an Epic/Feature has no quality rubric, so its
  // Scope group (NodeDetailPanel.tsx) shows what it covers instead: real
  // Feature/Requirement descendant counts from the diff tree. A
  // children-by-parent index + a memoized per-node walk, not a `.filter`
  // call inside recursion, so this stays O(n) even on a large document.
  const descendantCountsByLocalId = useMemo(() => {
    const childrenByParent = new Map<string, DryRunDiffEntry[]>();
    for (const entry of diff) {
      if (entry.parentLocalId) {
        childrenByParent.set(entry.parentLocalId, [...(childrenByParent.get(entry.parentLocalId) ?? []), entry]);
      }
    }
    const cache = new Map<string, { features: number; requirements: number }>();
    function countFor(localId: string): { features: number; requirements: number } {
      const cached = cache.get(localId);
      if (cached) return cached;
      let features = 0;
      let requirements = 0;
      for (const child of childrenByParent.get(localId) ?? []) {
        if (child.type === 'Feature') features += 1;
        if (child.type === 'Requirement') requirements += 1;
        const sub = countFor(child.localId);
        features += sub.features;
        requirements += sub.requirements;
      }
      const result = { features, requirements };
      cache.set(localId, result);
      return result;
    }
    const result: Record<string, { features: number; requirements: number }> = {};
    for (const entry of diff) result[entry.localId] = countFor(entry.localId);
    return result;
  }, [diff]);

  // Real gap this closes (user-reported): a conflict warning's
  // "[localId: ...]" is internal to THIS run and never a real ADO work
  // item number -- for a near-duplicate that's already an ADO item
  // (dedup_skip/reuse), this lets CollapsibleWarnings offer a real deep
  // link to it instead of only the meaningless-outside-this-app localId.
  // Only entries with a real existingAdoId are included.
  const adoIdByLocalId = useMemo(() => {
    const result: Record<string, number> = {};
    for (const entry of diff) {
      if (entry.existingAdoId != null) result[entry.localId] = entry.existingAdoId;
    }
    return result;
  }, [diff]);

  // Same filter predicate DiffTree applies internally (see its own `rows`
  // useMemo) -- NOT collapse-aware, since collapse state is internal to
  // DiffTree and not lifted here. Good enough for "step to the next
  // visible-by-filter item"; a collapsed subtree being skipped over by
  // prev/next is an acceptable simplification, not a correctness bug.
  const filteredForNav = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return diff.filter((entry) => {
      const matchesAction = !filterAction || entry.action === filterAction;
      const matchesText = !query || entry.title.toLowerCase().includes(query);
      return matchesAction && matchesText;
    });
  }, [diff, filterAction, filterText]);

  function handleNavigateDialog(direction: 'prev' | 'next'): void {
    const currentIndex = filteredForNav.findIndex((entry) => entry.localId === selectedId);
    if (currentIndex === -1) return;
    const nextIndex = direction === 'next' ? Math.min(filteredForNav.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
    setSelectedId(filteredForNav[nextIndex].localId);
  }

  const navIndex = filteredForNav.findIndex((entry) => entry.localId === selectedId);
  const hasPrevEntry = navIndex > 0;
  const hasNextEntry = navIndex !== -1 && navIndex < filteredForNav.length - 1;

  if (loadError) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Alert severity="error">Couldn't load this job. Check your connection and try again.</Alert>
        <Button variant="outline" className="self-start" onClick={loadJob}>
          Retry
        </Button>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <div className="grid grid-cols-3 gap-2.5">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const teamProject = areaPath?.split('\\')[0] ?? null;
  // The real ADO credential lives server-side (credential vault); orgUrl
  // being set locally just signals "this browser has completed login" --
  // that's the gate for showing Confirm as available at all.
  const canWriteToAdo = !!orgUrl;
  const showTabs = shouldShowTabs(status, diff.length, audit.length);
  const showFilterBar = shouldShowFilterBar(diff.length);
  const showTiles = shouldShowTiles(status);
  // Structured failure detail (phase/elapsed/error type/message) from the
  // durable event history -- replaces a bare "Failed" chip + one flattened
  // AuditEntry line with the real context /level's exception handler
  // captured. `undefined` (not found) for jobs that predate this change,
  // or that failed somewhere other than /level -- the EmptyState below
  // falls back to today's plain AuditEntry-derived message in that case.
  const jobFailedEvent = eventHistory.find((event) => event.phase === 'job_failed');

  return (
    // px-2 lives on this one outer container -- every child below relies on
    // it for its horizontal inset instead of re-declaring its own mx-2/px-2
    // (previously scattered per-element and inconsistently: header had
    // px-2, the mutation-error alert had mx-2, CollapsibleWarnings had its
    // own mx-2, and the Tabs block had none at all -- content visibly
    // didn't line up down the page).
    <div className="flex flex-col gap-3 px-2">
      <div className="flex flex-col gap-1 border-b border-hairline pb-2 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            {sourceFilename && <span className="truncate text-sm font-medium text-ink-1">{sourceFilename}</span>}
            {status && <StatusChip status={status} />}
            {mode && <ModeBadge mode={mode as 'baseline' | 'survey'} />}
            {startedAt && (
              <Tooltip content={new Date(startedAt).toLocaleString()}>
                <span className="font-mono text-xs text-ink-3">{new Date(startedAt).toLocaleDateString()}</span>
              </Tooltip>
            )}
          </div>
          <div className="flex flex-none flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={handleDownloadSummary}>
              Download summary
            </Button>
            {(status === 'pending' || status === 'running') && (
              <Button variant="danger" onClick={() => setCancelDialogOpen(true)} disabled={isMutating}>
                Cancel run
              </Button>
            )}
            {status === 'diff_ready' && (
              <>
                <Button variant="danger" onClick={() => setRejectDialogOpen(true)} disabled={isMutating}>
                  Reject
                </Button>
                <Tooltip content={canWriteToAdo ? 'Write the reviewed items to Azure DevOps' : 'Sign in with an Azure DevOps org URL and PAT to confirm'}>
                  <span>
                    <Button variant="cta" onClick={() => setConfirmDialogOpen(true)} disabled={isMutating || !canWriteToAdo}>
                      Confirm
                    </Button>
                  </span>
                </Tooltip>
              </>
            )}
            {status !== 'pending' && status !== 'running' && status !== 'writing' && (
              <>
                <Button variant="outline" size="sm" onClick={() => setResubmitDialogOpen(true)} disabled={isMutating}>
                  Resubmit
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDeleteDialogOpen(true)} disabled={isMutating}>
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
        {(teamProject || areaPath) && (
          <div className="mt-1">
            <DestinationBar teamProject={teamProject} areaPath={areaPath} iterationPath={iterationPath} state={workItemState} />
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        title="Write these items to Azure DevOps?"
        description={
          <>
            This creates{summary ? ` ${summary.created} new work item${summary.created === 1 ? '' : 's'}` : ' the reviewed work items'} under{' '}
            <strong>{areaPath ?? 'the configured area path'}</strong>. This cannot be undone from req2ado — items must be deleted directly in
            Azure DevOps afterward.
          </>
        }
        confirmLabel="Confirm and write"
        onConfirm={handleConfirm}
        isConfirming={isMutating}
        variant="irreversible"
      />
      <ConfirmDialog
        open={rejectDialogOpen}
        onOpenChange={setRejectDialogOpen}
        title="Reject this job?"
        description="Nothing has been written to Azure DevOps yet, so nothing is undone -- this only marks the job as rejected and closes review."
        confirmLabel="Reject job"
        onConfirm={handleReject}
        isConfirming={isMutating}
        variant="destructive"
      />
      <ConfirmDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        title="Cancel this run?"
        description="Nothing has been written to Azure DevOps yet. If the job is still actively parsing or analyzing the document, cancelling may take effect at its next checkpoint rather than instantly."
        confirmLabel="Cancel run"
        onConfirm={handleCancel}
        isConfirming={isMutating}
        variant="destructive"
      />
      <ConfirmDialog
        open={resubmitDialogOpen}
        onOpenChange={setResubmitDialogOpen}
        title="Resubmit this job?"
        description="Runs the same source document again as a new job, using the same settings. If nothing in the document or destination has changed, Confirm on the new job will reuse the same Azure DevOps items rather than creating duplicates."
        confirmLabel="Resubmit"
        onConfirm={handleResubmit}
        isConfirming={isMutating}
      />
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete this job?"
        description={
          status === 'succeeded'
            ? 'This removes the job and its history from req2ado only -- any work items already written to Azure DevOps are NOT deleted and must be removed there directly, if wanted. This cannot be undone.'
            : 'This permanently removes the job and its history from req2ado. This cannot be undone.'
        }
        confirmLabel="Delete job"
        onConfirm={handleDelete}
        isConfirming={isMutating}
        variant="destructive"
      />
      {mutationError && (
        <Alert severity="error" onClose={() => setMutationError(null)}>
          {mutationError}
        </Alert>
      )}
      {mode && status && (
        <div className="mb-4 overflow-hidden rounded-md border border-hairline">
          <JobLifecycleSteps
            mode={mode as 'baseline' | 'survey'}
            status={status}
            stage={stage}
            // job_failed is itself the LAST narration on a job that died
            // mid-pipeline -- its own .phase ('job_failed') isn't one of
            // the real pipeline phases the stepper knows how to place, so
            // on its own it always fell through to a hardcoded, often-wrong
            // default. Ingestion already publishes exactly the phase the
            // job was on when it died as this event's own lastPhase field
            // (see api/events.ts) -- use that instead when it's present.
            latestNarrationPhase={
              mergedNarrations.at(-1)?.phase === 'job_failed'
                ? (mergedNarrations.at(-1)?.lastPhase ?? null)
                : (mergedNarrations.at(-1)?.phase ?? null)
            }
          />
          <NarrationTicker
            sentence={tickerFor({ status, stage, latest: mergedNarrations.at(-1) ?? null }).sentence}
            isLive={(status === 'pending' || status === 'running' || status === 'writing') && !!startedAt}
            startedAt={startedAt ?? ''}
          />
        </div>
      )}
      {status === 'pending' && (
        <Alert severity="info">
          <span className="flex items-center gap-2">
            <Spinner /> Queued — waiting for a pipeline worker to pick this job up.
          </span>
        </Alert>
      )}
      {isRunDetailStatus(status) && stage && mode && startedAt && (
        <ProgressBanner stage={stage} startedAt={startedAt} mode={mode as 'baseline' | 'survey'} narrations={mergedNarrations} />
      )}
      <FigureDescriptions items={figureDescriptions} />
      <SectionResults items={sectionResults} />
      {showTiles && summary && (
        // Plain tiles -- no icon/hint/interactive. Confirmed against the
        // agreed mockup (§11.3): these three tiles render as bare
        // value+label, unlike the wizard's Blocks/Sections/Figures/Depth
        // tiles which DO carry icon+hint because those are unfamiliar
        // parsing terms that genuinely need a one-line explanation. "New,"
        // "Reused," and "Duplicates skipped" are already plain English --
        // adding an icon and a hint restating the label in slightly longer
        // words was over-explaining the obvious, not adding real
        // information. (An earlier pass this session added icon/hint here
        // without having seen the mockup; reverted once the mockup showed
        // otherwise.)
        <div className="grid grid-cols-3 gap-2.5">
          <StatTile value={summary.created} label="New" tone="ok" />
          <StatTile value={summary.reused} label="Reused" />
          <StatTile value={summary.dedupSkipped} label="Duplicates skipped" tone={summary.dedupSkipped > 0 ? 'warning' : 'dim'} />
        </div>
      )}
      <CollapsibleWarnings
        warnings={mergedWarnings}
        onJumpToNode={(localId) => {
          setTab('tree');
          setSelectedId(localId);
        }}
        adoIdByLocalId={adoIdByLocalId}
        orgUrl={orgUrl}
        project={teamProject}
      />
      {showTabs ? (
        <Tabs
          value={tab}
          onValueChange={(value) => (value === 'audit' ? handleShowAudit() : setTab(value as 'tree' | 'audit'))}
          tabs={[
            { value: 'tree', label: `Diff (${diff.length})` },
            { value: 'audit', label: `Audit (${audit.length})` },
          ]}
        >
          {tab === 'tree' ? (
            <div className="pt-3">
              <Card>
                {showFilterBar && (
                  <div className="flex flex-wrap gap-2 border-b border-hairline p-3">
                    <TextField
                      placeholder="Filter by title…"
                      value={filterText}
                      onChange={(e) => setFilterText(e.target.value)}
                      className="max-w-[240px] flex-1"
                    />
                    <Select value={filterAction ?? ''} onChange={(e) => setFilterAction(e.target.value || null)} className="max-w-[160px]">
                      <option value="">All actions</option>
                      <option value="create">New</option>
                      <option value="reuse">Reuse</option>
                      <option value="dedup_skip">Near-duplicate</option>
                    </Select>
                    {status === 'diff_ready' && (
                      <div className="ml-auto flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => handleBulkExclude(true)} disabled={isDiffMutating}>
                          Exclude {filterAction || filterText ? 'matching' : 'all'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleBulkExclude(false)} disabled={isDiffMutating}>
                          Include {filterAction || filterText ? 'matching' : 'all'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                <DiffTree
                  entries={diff}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onOpenDetails={(localId) => {
                    setSelectedId(localId);
                    setDialogOpen(true);
                  }}
                  filterAction={filterAction}
                  filterText={filterText}
                  onToggleExclude={handleToggleExclude}
                  typeCatalog={typeCatalog ?? undefined}
                  orgUrl={orgUrl}
                  project={teamProject}
                />
              </Card>
              <NodeDetailDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                jobId={id!}
                entry={selectedEntry}
                jobMode={mode as 'baseline' | 'survey' | null}
                jobStatus={status}
                kbCitations={kbCitations}
                traceTargetTitles={traceTargetTitles}
                diffByLocalId={diffByLocalId}
                descendantCountsByLocalId={descendantCountsByLocalId}
                onSave={handleSaveEdit}
                onRescore={handleRescore}
                onAddChild={handleAddChild}
                onNavigate={handleNavigateDialog}
                hasPrev={hasPrevEntry}
                hasNext={hasNextEntry}
                typeCatalog={typeCatalog ?? undefined}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <AuditEntryList entries={audit} />
              {debugCaptures.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-hairline pt-3">
                  <span className="text-xs font-semibold text-ink-2">
                    Raw model responses behind flagged warnings ({debugCaptures.length})
                  </span>
                  {debugCaptures.map((capture, index) => (
                    <details key={`${capture.kind}-${capture.identifier}-${index}`} className="rounded-sm border border-hairline bg-surface-alt p-2.5">
                      <summary className="cursor-pointer text-xs font-medium text-ink-2">
                        {capture.kind} — {capture.identifier}
                      </summary>
                      <pre className="mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap font-mono text-xs text-ink-2">
                        {capture.content}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
        </Tabs>
      ) : isRunDetailStatus(status) ? (
        // Real bug this fixes (confirmed live): shouldShowTabs also returns
        // false for a genuinely RUNNING job before its first diff/audit
        // fetch (diff.length and audit.length both still 0 at that point) --
        // not just cancelled/failed, contrary to what the comment on the
        // branch below used to assume. Without this guard, a job actively
        // ticking through Analyze/Score in the ProgressBanner above ALSO
        // rendered "Cancelled before a diff was produced" underneath it at
        // the exact same time -- a running job simultaneously showing
        // cancelled-state UI. The live progress banner already fully covers
        // this state; nothing else needs to render here while it's running.
        null
      ) : (
        // No diff and no audit fetched yet -- Diff (0)/Audit (0) tabs, an
        // empty filter bar, and an empty table were pure dead space here
        // (the "all the bottom part is not relevant" complaint). Only
        // reachable by cancelled (before diff_ready) and failed (diff never
        // produced) -- every other status either has a real diff already
        // or is still mid-run, handled by the isRunDetailStatus branch above.
        <Card>
          <EmptyState
            icon={FileX2}
            // Real bug fixed here (confirmed live): a job that fails mid-run
            // hard enough to kill the worker process before its own
            // catch-and-mark-failed logic can run stays status='running'
            // with no further activity, until the stale-job watchdog
            // eventually auto-cancels it -- overwriting a REAL failure with
            // a generic "cancelled" status. This card used to key its title/
            // copy purely off `status`, so a job that had genuinely parsed,
            // scored, and reached trace-link inference before dying showed
            // "Cancelled before a diff was produced... before parsing/
            // analysis finished" -- flatly false. jobFailedEvent (the
            // durable job_failed record) is the honest signal here,
            // independent of whatever `status` the job settled on.
            title={jobFailedEvent || status === 'failed' ? 'No diff was produced' : 'Cancelled before a diff was produced'}
            description={
              jobFailedEvent ? (
                // Structured detail from the durable event history --
                // phase/elapsed/error type/message, replacing the plain
                // "check the audit trail" string with the real context
                // /level's exception handler captured.
                (() => {
                  const detail = (jobFailedEvent.detail ?? {}) as {
                    errorType?: string | null;
                    errorMessage?: string | null;
                    elapsedSeconds?: number | null;
                    lastPhase?: string | null;
                  };
                  return (
                    <span className="flex flex-col gap-1 text-left">
                      <span>{detail.errorMessage ?? jobFailedEvent.message}</span>
                      <span className="text-ink-3">
                        {[
                          detail.errorType,
                          detail.lastPhase ? `last phase: ${detail.lastPhase}` : null,
                          detail.elapsedSeconds != null ? `after ${Math.round(detail.elapsedSeconds)}s` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  );
                })()
              ) : status === 'failed' ? (
                'This job failed before completing analysis. Check the audit trail for details.'
              ) : (
                'This run was cancelled before parsing/analysis finished, so there is nothing to review.'
              )
            }
            action={
              <Button variant="outline" size="sm" onClick={handleShowAudit}>
                {audit.length > 0 ? 'Refresh audit' : 'View audit'}
              </Button>
            }
          />
          {/* Prefers the durable full event history (JobEventRecord's shape
              is a structural superset of AuditEntry's -- id/message/
              createdAt) over the coarse AuditEntry list once it's loaded;
              falls back to `audit` for a job that predates this change or
              while the event-history fetch is still in flight. */}
          <AuditEntryList entries={eventHistory.length > 0 ? eventHistory : audit} className="border-t border-hairline p-4" />
        </Card>
      )}
    </div>
  );
}

function AuditEntryList({ entries, className }: { entries: AuditEntry[]; className?: string }): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <div className={className ?? 'flex flex-col gap-1'}>
      {entries.map((entry) => (
        <p key={entry.id} className="flex gap-2.5 text-xs">
          <span className="flex-none font-mono text-ink-3">{new Date(entry.createdAt).toLocaleString()}</span>
          <span className="font-mono text-ink-2">{entry.message}</span>
        </p>
      ))}
    </div>
  );
}
