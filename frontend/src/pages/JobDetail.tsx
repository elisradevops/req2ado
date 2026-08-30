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
  moveDiffEntry,
  rescoreDiffEntry,
  rejectJob,
  cancelJob,
  deleteJob,
  resubmitJob,
  getSummary,
  attachFigureToAdo,
  retryTraceLinkWrite,
  validateCreatedTree,
  type AuditEntry,
  type DebugCaptureEntry,
  type JobEventRecord,
  type JobSummaryReport,
  type MoveDiffEntryInput,
  type ValidationResult,
} from '../api/jobs';
import { subscribeToJobEvents, isValidNarrationEvent, type JobStage, type NarrationEvent } from '../api/events';
import { loadRuntimeConfig } from '../api/config';
import { useOrgUrl } from '../store/authStore';
import { StatusChip } from '../components/StatusChip';
import { ModeBadge } from '../components/ModeBadge';
import { ProgressBanner } from '../components/ProgressBanner';
import { JobLifecycleSteps, type LifecycleKey } from '../components/JobLifecycleSteps';
import {
  parseDeterministicSubtreeChunk,
  formatDeterministicSubtreePassSubLabel,
} from '../utils/deterministicSubtreeChunk';
import { NarrationTicker } from '../components/NarrationTicker';
import { tickerFor } from '../utils/narrationTicker';
import { DiffTree, type DryRunDiffEntry } from '../components/DiffTree';
import { NodeDetailDialog } from '../components/NodeDetailDialog';
import { AddChildCard } from '../components/AddChildCard';
import { applyMoveOptimistically } from '../lib/applyMove';
import { cn } from '../lib/cn';
import { isFlaggedDiffEntry } from '../utils/diffFlagging';
import { useToast } from '../components/ToastProvider';
import type { KbCitation } from '../components/KbCitationChips';
import type { TraceLinkFailure } from '../store/jobsStore';
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
import { normalizeWarning, type WarningRecord } from '../utils/warnings';
import { matchesDiffFilter } from '../utils/diffFilterMatch';
import { FigureDescriptions, type FigureDescriptionEntry } from '../components/FigureDescriptions';
import { SectionResults, type SectionResultEntry } from '../components/SectionResults';
import type { WorkItemTypeCatalogEntry } from '../api/ado';
import { isRunDetailStatus, shouldShowTiles, shouldShowTabs, shouldShowFilterBar } from './jobDetailLayout';
import { FileX2 } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';
import { LABEL_MICRO } from '../utils/labelMicro';

// WID 300578's own field/expected/actual can carry the item's full
// (HTML-normalized) description -- long, and often not useful in full for
// spotting WHICH mismatch this is. Collapsed to one readable line, same
// convention as SourceProvenance/other single-line previews elsewhere in
// this app.
const VALIDATION_MISMATCH_PREVIEW_LENGTH = 80;

function truncateForDisplay(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= VALIDATION_MISMATCH_PREVIEW_LENGTH) return collapsed;
  return `${collapsed.slice(0, VALIDATION_MISMATCH_PREVIEW_LENGTH)}…`;
}

export function JobDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const orgUrl = useOrgUrl();
  const { showToast } = useToast();
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [documentOverview, setDocumentOverview] = useState<{ synopsis: string; caveat: string | null } | null>(null);
  const [kbCitations, setKbCitations] = useState<KbCitation[]>([]);
  // STAGE 2 mapping's own excluded lists (see jobsStore.JobDetail's own
  // comment) -- same load/refetch lifecycle as kbCitations above (only
  // known once the tree exists, so seeded at mount and refreshed once the
  // job reaches a terminal narration stage).
  const [excludedFigureIds, setExcludedFigureIds] = useState<string[]>([]);
  const [excludedTableIds, setExcludedTableIds] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<(WarningRecord | string)[]>([]);
  // Task 4: JobTraceLinkFailure rows -- see NodeDetailPanel's own doc
  // comment for how these gate the per-link retry control. Not removed
  // locally on a successful retry (mirroring the figure-attach pattern):
  // NodeDetailPanel's own traceLinkRetryStatus map is what flips the
  // control to its "done" state; this list just stays as of the last load.
  const [traceLinkFailures, setTraceLinkFailures] = useState<TraceLinkFailure[]>([]);
  // See jobsStore.ts's JobDetail.createdItemCount doc comment.
  const [createdItemCount, setCreatedItemCount] = useState(0);
  // WID 300578: result of the last manual "Validate" click -- diffs the
  // real ADO state of every created/resumed item against the confirmed
  // dryRunDiff. null until the reviewer actually runs it; not auto-run on
  // load (a real ADO round-trip per created item, not a free check).
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
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
  // Task 5: the document's own figure name (parsed at ingest time, not a
  // vision-narrated value) -- unlike figureCaptionsByIndex, this has no
  // live-SSE counterpart (narration events never carry a name), so it is
  // seeded ONLY from Job.figureDescriptions in the fetch effect below.
  const [figureNamesByIndex, setFigureNamesByIndex] = useState<Record<number, string | null>>({});
  // No live-narration counterpart, unlike figureCaptionsByIndex above --
  // tables are never narrated during a run, so this is populated once from
  // Job.tableDescriptions in the fetch effect below and never merged with
  // anything else.
  const [tableDescriptions, setTableDescriptions] = useState<{ tableId: string; caption: string }[]>([]);
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
  const [filterFlaggedOnly, setFilterFlaggedOnly] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Resolved server-side and embedded directly in the job response (see
  // WorkItemTypeCatalogService) -- previously a separate frontend fetch
  // (useWorkItemTypeCatalog), triggered once areaPath resolved into a
  // project name; that round trip (and the client-side project-name
  // derivation it depended on) is gone now that the same server endpoint
  // that already knows the area path resolves this itself.
  const [typeCatalog, setTypeCatalog] = useState<Record<string, WorkItemTypeCatalogEntry> | null>(null);
  // Category ('Epic'/'Feature'/'Requirement') -> this project's real ADO
  // type name, for AddChildForm's type picker LABELS only -- the value it
  // submits always stays the category. See jobsStore.ts's own doc comment.
  const [categoryLabels, setCategoryLabels] = useState<Record<'Epic' | 'Feature' | 'Requirement', string> | null>(null);
  // The SAME field JobsService.confirm() will actually write a Requirement's
  // classification to -- see jobsStore.ts's own doc comment.
  const [requirementClassificationField, setRequirementClassificationField] = useState<{ referenceName: string; allowedValues: string[] } | null>(null);
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
  // Guards the SSE connection-error toast against firing on every single
  // retry attempt -- EventSource retries a dropped/401'd connection
  // forever on its own; without this a persistent outage would spam one
  // toast per retry instead of one until the connection actually recovers.
  const hasShownSseErrorRef = useRef(false);

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
        setDocumentOverview(job.documentOverview ?? null);
        setKbCitations(job.kbCitations ?? []);
        setExcludedFigureIds(job.excludedFigureIds ?? []);
        setExcludedTableIds(job.excludedTableIds ?? []);
        setWarnings(job.warnings ?? []);
        setTraceLinkFailures(job.traceLinkFailures ?? []);
        setCreatedItemCount(job.createdItemCount ?? 0);
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
            if (entry.caption) seeded[entry.figureIndex] = entry.caption;
          }
          return { ...seeded, ...current };
        });
        // Task 5: same seed-only, seeded-values-yield-to-current merge
        // shape as captions above -- names have no live counterpart to
        // race against, but the merge order is kept identical for
        // consistency and in case a future live source is ever added.
        setFigureNamesByIndex((current) => {
          const seeded: Record<number, string | null> = {};
          for (const entry of job.figureDescriptions ?? []) {
            seeded[entry.figureIndex] = entry.name;
          }
          return { ...seeded, ...current };
        });
        setTableDescriptions(job.tableDescriptions ?? []);
        setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
        setStartedAt(job.createdAt);
        setAreaPath(job.areaPath);
        setIterationPath(job.iterationPath ?? null);
        setWorkItemState(job.state ?? null);
        setSourceFilename(job.originalFilename);
        setTypeCatalog(job.workItemTypeCatalog ?? null);
        setCategoryLabels(job.workItemTypeCategoryLabels ?? null);
        setRequirementClassificationField(job.requirementClassificationField ?? null);
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
          hasShownSseErrorRef.current = false;
          setStage(nextStage);
          setStatus((current) => (current === 'pending' ? 'running' : current));
          if (nextStage === 'diff_ready' || nextStage === 'failed' || nextStage === 'cancelled') {
            getJob(id).then((job) => {
              if (cancelled) return;
              setStatus(job.status);
              setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
              // The mount-time fetch (loadJob above) almost always got {}
              // here -- the backend only resolves a real catalog once
              // dryRunDiff exists, which it doesn't yet while running.
              // Without this, WorkItemTypeBadge is stuck on its hardcoded
              // fallback icons/colors for the rest of the page's lifetime,
              // even though a real diff (and thus a real catalog) now exists.
              setTypeCatalog(job.workItemTypeCatalog ?? null);
              setCategoryLabels(job.workItemTypeCategoryLabels ?? null);
              setRequirementClassificationField(job.requirementClassificationField ?? null);
              // Real bug (user-reported): warnings/kbCitations are written
              // to the Job row by this SAME pipeline.worker.ts update that
              // sets status/dryRunDiff/workItemTypeCatalog (all handled
              // above) -- omitting these two here meant they stayed stuck
              // at their mount-time value ([], since the job was still
              // running when loadJob's own getJob() call resolved) for the
              // rest of the page's lifetime. Confirmed live: the warnings
              // panel only ever showed content after a manual reload, which
              // re-runs loadJob() and picks them up for the first time.
              setWarnings(job.warnings ?? []);
              // Same reasoning as warnings/kbCitations above -- trace-link
              // write failures are also only known once confirm() has run,
              // which happens after this SSE completion callback fires, not
              // at mount-time loadJob().
              setTraceLinkFailures(job.traceLinkFailures ?? []);
              setCreatedItemCount(job.createdItemCount ?? 0);
              setKbCitations(job.kbCitations ?? []);
              setExcludedFigureIds(job.excludedFigureIds ?? []);
              setExcludedTableIds(job.excludedTableIds ?? []);
              // No live-narration counterpart (tables are never narrated
              // during a run, see tableDescriptions' own useState doc
              // comment) -- this refetch is the only point after the
              // mount-time loadJob() where a freshly-completed job's real
              // captions become available.
              setTableDescriptions(job.tableDescriptions ?? []);
            }).catch(() => {
              // Real gap this closes: this is the ONLY path that populates
              // the real terminal status/diff/warnings/citations/etc. --
              // an unhandled rejection here previously left the page stuck
              // showing a stale "running" view forever with zero signal
              // that anything went wrong.
              if (cancelled) return;
              showToast('Lost connection while finishing up -- reload the page to see the final result.', 'error');
            });
          }
        },
        (narration) => {
          hasShownSseErrorRef.current = false;
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
          // figureCaptionStatus (non-null) means the model judged this
          // figure insignificant/failed -- figureCaption is STILL truthy in
          // that case (ingestion substitutes an honest placeholder so the
          // ProgressBanner ticker line is never blank), so the truthy check
          // alone is not enough here. Excluding on figureCaptionStatus
          // matches pipeline.worker.ts's own Boolean(caption) rule for the
          // PERSISTED Job.figureDescriptions column -- without this, a
          // logo/warning-icon correctly judged decorative during a live run
          // still showed up as a full entry in this panel, then vanished on
          // reload once the persisted, already-correct data took over.
          if (
            narration.phase === 'describe_figure' &&
            narration.figureIndex != null &&
            narration.figureCaption &&
            !narration.figureCaptionStatus
          ) {
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
        () => {
          // Real gap this closes: EventSource retries a dropped/expired-
          // session connection forever on its own with no signal at all --
          // previously a silent infinite reconnect loop. One toast per
          // outage (reset by hasShownSseErrorRef above once a real event
          // arrives again), not one per retry attempt.
          if (cancelled || hasShownSseErrorRef.current) return;
          hasShownSseErrorRef.current = true;
          showToast('Lost the live connection to this job -- reconnecting...', 'error');
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
      // Same figureCaptionStatus exclusion as the live SSE handler above --
      // this is a SEPARATE population site reading from durable history,
      // not a call-through to that handler, so it needs the same guard
      // independently. Missing here on a first pass at the live-handler fix
      // is exactly why an insignificant figure still appeared: every job
      // page mount fetches eventHistory regardless of live/reconnect state
      // (see this effect's own comment), so this path ran on every load.
      if (
        isValidNarrationEvent(detail) &&
        detail.phase === 'describe_figure' &&
        detail.figureIndex != null &&
        detail.figureCaption &&
        !detail.figureCaptionStatus
      ) {
        seeded[detail.figureIndex] = detail.figureCaption;
      }
    }
    if (Object.keys(seeded).length > 0) {
      setFigureCaptionsByIndex((current) => ({ ...seeded, ...current }));
    }
  }, [eventHistory]);

  const figureDescriptions = useMemo<FigureDescriptionEntry[]>(
    () => {
      // Task 5: UNION of both maps' keys, not just figureCaptionsByIndex's
      // own -- a figure with a document-provided name but no real caption
      // (vision disabled/failed) has an entry ONLY in figureNamesByIndex,
      // and must still appear here (mirrors the orchestrator's own widened
      // "caption OR name" filter in pipeline.worker.ts).
      const figureIndexes = new Set([
        ...Object.keys(figureCaptionsByIndex).map(Number),
        ...Object.keys(figureNamesByIndex).map(Number),
      ]);
      return Array.from(figureIndexes)
        // figureId derivation matches ingestion's own established convention
        // exactly (main.py's _describe_figure_with_progress: `figure_id =
        // f"f{index - 1}"`, where `index` IS this same 1-based figureIndex)
        // -- every loader appends a figure immediately after describing it,
        // in the same order, so this lockstep relationship is guaranteed,
        // not a guess. See FigureDescriptionEntry.figureId's own doc comment.
        .map((figureIndex) => ({
          figureIndex,
          caption: figureCaptionsByIndex[figureIndex] ?? null,
          name: figureNamesByIndex[figureIndex] ?? null,
          figureId: `f${figureIndex - 1}`,
        }))
        .sort((a, b) => a.figureIndex - b.figureIndex);
    },
    [figureCaptionsByIndex, figureNamesByIndex],
  );

  // localId -> caption lookup keyed by the SAME figureId scheme, derived
  // from the array above rather than a second independent pass over
  // figureCaptionsByIndex -- lets NodeDetailPanel's own per-entry Figures
  // section (entry.figureIds) show each figure's caption without needing
  // its own figureIndex/figureId translation.
  const captionByFigureId = useMemo(
    () => Object.fromEntries(figureDescriptions.map((d) => [d.figureId, d.caption])),
    [figureDescriptions],
  );

  // Task 5: same figureId-keyed lookup shape as captionByFigureId, for the
  // document's own figure name -- lets NodeDetailPanel/NodeDetailDialog
  // show a real name instead of a bare "Figure N" label.
  const nameByFigureId = useMemo(
    () => Object.fromEntries(figureDescriptions.map((d) => [d.figureId, d.name])),
    [figureDescriptions],
  );

  // tableId -> Table.caption -- lets NodeDetailPanel's own per-entry Tables
  // section (entry.tableIds) show a readable title without needing its own
  // lookup over the raw tableDescriptions array.
  const captionByTableId = useMemo(
    () => Object.fromEntries(tableDescriptions.map((d) => [d.tableId, d.caption])),
    [tableDescriptions],
  );

  const sectionResults = useMemo<SectionResultEntry[]>(
    () => Object.values(sectionResultsByIndex).sort((a, b) => a.branchIndex - b.branchIndex),
    [sectionResultsByIndex],
  );

  // Uncapped completion signal for ProgressBanner's SectionStepList -- unlike
  // the 50-event-capped `narrations` list, sectionResultsByIndex keeps every
  // section_complete ever seen for the job's lifetime, so a section's
  // checkmark can't revert once its narration event ages out of the live
  // window on a document with enough branches.
  const completedSectionIndices = useMemo<number[]>(
    () => Object.keys(sectionResultsByIndex).map(Number),
    [sectionResultsByIndex],
  );

  // While running: only liveWarnings has content (warnings is still []
  // from the one-time getJob fetch). Once terminal, warnings becomes the
  // real, authoritative post-completion list -- deduped against
  // liveWarnings by raw text so nothing shows twice. Both sides normalize
  // through the same normalizeWarning (persisted `warnings` may still be a
  // legacy string[] job; liveWarnings is always plain strings, see its own
  // doc comment above) so the rest of the page only ever handles one shape.
  const mergedWarnings = useMemo<WarningRecord[]>(() => {
    const normalizedPersisted = warnings.map(normalizeWarning);
    const persistedRawTexts = new Set(normalizedPersisted.map((w) => w.raw));
    const normalizedLive = liveWarnings.filter((raw) => !persistedRawTexts.has(raw)).map(normalizeWarning);
    return [...normalizedPersisted, ...normalizedLive];
  }, [warnings, liveWarnings]);

  // STAGE 2 mapping's own excluded-as-decorative counts (B4 wired
  // excludedFigureIds/excludedTableIds onto the Job response; this is their
  // first frontend consumer). Deliberately phrased as a real, named count
  // ("N excluded as decorative"), NOT an exhaustive accounting -- a table
  // dropped for WarningKind.EMPTY_TABLE_CONTENT (a separate, pre-existing
  // warning surfaced via CollapsibleWarnings) lands in neither a node's
  // table_ids nor this list, so "N of M total" phrasing would be false.
  // null (not a "0 excluded" line) when both lists are empty.
  const excludedSummaryText = useMemo(() => {
    const parts: string[] = [];
    if (excludedFigureIds.length > 0) {
      parts.push(`${excludedFigureIds.length} figure${excludedFigureIds.length === 1 ? '' : 's'}`);
    }
    if (excludedTableIds.length > 0) {
      parts.push(`${excludedTableIds.length} table${excludedTableIds.length === 1 ? '' : 's'}`);
    }
    return parts.length > 0 ? `${parts.join(' and ')} excluded as decorative` : null;
  }, [excludedFigureIds, excludedTableIds]);

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
      setCreatedItemCount(job.createdItemCount ?? 0);
      showToast(`Confirmed — ${result.createdCount} work item(s) written to Azure DevOps.`, 'success');
    } catch {
      setMutationError('Confirm failed — the job may be safe to retry. Check the Audit tab for details.');
      // Re-sync with the server's actual status rather than leaving the
      // optimistic 'writing' stuck on screen after a failure -- confirm()
      // durably records partial progress (CreatedItemMapping) even on
      // failure, so job.status reflects the real, safe-to-retry state.
      const job = await getJob(id).catch(() => null);
      if (job) {
        setStatus(job.status);
        setCreatedItemCount(job.createdItemCount ?? 0);
      }
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

  // WID 300578: read-only, no local diff mutation -- just fetches and
  // displays the comparison. A real ADO round-trip (getWorkItemsBatch), so
  // this is an explicit reviewer action, never auto-run.
  async function handleValidate(): Promise<void> {
    if (!id || isValidating) return;
    setIsValidating(true);
    try {
      const result = await validateCreatedTree(id);
      setValidationResult(result);
    } catch {
      showToast('Failed to validate — please try again.', 'error');
    } finally {
      setIsValidating(false);
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
    const targets = diff.filter(
      (entry) =>
        matchesDiffFilter(entry, filterAction, query) &&
        (!filterFlaggedOnly || isFlaggedDiffEntry(entry)) &&
        !!entry.excluded !== excluded,
    );
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

  // Reparent/reorder -- guarded by isDiffMutatingRef same as
  // handleToggleExclude (a move can be fired rapidly via drag, same
  // re-entry risk as the exclude checkbox). Applies the move to local
  // state IMMEDIATELY (applyMoveOptimistically mirrors the server's own
  // splice algorithm) so a drag reads as instant instead of waiting on a
  // full request/response round-trip -- real user feedback: the
  // server-round-trip-only version felt laggy compared to the design
  // mockup's pure-local-state drag, which had zero network latency by
  // construction. Safe because DiffTree's own client-side canNest/cycle
  // validation already ran before onMove was ever called -- the only ways
  // the server can still reject (an already-linked entry, a stale
  // mismatched anchor) are both rare and reverted below on failure, same
  // as every other diff mutation's error handling. The server's response
  // still overwrites local state on success -- this is a preview, not a
  // second source of truth.
  async function handleMoveEntry(localId: string, input: MoveDiffEntryInput): Promise<void> {
    if (!id || isDiffMutatingRef.current) return;
    isDiffMutatingRef.current = true;
    setIsDiffMutating(true);
    const previousDiff = diff;
    setDiff((current) => applyMoveOptimistically(current, localId, input));
    try {
      const result = await moveDiffEntry(id, localId, input);
      setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
    } catch {
      setDiff(previousDiff);
      showToast('Failed to move — please try again.', 'error');
    } finally {
      isDiffMutatingRef.current = false;
      setIsDiffMutating(false);
    }
  }

  async function handleSaveEdit(
    localId: string,
    patch: { title: string; description: string; customerId?: string | null; tags?: string[]; seCoverageRef?: string | null },
  ): Promise<void> {
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

  // Re-throws on failure, same contract as handleRescore above -- lets
  // NodeDetailPanel's own per-figure loading-button guard know the call
  // failed and reset itself, rather than this function owning that local
  // UI state. No diff/setDiff update needed on success: attaching a figure
  // doesn't change dryRunDiff, only JobFigureFile server-side.
  async function handleAttachFigure(localId: string, figureId: string): Promise<void> {
    if (!id) return;
    try {
      await attachFigureToAdo(id, localId, figureId);
      showToast('Figure uploaded to Azure DevOps.', 'success');
    } catch (err) {
      showToast('Failed to upload figure — please try again.', 'error');
      throw err;
    }
  }

  // Manual retry for a trace link that failed to write during confirm() --
  // Refetches the job on success (see the comment inside the function) so
  // traceLinkFailures and warnings both resync from the server's own
  // recompute -- re-throws on failure with the same contract as
  // handleAttachFigure above, letting NodeDetailPanel's per-row
  // loading-button guard know the call failed.
  async function handleRetryTraceLink(failureId: string): Promise<void> {
    if (!id) return;
    try {
      await retryTraceLinkWrite(id, failureId);
      // Resync from the server rather than only clearing the retried id
      // locally: JobsService.retryTraceLinkWrite already recomputes both
      // the remaining traceLinkFailures AND the trace_link_write_failed
      // job warning server-side (shrinking or removing it) -- a local-only
      // update would leave the warning banner stale, and re-deriving its
      // exact text/nodeIds logic here would duplicate server logic that can
      // drift. A stale local traceLinkFailures list was a confirmed real
      // bug: without this refetch, navigating to another node and back
      // showed the just-fixed link as failed again (its row was deleted
      // server-side but still present in this component's own state), and
      // re-clicking retry 404s on the already-deleted row.
      const job = await getJob(id);
      setTraceLinkFailures(job.traceLinkFailures ?? []);
      setWarnings(job.warnings ?? []);
      showToast('Trace link written to Azure DevOps.', 'success');
    } catch (err) {
      showToast('Failed to write trace link — please try again.', 'error');
      throw err;
    }
  }

  async function handleAddChild(parentLocalId: string | null, input: { type: string; title: string; description: string }): Promise<void> {
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
        // push onto the existing array, not a spread-rebuild -- the spread
        // form copies the whole sibling array on every single insert, so a
        // parent with M children cost O(M^2) to index despite this
        // function's own comment claiming O(n) overall.
        const siblings = childrenByParent.get(entry.parentLocalId);
        if (siblings) siblings.push(entry);
        else childrenByParent.set(entry.parentLocalId, [entry]);
      }
    }
    const cache = new Map<string, { epics: number; features: number; requirements: number }>();
    function countFor(localId: string): { epics: number; features: number; requirements: number } {
      const cached = cache.get(localId);
      if (cached) return cached;
      let epics = 0;
      let features = 0;
      let requirements = 0;
      for (const child of childrenByParent.get(localId) ?? []) {
        if (child.type === 'Epic') epics += 1;
        if (child.type === 'Feature') features += 1;
        if (child.type === 'Requirement') requirements += 1;
        const sub = countFor(child.localId);
        epics += sub.epics;
        features += sub.features;
        requirements += sub.requirements;
      }
      const result = { epics, features, requirements };
      cache.set(localId, result);
      return result;
    }
    const result: Record<string, { epics: number; features: number; requirements: number }> = {};
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

  // Disambiguates CollapsibleWarnings' per-nodeId "Review item" buttons --
  // real gap this closes (user-reported): 2-3 buttons all labeled "Review
  // item ->" sitting side by side read as duplicated UI even though each
  // targets a different item, since nothing on the button itself says
  // which item it is.
  const titleByLocalId = useMemo(() => {
    const result: Record<string, string> = {};
    for (const entry of diff) result[entry.localId] = entry.title;
    return result;
  }, [diff]);

  // Backs the toolbar's "Needs review" chip -- see isFlaggedDiffEntry.
  const flaggedCount = useMemo(() => diff.filter((entry) => isFlaggedDiffEntry(entry)).length, [diff]);

  // Same filter predicate DiffTree applies internally (see its own `rows`
  // useMemo) -- NOT collapse-aware, since collapse state is internal to
  // DiffTree and not lifted here. Good enough for "step to the next
  // visible-by-filter item"; a collapsed subtree being skipped over by
  // prev/next is an acceptable simplification, not a correctness bug.
  const filteredForNav = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return diff.filter((entry) => matchesDiffFilter(entry, filterAction, query));
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

  // Real gap this closes (confirmed live): the stepper's "Parse" node
  // covers both deterministic parsing AND per-figure vision-LLM
  // captioning, and "Analyze" covers deterministic_subtree's two
  // structurally different chunked passes, with no visible distinction
  // between either. Sourced entirely from data the backend already emits
  // -- nothing invented.
  const latestNarrationForSteps = mergedNarrations.at(-1) ?? null;
  const stepSubLabelByKey: Partial<Record<LifecycleKey, string>> = {};
  if (latestNarrationForSteps?.phase === 'describe_figure' && latestNarrationForSteps.figureIndex != null && latestNarrationForSteps.figureCount != null) {
    stepSubLabelByKey.parse = `figures ${latestNarrationForSteps.figureIndex}/${latestNarrationForSteps.figureCount}`;
  }
  if (latestNarrationForSteps?.phase === 'deterministic_subtree') {
    const chunk = parseDeterministicSubtreeChunk(latestNarrationForSteps.subtreeLabel);
    if (chunk) stepSubLabelByKey.analyze = formatDeterministicSubtreePassSubLabel(chunk);
  }

  // Real gap this closes (confirmed live): a warning needing a real
  // decision (severity needs_review/pipeline_issue) carried the same
  // visual weight as the figure-descriptions row below it -- a plain
  // collapsed accordion, easy to scroll past. auto_fixed warnings don't
  // need this -- nothing for the user to actually do about those.
  const actionableWarningCount = mergedWarnings.filter(
    (w) => w.severity === 'needs_review' || w.severity === 'pipeline_issue',
  ).length;

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
            {status !== 'pending' && status !== 'running' && status !== 'writing' && createdItemCount > 0 && (
              <Button size="sm" variant="ghost" onClick={handleValidate} disabled={isValidating}>
                {isValidating ? 'Validating…' : 'Validate'}
              </Button>
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
      {/* Resume-safe partial write (300577) -- confirm()'s own resume
          machinery already makes clicking Confirm again safe (see its
          CreatedItemMapping-backed skip logic), but a reviewer had no way
          to tell "confirm never ran" apart from "confirm ran, partly
          wrote, then failed" before this banner. Shown only for a
          diff_ready job with a nonzero createdItemCount -- a fresh,
          never-confirmed job has none. */}
      {status === 'diff_ready' && createdItemCount > 0 && (
        <Alert severity="info">
          {createdItemCount} work item{createdItemCount === 1 ? '' : 's'} from a previous attempt{' '}
          {createdItemCount === 1 ? 'was' : 'were'} already written to Azure DevOps. Clicking Confirm resumes
          safely — it will not create duplicates.
        </Alert>
      )}
      {/* WID 300578: real-ADO-state validation result, shown until the
          reviewer navigates away or runs it again. `field: 'existence'`
          (JobsService.validateCreatedTree's own synthetic value) means the
          ADO item itself is gone, not a field-content mismatch --
          expected/actual are then plain sentences, not field values, so
          they render as-is rather than truncated code. */}
      {validationResult && (
        <Alert severity={validationResult.valid ? 'success' : 'warning'} onClose={() => setValidationResult(null)}>
          {validationResult.valid ? (
            <>All {validationResult.checkedCount} checked work item{validationResult.checkedCount === 1 ? '' : 's'} match what was confirmed.</>
          ) : (
            <div className="flex flex-col gap-2">
              <span>
                {validationResult.mismatches.length} mismatch{validationResult.mismatches.length === 1 ? '' : 'es'} found across{' '}
                {validationResult.checkedCount} checked work item{validationResult.checkedCount === 1 ? '' : 's'}:
              </span>
              <ul className="flex flex-col gap-1 text-xs">
                {validationResult.mismatches.map((m, i) => (
                  <li key={`${m.localId}-${m.field}-${i}`} className="font-mono">
                    WI-{m.adoWorkItemId} ({m.field}): expected{' '}
                    {m.field === 'existence' ? m.expected : `"${truncateForDisplay(m.expected)}"`}, got{' '}
                    {m.field === 'existence' ? m.actual : `"${truncateForDisplay(m.actual)}"`}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
            subLabelByKey={stepSubLabelByKey}
          />
          <NarrationTicker
            sentence={tickerFor({ status, stage, latest: mergedNarrations.at(-1) ?? null }).sentence}
            isLive={(status === 'pending' || status === 'running' || status === 'writing') && !!startedAt}
            startedAt={startedAt ?? ''}
          />
        </div>
      )}
      {mode === 'survey' && documentOverview && (
        <div className="mb-4 flex flex-col gap-2 rounded-md border border-hairline bg-surface p-3">
          <span className={LABEL_MICRO}>Document overview</span>
          <p className="text-sm text-ink-1">{documentOverview.synopsis}</p>
          {documentOverview.caveat && <Alert severity="warning">{documentOverview.caveat}</Alert>}
          <span className="text-xs text-ink-3">Generated from the document's real structure — not a literal excerpt.</span>
        </div>
      )}
      {mode === 'baseline' && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-dashed border-hairline-strong p-3 text-xs text-ink-3">
          <span>
            Document overview isn't produced for BASELINE jobs — deterministic extraction, nothing to verify.
          </span>
        </div>
      )}
      {actionableWarningCount > 0 && (
        <Alert severity="warning" className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <span>
              {actionableWarningCount} integrity warning{actionableWarningCount === 1 ? '' : 's'} need
              {actionableWarningCount === 1 ? 's' : ''} your review.
            </span>
            <button
              type="button"
              onClick={() => document.getElementById('integrity-warnings')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="flex-none rounded-sm border border-warning-border bg-surface px-2.5 py-1 text-xs font-medium text-warning-ink hover:border-current"
            >
              Review now
            </button>
          </div>
        </Alert>
      )}
      {status === 'pending' && (
        <Alert severity="info">
          <span className="flex items-center gap-2">
            <Spinner /> Queued — waiting for a pipeline worker to pick this job up.
          </span>
        </Alert>
      )}
      {isRunDetailStatus(status) && stage && mode && startedAt && (
        <ProgressBanner
          stage={stage}
          startedAt={startedAt}
          mode={mode as 'baseline' | 'survey'}
          narrations={mergedNarrations}
          completedSectionIndices={completedSectionIndices}
          jobId={id}
        />
      )}
      <div id="integrity-warnings">
        <CollapsibleWarnings
          warnings={mergedWarnings}
          onJumpToNode={(localId) => {
            // Matches onOpenDetails below exactly -- previously this only
            // switched tabs and set selection, which (a) never scrolled the
            // target into view (DiffTree's own useEffect on selectedId below
            // handles that) and (b) never opened the dialog, so "Review item"
            // looked like it did nothing on any list of real size.
            setTab('tree');
            setSelectedId(localId);
            setDialogOpen(true);
          }}
          adoIdByLocalId={adoIdByLocalId}
          titleByLocalId={titleByLocalId}
          orgUrl={orgUrl}
          project={teamProject}
        />
      </div>
      <FigureDescriptions jobId={id!} items={figureDescriptions} />
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
      {excludedSummaryText && <p className="text-sm text-ink-3">{excludedSummaryText}</p>}
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
                {/* DESIGN.md §11.5 -- the artifact's persistent "+ New item"
                    toolbar button, previously missing entirely: creation
                    only existed buried inside an existing node's own "Add
                    child" dialog, with no way to add a first-class item with
                    no anchor at all (e.g. a brand-new top-level Epic). Reuses
                    AddChildCard/AddChildForm with no parentEntry -- BASELINE
                    mode has no anchor-independent type model (see
                    AddChildForm.tsx's own doc comment), so this is SURVEY-only. */}
                {mode === 'survey' && status === 'diff_ready' && (
                  <div className="border-b border-hairline p-3">
                    <AddChildCard
                      jobMode="survey"
                      allEntries={diff}
                      categoryLabels={categoryLabels ?? undefined}
                      typeCatalog={typeCatalog ?? undefined}
                      onAdd={(input) => handleAddChild(input.parentLocalId, { type: input.type, title: input.title, description: input.description })}
                    />
                  </div>
                )}
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
                    {flaggedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setFilterFlaggedOnly((prev) => !prev)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
                          filterFlaggedOnly
                            ? 'border-warning bg-warning-soft text-warning-ink'
                            : 'border-warning-border bg-warning-soft text-warning',
                        )}
                      >
                        ⚠ Needs review · {flaggedCount}
                      </button>
                    )}
                    {status === 'diff_ready' && (
                      <div className="ml-auto flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => handleBulkExclude(true)} disabled={isDiffMutating}>
                          Exclude {filterAction || filterText || filterFlaggedOnly ? 'matching' : 'all'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleBulkExclude(false)} disabled={isDiffMutating}>
                          Include {filterAction || filterText || filterFlaggedOnly ? 'matching' : 'all'}
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
                  filterFlaggedOnly={filterFlaggedOnly}
                  onToggleExclude={handleToggleExclude}
                  typeCatalog={typeCatalog ?? undefined}
                  categoryLabels={categoryLabels ?? undefined}
                  orgUrl={orgUrl}
                  project={teamProject}
                  onMove={handleMoveEntry}
                  canMove={status === 'diff_ready'}
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
                traceLinkFailures={traceLinkFailures}
                diffByLocalId={diffByLocalId}
                descendantCountsByLocalId={descendantCountsByLocalId}
                captionByFigureId={captionByFigureId}
                nameByFigureId={nameByFigureId}
                captionByTableId={captionByTableId}
                onSave={handleSaveEdit}
                onRescore={handleRescore}
                onAttachFigure={handleAttachFigure}
                onRetryTraceLink={handleRetryTraceLink}
                onAddChild={handleAddChild}
                onMove={handleMoveEntry}
                onNavigate={handleNavigateDialog}
                hasPrev={hasPrevEntry}
                hasNext={hasNextEntry}
                typeCatalog={typeCatalog ?? undefined}
                categoryLabels={categoryLabels ?? undefined}
                requirementClassificationField={requirementClassificationField}
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
