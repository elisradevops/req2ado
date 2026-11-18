import { plural } from '../utils/plural';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, Activity, Info, TriangleAlert } from 'lucide-react';
import { MultiFileDropzone } from '../components/MultiFileDropzone';
import { ModeCards } from '../components/ModeCards';
import { AreaPathPicker } from '../components/AreaPathPicker';
import { IterationPathPicker } from '../components/IterationPathPicker';
import { StatePicker } from '../components/StatePicker';
import { ProjectPicker } from '../components/ProjectPicker';
import { formatDestinationPreview } from '../components/DestinationBar';
import { DedupScopeSelect } from '../components/DedupScopeSelect';
import { submitBatch } from '../api/batches';
import { useBatchJobDraftStore } from '../store/batchJobDraftStore';
import { getEstimate, listJobs, listModels, previewJob, type EtaEstimate, type ModelListing, type PreviewResult } from '../api/jobs';
import { estimateLine } from '../utils/eta';
import { findPreviousRuns, type PreviousRunJob, type PreviousRuns } from '../utils/previousRuns';
import { jobStatusLabel } from '../utils/labels';
import { formatRelativeTime } from '../utils/relativeTime';
import { useOrgUrl, useUserId } from '../store/authStore';
import { usePageTitle } from '../hooks/usePageTitle';
import { isUntouchedChoices, loadLastJobChoices, loadProjectChoices, rememberJobChoices, withRememberedChoices } from '../utils/lastJobChoices';
import { useToast } from '../components/ToastProvider';
import { PageHeader } from '../ui/PageHeader';
import { SectionCard } from '../ui/SectionCard';
import { TextField } from '../ui/TextField';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Alert } from '../ui/Alert';

// This deployment's own configured batch-originated-SURVEY throttle
// (orchestrator's BATCH_SURVEY_CONCURRENCY, default 2) -- no endpoint
// exposes the live configured value today, so this mirrors that default
// for the warning copy below. Worth wiring to a real config-read endpoint
// if the deployed value is ever changed from the default; until then this
// is advisory copy, not an enforced client-side limit (the server enforces
// the real cap regardless of what this says).
const SURVEY_BATCH_THROTTLE_HINT = 2;

// B3: each added file is parsed by POST /jobs/preview (no job is created), at most this many at a time, so a folder of files does not queue
// a burst of parses on the server.
const PREVIEW_CONCURRENCY = 2;

type FileCheck = { status: 'checking' } | { status: 'parsed'; preview: PreviewResult } | { status: 'failed' };

// The same identity the page uses to drop a file chosen twice: name, size and last-modified time.
function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

// The second line of a file's row: what the parser found, the estimate for the chosen mode, and an earlier job of a file with this name. A
// file that could not be checked is said so, and still goes with the batch (the server gives its own reason if it rejects it).
function FileCheckLine({ check, estimate, previousRuns }: { check: FileCheck | undefined; estimate: EtaEstimate | undefined; previousRuns: PreviousRuns | null }): React.ReactElement {
  if (!check || check.status === 'checking') {
    return <p className="text-xs text-ink-3">Checking this file…</p>;
  }
  if (check.status === 'failed') {
    return (
      <p className="flex items-start gap-1.5 text-xs text-warning-ink">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-none" />
        <span className="min-w-0">Could not check this file. It is still sent with the batch, and if it cannot be read there either, the batch page says why.</span>
      </p>
    );
  }
  const { preview } = check;
  const line = estimateLine(estimate, false);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="flex flex-wrap gap-x-1.5 font-mono text-meta text-ink-3">
        <span>
          {plural(preview.blockCount, 'block')} · {plural(preview.sectionCount, 'section')}
        </span>
        {line && <span>· {line.value}, typically</span>}
      </p>
      {previousRuns && (
        <p className="flex items-start gap-1.5 text-xs text-ink-2">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-none text-ink-3" />
          <span className="min-w-0">
            You already ran a file with this name: job{' '}
            <Link to={`/jobs/${previousRuns.latest.id}`} className="font-mono text-accent-ink underline">
              {previousRuns.latest.id.slice(0, 8)}
            </Link>
            , {jobStatusLabel(previousRuns.latest.status).label}, {formatRelativeTime(previousRuns.latest.createdAt)}.
          </span>
        </p>
      )}
    </div>
  );
}

export function BatchJobWizard(): React.ReactElement {
  const navigate = useNavigate();
  const { showToast, showErrorToast } = useToast();
  usePageTitle('New batch');
  const orgUrl = useOrgUrl();
  const userId = useUserId();
  // What the user had done before leaving this page and coming back (see batchJobDraftStore); on a first visit, the mode and destination of the
  // last job they started (the single-file wizard does the same), so a SURVEY team is not opened on BASELINE.
  const [initial] = useState(() => {
    const draft = useBatchJobDraftStore.getState().draft;
    return { ...withRememberedChoices(draft, loadLastJobChoices(userId)), modeChosen: !isUntouchedChoices(draft) };
  });
  const [files, setFiles] = useState<File[]>(initial.files);
  const [mode, setMode] = useState<'baseline' | 'survey'>(initial.mode);
  const [project, setProject] = useState(initial.project);
  const [areaPath, setAreaPath] = useState(initial.areaPath);
  const [state, setState] = useState(initial.state);
  const [iterationPath, setIterationPath] = useState(initial.iterationPath);
  const [model, setModel] = useState(initial.model);
  const [dedupScope, setDedupScope] = useState<'area_path' | 'project'>(initial.dedupScope);
  // Whether the person picked the mode themselves (or came back to a draft they had started): a project's remembered mode never replaces it.
  const modeChosen = useRef(initial.modeChosen);
  function handleModeChange(next: 'baseline' | 'survey'): void {
    modeChosen.current = true;
    setMode(next);
  }
  // Mirror the user's work into the draft store so it survives a visit to another page (cleared on submit and logout).
  useEffect(() => {
    useBatchJobDraftStore.getState().patch({ files, mode, model, project, areaPath, state, iterationPath, dedupScope });
  }, [files, mode, model, project, areaPath, state, iterationPath, dedupScope]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelListing, setModelListing] = useState<ModelListing | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const hasAdoSession = !!orgUrl;

  useEffect(() => {
    if (mode !== 'survey' || availableModels.length > 0) return;
    setModelsLoading(true);
    setModelsError(false);
    listModels()
      .then((listing) => {
        setAvailableModels(listing.models);
        setModelListing(listing);
        // A model restored from the draft may have gone away while the user was elsewhere: fall back to Default rather than submit it.
        setModel((current) => (current && !listing.models.includes(current) ? '' : current));
      })
      .catch(() => {
        setAvailableModels([]);
        setModelListing(null);
        setModelsError(true);
      })
      .finally(() => setModelsLoading(false));
  }, [mode, availableModels.length]);

  // Only on a real change: a project restored from the draft must keep its restored area path. The previous project's area path never
  // carries over; the new project's own last one (and its mode, unless the person chose one) is offered instead (B6).
  const lastProject = useRef(project);
  useEffect(() => {
    if (lastProject.current === project) return;
    lastProject.current = project;
    const remembered = loadProjectChoices(userId, project);
    setAreaPath(remembered?.areaPath ?? '');
    if (remembered && !modeChosen.current) setMode(remembered.mode);
  }, [project, userId]);

  // B3: every file's check, by fileKey. Requests in flight are counted in a ref (not state), so a re-render can never start one twice and
  // the cap holds even for a file removed mid-check: its request still runs, so its slot is freed only when it answers, and its answer is
  // then dropped.
  const [checks, setChecks] = useState<Record<string, FileCheck>>({});
  const checksInFlight = useRef(new Set<string>());
  const currentFileKeys = useRef(new Set<string>());
  useEffect(() => {
    currentFileKeys.current = new Set(files.map(fileKey));
    const waiting = files.filter((file) => !checks[fileKey(file)] && !checksInFlight.current.has(fileKey(file)));
    for (const file of waiting.slice(0, Math.max(0, PREVIEW_CONCURRENCY - checksInFlight.current.size))) {
      const key = fileKey(file);
      checksInFlight.current.add(key);
      setChecks((prev) => ({ ...prev, [key]: { status: 'checking' } }));
      const settle = (result: FileCheck): void => {
        checksInFlight.current.delete(key);
        setChecks((prev) => {
          const next = { ...prev };
          if (currentFileKeys.current.has(key)) next[key] = result;
          else delete next[key];
          return next;
        });
      };
      previewJob(file).then(
        (preview) => settle(preview && typeof preview.blockCount === 'number' ? { status: 'parsed', preview } : { status: 'failed' }),
        () => settle({ status: 'failed' }),
      );
    }
  }, [files, checks]);

  // The job list, read once files are chosen, for the "already ran a file with this name" note. Best effort: without it there is no note.
  const [pastJobs, setPastJobs] = useState<PreviousRunJob[] | null>(null);
  const hasFiles = files.length > 0;
  useEffect(() => {
    if (!hasFiles || pastJobs) return undefined;
    let cancelled = false;
    listJobs()
      .then((jobs) => {
        if (!cancelled && Array.isArray(jobs)) setPastJobs(jobs);
      })
      .catch(() => {
        // The note is a courtesy; without the list there is simply none.
      });
    return () => {
      cancelled = true;
    };
  }, [hasFiles, pastJobs]);

  // One server estimate per checked file for the chosen mode (and model), sized by that file's own blocks and figures. Kept by file, mode
  // and model, so switching back and forth asks again only for what was never asked, and a late answer only fills its own entry.
  const [estimates, setEstimates] = useState<Record<string, EtaEstimate>>({});
  const estimatesAsked = useRef(new Set<string>());
  const estimateModel = mode === 'survey' ? model : '';
  const estimateKeyOf = (key: string): string => `${key}|${mode}|${estimateModel}`;
  useEffect(() => {
    for (const file of files) {
      const key = fileKey(file);
      const check = checks[key];
      if (check?.status !== 'parsed') continue;
      const asked = `${key}|${mode}|${estimateModel}`;
      if (estimatesAsked.current.has(asked)) continue;
      estimatesAsked.current.add(asked);
      getEstimate({ blockCount: check.preview.blockCount, figureCount: check.preview.figureCount, mode, model: estimateModel || undefined })
        .then((estimate) => {
          if (estimate) setEstimates((prev) => ({ ...prev, [asked]: estimate }));
        })
        .catch(() => {
          // Best effort: no estimate is shown rather than a made-up one.
        });
    }
  }, [files, checks, mode, estimateModel]);

  function handleFilesAdded(added: File[]): void {
    // The same file chosen again (it is easy to after coming back to a restored draft) is one file, not two submitted jobs.
    const same = (a: File, b: File): boolean => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
    setFiles((prev) => [...prev, ...added.filter((file, i) => !prev.some((p) => same(p, file)) && !added.slice(0, i).some((p) => same(p, file)))]);
  }

  function handleFileRemoved(index: number): void {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(): Promise<void> {
    if (files.length === 0 || !areaPath || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      const { batchId } = await submitBatch({
        files,
        areaPath,
        adoProject: project || undefined,
        mode,
        state: state || undefined,
        iterationPath: iterationPath || undefined,
        model: mode === 'survey' ? model || undefined : undefined,
        dedupScope: dedupScope === 'project' ? 'project' : undefined,
      });
      rememberJobChoices(userId, { mode, project, areaPath });
      // The batch exists now: the next visit starts from nothing, not from this draft.
      useBatchJobDraftStore.getState().reset();
      navigate(`/jobs/batch/${batchId}`);
    } catch (err) {
      showErrorToast('Failed to start the batch. Please try again.', err);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  const canSubmit = files.length > 0 && !!areaPath && (!hasAdoSession || !!project) && !isSubmitting;
  // What is still missing, in the order the page asks for it, so a disabled Start never leaves the user guessing.
  const startBlockedReason = files.length === 0 ? 'Add at least one file.' : hasAdoSession && !project ? 'Choose a team project.' : !areaPath ? 'Choose an area path.' : null;

  // The checks of the files on the page now. The total is the sum of the per-file ranges, shown once every file is checked and every checked
  // file has its estimate; a file that could not be checked is left out and said so.
  const fileChecks = files.map((file) => checks[fileKey(file)]);
  const stillChecking = fileChecks.some((check) => !check || check.status === 'checking');
  const checkedCount = fileChecks.filter((check) => check?.status === 'parsed').length;
  const uncheckedCount = fileChecks.filter((check) => check?.status === 'failed').length;
  const fileEstimates = files.flatMap((file) => (checks[fileKey(file)]?.status === 'parsed' ? [estimates[estimateKeyOf(fileKey(file))]] : []));
  const totalLine =
    !stillChecking && fileEstimates.length > 0 && fileEstimates.every(Boolean)
      ? estimateLine(
          {
            lowerMinutes: fileEstimates.reduce((sum, estimate) => sum + (estimate?.lowerMinutes ?? 0), 0),
            upperMinutes: fileEstimates.reduce((sum, estimate) => sum + (estimate?.upperMinutes ?? 0), 0),
          },
          false,
        )
      : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="New batch" description="Upload multiple requirements documents to process them together" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="Documents">
            <MultiFileDropzone
              files={files}
              onFilesAdded={handleFilesAdded}
              onFileRemoved={handleFileRemoved}
              disabled={isSubmitting}
              renderFileDetail={(file) => (
                <FileCheckLine
                  check={checks[fileKey(file)]}
                  estimate={estimates[estimateKeyOf(fileKey(file))]}
                  previousRuns={pastJobs ? findPreviousRuns(pastJobs, file.name) : null}
                />
              )}
            />
            {/* Present and empty from the first render; says only the end of the checks, never each file. */}
            <p role="status" className="sr-only">
              {files.length > 0 && !stillChecking ? `Checked ${checkedCount} of ${plural(files.length, 'file')}` : ''}
            </p>
          </SectionCard>

          <SectionCard title="Destination in Azure DevOps">
            <div className="flex flex-col gap-3">
              {hasAdoSession ? (
                <>
                  <ProjectPicker value={project} onChange={setProject} />
                  {project ? (
                    <AreaPathPicker value={areaPath} onChange={setAreaPath} project={project} />
                  ) : (
                    <TextField label="Area path" value={areaPath} disabled helperText="Select a team project first" fullWidth />
                  )}
                </>
              ) : (
                <TextField label="Area path" value={areaPath} onChange={(event) => setAreaPath(event.target.value)} fullWidth />
              )}
              <div className="grid grid-cols-2 gap-2.5">
                {hasAdoSession && project ? (
                  <StatePicker value={state} onChange={setState} project={project} />
                ) : (
                  <TextField
                    label="State (optional)"
                    value={state}
                    onChange={(event) => setState(event.target.value)}
                    disabled={hasAdoSession}
                    helperText={hasAdoSession ? 'Select a team project first' : undefined}
                    fullWidth
                  />
                )}
                {hasAdoSession && project ? (
                  <IterationPathPicker value={iterationPath} onChange={setIterationPath} project={project} />
                ) : (
                  <TextField
                    label="Iteration path (optional)"
                    value={iterationPath}
                    onChange={(event) => setIterationPath(event.target.value)}
                    disabled={hasAdoSession}
                    helperText={hasAdoSession ? 'Select a team project first' : undefined}
                    fullWidth
                  />
                )}
              </div>
              <DedupScopeSelect value={dedupScope} onChange={setDedupScope} />
              {(project || areaPath) && (
                <p className="font-mono text-xs text-ink-3">{formatDestinationPreview(project, areaPath, iterationPath, state)}</p>
              )}
            </div>
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="How should each file be read?">
            {/* Applies uniformly to every file in this batch -- there is no
                per-file mode override in v1. The cards show no estimate: each
                file's estimate is for the chosen mode only (beside the file),
                and the total for all files is below. */}
            <ModeCards
              value={mode}
              onChange={handleModeChange}
              model={model}
              onModelChange={setModel}
              availableModels={availableModels}
              modelDetails={modelListing?.details}
              recommendedModel={modelListing?.recommended}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
            />
          </SectionCard>
          {files.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="text-xs text-ink-3">All files, added up</span>
                <span data-testid="batch-total-estimate" className="font-mono text-metric font-semibold tabular-nums text-ink-1">
                  {totalLine?.value ?? '--'}
                </span>
                <span className="text-xs text-ink-3">{totalLine ? 'typically, once they start' : stillChecking ? 'once every file is checked' : ''}</span>
              </p>
              {uncheckedCount > 0 && <p className="text-xs text-ink-3">Not counting {plural(uncheckedCount, 'file')} that could not be checked.</p>}
            </div>
          )}
          {mode === 'survey' && (
            <Alert severity="warning">
              This deployment runs at most {plural(SURVEY_BATCH_THROTTLE_HINT, 'SURVEY file')} from a batch at a time. With {plural(files.length, 'file')} selected, some will wait in queue while earlier ones finish.
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              <Lock className="h-3.5 w-3.5 flex-none" />
              Nothing is written to Azure DevOps until you confirm each file's own diff.
            </span>
            {!canSubmit && !isSubmitting && startBlockedReason && (
              <span id="batch-start-reason" className="ml-auto text-xs text-ink-3">
                {startBlockedReason}
              </span>
            )}
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-describedby={!canSubmit && !isSubmitting && startBlockedReason ? 'batch-start-reason' : undefined}
              className={startBlockedReason && !canSubmit && !isSubmitting ? undefined : 'ml-auto'}
            >
              {isSubmitting ? <Spinner /> : <Activity className="h-3.5 w-3.5" />}
              {isSubmitting ? 'Starting…' : `Start batch (${files.length} file${files.length === 1 ? '' : 's'})`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
