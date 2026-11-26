import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutGrid, AlignLeft, Image, Layers, Table2, TriangleAlert, ArrowRight, Activity, Info } from 'lucide-react';
import { cn } from '../lib/cn';
import { leftOutNames, pagesPhrase } from '../utils/leftOut';
import { restorableDraft, useNewJobDraftStore } from '../store/newJobDraftStore';
import { loadLastJobChoices, loadProjectChoices, rememberJobChoices, withRememberedChoices } from '../utils/lastJobChoices';
import { FileTypeIcon } from '../components/FileTypeIcon';
import { FileDropzone, type FileDropzoneStatus } from '../components/FileDropzone';
import { MODE_COPY, ModeCards } from '../components/ModeCards';
import { FileStudyPanel } from '../components/FileStudyPanel';
import { BuildPreview } from '../components/BuildPreview';
import { AboutFilePanel } from '../components/AboutFilePanel';
import { decisionPairs } from '../utils/buildPreview';
import { AreaPathPicker } from '../components/AreaPathPicker';
import { IterationPathPicker } from '../components/IterationPathPicker';
import { StatePicker } from '../components/StatePicker';
import { ProjectPicker } from '../components/ProjectPicker';
import { formatDestinationPreview } from '../components/DestinationBar';
import { SafetyLine } from '../components/SafetyLine';
import { DedupScopeSelect } from '../components/DedupScopeSelect';
import {
  listJobs,
  editRules,
  previewJob,
  previewRules,
  previewStudy,
  previewSummary,
  getCachedResult,
  submitJob,
  listModels,
  type ModelListing,
  getEstimate,
  type EtaEstimate,
  type PreviewResult,
  type DocumentOverview,
  type DocumentStudy,
  type RulebookView,
  type ProposalDecision,
} from '../api/jobs';
import { estimateLine, formatTokenCount, formatUsdRange, tokenForecastLine } from '../utils/eta';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { findPreviousRuns, type PreviousRuns } from '../utils/previousRuns';
import { jobStatusLabel } from '../utils/labels';
import { formatRelativeTime } from '../utils/relativeTime';
import { formatFileSize } from '../utils/fileSize';
import { useOrgUrl, useUserId } from '../store/authStore';
import { useToast } from '../components/ToastProvider';
import { PageHeader } from '../ui/PageHeader';
import { SectionCard } from '../ui/SectionCard';
import { KbReadinessStrip } from '../components/KbReadinessStrip';
import { OverviewLines } from '../components/DocumentOverviewCard';
import { type RulesStatus } from '../components/FileRulesCard';
import { AiSummaryBlock, FileReadingCard, readingLine } from '../components/FileReadingCard';
import { type StudyStatus } from '../components/DocumentStudyCard';
import { TextField } from '../ui/TextField';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Alert } from '../ui/Alert';
import { Chip } from '../ui/Chip';
import { StatTile } from '../ui/StatTile';
import { ARRIVE, useReplayOnChange } from '../ui/motion';
import { Stepper, type StepState } from '../ui/Stepper';
import { InfoTip } from '../ui/Tooltip';
import { describeEstimateBasis } from '../utils/modelFacts';

// The flow is genuinely two screens (upload, then configure+review) -- a
// 4-label stepper (Source/Target/Options/Review) would claim stages that
// don't exist as separate screens, since target/options/review all live on
// one page today. Two honest stages instead of a stage count the UI can't
// back up.
// One page after the upload, in both modes (owner decision, 2026-11-25): what was read from the file, how to read it, where it lands, then
// Start. With AI review's optional summary is written meanwhile and goes with the job if it is ready; Start never waits for it.
const STEPS = ['Upload document', 'Check and start'];

function stepsFor(_mode: 'baseline' | 'survey'): string[] {
  return STEPS;
}

/** Whether this step is the one that shows what was read from the file and starts the job. */
function isFinalStep(step: number, mode: 'baseline' | 'survey'): boolean {
  return step === stepsFor(mode).length;
}

/** The reason an API call failed, as the server stated it (a rulebook that does not fit the file says why), else a plain sentence. */
function errorReason(err: unknown, fallback = "The file's conventions could not be read."): string {
  // The reading is limited per minute (the server's throttle): say so rather than "could not be read".
  if ((err as { response?: { status?: unknown } } | null)?.response?.status === 429) return 'Too many reads in a minute. Try again shortly.';
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  // NestJS's own "Internal server error" says nothing the user can act on: fall through to the plain sentence instead.
  if (typeof message === 'string' && message && message !== 'Internal server error') return message;
  if (Array.isArray(message) && message.length > 0) return message.join('; ');
  return fallback;
}


function wizardStepStates(activeIndex: number, mode: 'baseline' | 'survey'): StepState[] {
  return stepsFor(mode).map((_, index) => {
    if (index < activeIndex) return 'done';
    return index === activeIndex ? 'awaiting' : 'pending';
  });
}

// DESIGN.md §11.1 -- the "honest answer to 'what did it read'": one
// `.hoverable-row` per section, not just the 4 aggregate stat tiles above
// it. The block-count bar is relative to this document's OWN largest
// section, not an absolute scale -- an even one-page memo and a 600-block
// spec would otherwise render identical-looking near-empty bars.
function DocumentMapList({ sections }: { sections: PreviewResult['documentMap'] }): React.ReactElement {
  const maxBlockCount = Math.max(1, ...sections.map((s) => s.blockCount));
  return (
    // max-h + overflow-y-auto (not flex-1) -- flex-1 needs a height-bounded
    // ancestor to actually compute a scrollable cross size, and nothing in
    // this card's own chain provides one, so it silently no-op'd: a long
    // document's map (682 blocks / 150+ sections, confirmed live) grew this
    // card to its full content height instead of scrolling internally,
    // forcing the whole page to scroll through the entire list just to
    // reach the right pane's Next Step button -- reported live as bad UX.
    <div className="flex max-h-[420px] flex-col overflow-y-auto">
      {sections.map((section, index) => (
        <div key={`${section.number ?? 'unnumbered'}-${index}`} className="hoverable-row flex items-center gap-2 px-1 py-1.5">
          {/* min-w, not a fixed w-10: a deep number ("1.2.1.1.1") ran into the title. It grows to fit, capped, and the title truncates. */}
          <span className="min-w-10 max-w-[40%] flex-none truncate font-mono text-meta text-ink-3" title={section.number ?? undefined}>
            {section.number ?? '—'}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={section.title}>
            {section.title}
          </span>
          <div className="h-[7px] w-16 flex-none overflow-hidden rounded-full bg-surface-sunken">
            <div
              className="h-full rounded-full bg-accent/72"
              style={{ width: `${(section.blockCount / maxBlockCount) * 100}%` }}
            />
          </div>
          <span className="w-6 flex-none text-right font-mono text-meta tabular-nums text-ink-3">{section.blockCount}</span>
          <span className={cn('flex flex-none items-center gap-0.5 font-mono text-meta tabular-nums text-ink-3', section.figureCount === 0 && 'opacity-[0.28]')}>
            <Image className="h-2.5 w-2.5" />
            {section.figureCount}
          </span>
        </div>
      ))}
    </div>
  );
}

// Step 1's "already ran a file with this name" note, kept on steps 2 and 3 as one line in the "This run" rail (P5).
function PreviousRunLine({ previousRuns }: { previousRuns: PreviousRuns | null }): React.ReactElement | null {
  if (!previousRuns) return null;
  const { latest } = previousRuns;
  return (
    <p className="flex items-start gap-1.5 border-t border-hairline pt-3 text-xs text-ink-2">
      <Info className="mt-0.5 h-3.5 w-3.5 flex-none text-ink-3" />
      <span className="min-w-0">
        You already ran a file with this name: job{' '}
        <Link to={`/jobs/${latest.id}`} className="font-mono text-accent-ink underline">
          {latest.id.slice(0, 8)}
        </Link>
        , {jobStatusLabel(latest.status).label}, {formatRelativeTime(latest.createdAt)}.
      </span>
    </p>
  );
}

// DESIGN.md §11.1 -- derived facts, not raw counts, and never empty: with
// no file it shows what will eventually fill this space. Every note here is
// a real, current-parse fact (table/figure/open-TBD counts already
// returned by preview()) -- never an invented risk to fill space.
function WorthKnowingCard({ preview, parsing, previousRuns }: { preview: PreviewResult | null; parsing: boolean; previousRuns: PreviousRuns | null }): React.ReactElement {
  if (!preview && parsing) {
    return <p className="text-xs text-ink-3">Parsing the document… this fills in when it finishes.</p>;
  }
  if (!preview) {
    return <p className="text-xs text-ink-3">Drop a document and this fills with what the parser found in it.</p>;
  }
  const notes: { icon: typeof Table2; tone: 'warning' | 'neutral'; text: React.ReactNode }[] = [];
  // Said first, and never blocking: the job list only carries the name, so this is "a file with this name", not "this file".
  if (previousRuns) {
    const { latest, others } = previousRuns;
    notes.push({
      icon: Info,
      tone: 'neutral',
      text: (
        <>
          <span className="font-semibold text-ink-1">You already ran a file with this name:</span> job{' '}
          <Link to={`/jobs/${latest.id}`} className="font-mono text-accent-ink underline">
            {latest.id.slice(0, 8)}
          </Link>
          , {jobStatusLabel(latest.status).label}, {formatRelativeTime(latest.createdAt)}
          {others > 0 ? ` (and ${others} other ${others === 1 ? 'time' : 'times'})` : ''}. If it is the same file, open that job instead of starting another.
        </>
      ),
    });
  }
  // The front matter the build leaves out, named by the document's own headings, so step 1 already shows what will not become items.
  if (preview.leftOut && preview.leftOut.parts.length > 0) {
    notes.push({
      icon: AlignLeft,
      tone: 'neutral',
      text: (
        <>
          <span className="font-semibold text-ink-1">Left out, not requirements{pagesPhrase(preview.leftOut.pages)}.</span> {leftOutNames(preview.leftOut)} will
          not become items.
        </>
      ),
    });
  }
  // Not a defect, just how the document is built: without headings there is no section structure to turn into a tree.
  if (preview.sectionCount === 0 && preview.blockCount > 0) {
    notes.push({
      icon: AlignLeft,
      tone: 'neutral',
      text: (
        <>
          <span className="font-semibold text-ink-1">No headings found.</span> Standard uses clause numbering (such as 3.2.1) where the text
          has it; with none, it groups everything under one Epic and one Feature.
        </>
      ),
    });
  }
  if (preview.tableCount > 0) {
    notes.push({
      icon: Table2,
      tone: 'neutral',
      text: (
        <>
          <span className="font-semibold text-ink-1">
            {preview.tableCount} table{preview.tableCount === 1 ? '' : 's'} detected.
          </span>{' '}
          Every row counts as its own block, which is part of why the block count can look higher than the page count suggests.
        </>
      ),
    });
  }
  if (preview.figureCount > 0) {
    notes.push({
      icon: Image,
      tone: 'neutral',
      text: (
        <>
          <span className="font-semibold text-ink-1">
            {preview.figureCount} figure{preview.figureCount === 1 ? '' : 's'} found.
          </span>{' '}
          With AI review describes each one with a separate vision-model call — the main reason its estimate runs longer than Standard.
        </>
      ),
    });
  }
  if (preview.openTbdCount > 0) {
    notes.push({
      icon: TriangleAlert,
      tone: 'warning',
      text: (
        <>
          <span className="font-semibold text-ink-1">
            {preview.openTbdCount} open TBD placeholder{preview.openTbdCount === 1 ? '' : 's'} found
          </span>{' '}
          in the source text.
        </>
      ),
    });
  }
  if (notes.length === 0) {
    return <p className="text-xs text-ink-3">Nothing unusual found — a straightforward parse.</p>;
  }
  return (
    <div className="flex flex-col">
      {/* DESIGN.md §6 names "fact rows" as a real .hoverable-row consumer --
          these aren't clickable (no destination to jump to), but the shared
          row-hover fill is still the app's own visual language for "one of
          several facts in a list", same non-interactive use SectionStepList
          already makes of this class. */}
      {notes.map((note, index) => (
        <div key={index} className="hoverable-row flex items-start gap-2 px-1 py-1.5 text-xs text-ink-2">
          <note.icon className={cn('mt-0.5 h-3.5 w-3.5 flex-none', note.tone === 'warning' ? 'text-warning' : 'text-ink-3')} />
          <span>{note.text}</span>
        </div>
      ))}
    </div>
  );
}

/** How long the optional AI summary may take before it is given up on: later than this it is not worth showing. */
const AI_SUMMARY_WAIT_MS = 90_000;

// The facts a run is about to act on: the file and what was found in it, the mode and model, and where it lands. The first thing in the
// "This run" rail on steps 2 and 3, so the reviewer sees the same summary beside the control that moves them on.
// The file being read, under the page title (the approved mockup): its name, its size and "Change document". Said once; the rail does not repeat it.
function FileStrip({ file, preview, onChangeDocument }: { file: File | null; preview: PreviewResult | null; onChangeDocument: () => void }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-hairline bg-surface-alt px-3 py-2" data-testid="file-strip">
      <FileTypeIcon extension={preview?.fileType ?? file?.name.split('.').pop() ?? ''} className="h-6 w-6 flex-none" />
      {file && (
        <span className="min-w-0 truncate text-sm font-semibold text-ink-1" title={file.name}>
          {file.name}
        </span>
      )}
      <span className="font-mono text-meta text-ink-3">
        {preview ? `${preview.blockCount} blocks · ${preview.sectionCount} sections · ${preview.figureCount} figures` : '--'}
      </span>
      <Button variant="outline" size="sm" className="ml-auto" onClick={onChangeDocument}>
        Change document
      </Button>
    </div>
  );
}

function RunFacts({
  mode,
  model,
  project,
  areaPath,
  iterationPath,
  state,
}: {
  mode: 'baseline' | 'survey';
  model: string;
  project: string;
  areaPath: string;
  iterationPath: string;
  state: string;
}): React.ReactElement {
  return (
    <>
              <dl className="flex flex-col gap-1 text-xs">
                <div className="flex gap-2">
                  <dt className="w-12 flex-none text-ink-3">Mode</dt>
                  <dd className="min-w-0 text-ink-1">
                    {MODE_COPY[mode].title}
                    {mode === 'survey' && (
                      <>
                        {' · '}
                        <span className="font-mono">{model || 'default model'}</span>
                      </>
                    )}
                  </dd>
                </div>
                {(project || areaPath) && (
                  <div className="flex gap-2">
                    <dt className="w-12 flex-none text-ink-3">Lands</dt>
                    {/* A project alone is not a destination: the form still asks for an area path, so the rail must not say it lands anywhere. */}
                    <dd className={cn('min-w-0 break-words', areaPath ? 'font-mono text-ink-1' : 'text-ink-3')}>
                      {areaPath ? formatDestinationPreview(project, areaPath, iterationPath, state) : 'Not chosen yet'}
                    </dd>
                  </div>
                )}
              </dl>
    </>
  );
}

export function NewJobWizard(): React.ReactElement {
  const navigate = useNavigate();
  const { showToast, showErrorToast } = useToast();
  const orgUrl = useOrgUrl();
  // What the user had done before leaving this page and coming back (see newJobDraftStore); empty on a first visit.
  // A tab nobody has chosen anything in starts from the last job's destination (per user, a convenience only). The mode is not restored:
  // BASELINE is always preselected and the last job's mode is only labelled on its card (D1); a draft in progress keeps its own mode.
  const userId = useUserId();
  const [initial] = useState(() => {
    const draft = restorableDraft();
    const remembered = loadLastJobChoices(userId);
    return { ...withRememberedChoices(draft, remembered, { applyMode: false }), lastUsedMode: remembered?.mode };
  });
  // A draft kept from before the page became one (it had a third step) comes back on the last step there is.
  const [step, setStep] = useState<1 | 2 | 3>(Math.min(initial.step, STEPS.length) as 1 | 2);
  // The three steps share one container, so a step change replays a fade on it rather than remounting (focus survives; DESIGN.md section 8).
  const stepRootRef = useRef<HTMLDivElement>(null);
  // Only a step the person has not seen yet fades in; going back to one they have seen is an instant swap.
  const seenSteps = useRef(new Set<number>([step]));
  const fadeKey = useRef(String(step));
  if (!seenSteps.current.has(step)) {
    seenSteps.current.add(step);
    fadeKey.current = String(step);
  }
  useReplayOnChange(stepRootRef, fadeKey.current, ARRIVE.fade);
  // A step change replaces the control that had focus, so focus goes to the new step's heading, which reads the step
  // (W3C multi-page forms, Lightning focus guidance); never on first load. The page title carries the progress too, and
  // is put back when the wizard unmounts.
  const firstStepRender = useRef(true);
  useEffect(() => {
    if (firstStepRender.current) {
      firstStepRender.current = false;
      return;
    }
    const heading = stepRootRef.current?.querySelector('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [step]);
  // The mode sets how many steps there are (and step 2's name), so switching it on step 2 re-titles the page without moving focus.
  const [mode, setMode] = useState<'baseline' | 'survey'>(initial.mode);
  const steps = stepsFor(mode);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `Step ${step} of ${steps.length}: ${steps[step - 1]} - New job`;
    return () => {
      document.title = previousTitle;
    };
  }, [step, steps]);
  const stepTitle = (
    <>
      New job<span className="sr-only">, step {step} of {steps.length}</span>
    </>
  );
  const [file, setFile] = useState<File | null>(initial.file);
  const [preview, setPreview] = useState<PreviewResult | null>(initial.preview);
  // Dropzone status now lives on step 1 alongside the stat tiles (DESIGN.md
  // Track B, phase B14) -- previously step 1 was JUST the dropzone, and a
  // successful parse immediately navigated to step 2, so the tiles could
  // never actually show a "not parsed yet" state (by the time they render,
  // preview is always already resolved). Real placeholder-to-real-value
  // fill-in requires the tiles to exist on the SAME screen as the dropzone.
  const [parseStatus, setParseStatus] = useState<FileDropzoneStatus>(initial.parseStatus);
  const [parseError, setParseError] = useState<string | null>(null);
  // An earlier job of a file with this name, read once per parsed file from the job list. Best effort: nothing is shown if it cannot be read.
  const [previousRuns, setPreviousRuns] = useState<PreviousRuns | null>(null);
  const parsedFileName = preview && file ? file.name : null;
  useEffect(() => {
    setPreviousRuns(null);
    if (!parsedFileName) return;
    let cancelled = false;
    void (async () => {
      try {
        const jobs = await listJobs();
        if (!cancelled && Array.isArray(jobs)) setPreviousRuns(findPreviousRuns(jobs, parsedFileName));
      } catch {
        // The warning is a courtesy; without the list there is simply none.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parsedFileName]);
  const [project, setProject] = useState(initial.project);
  const [areaPath, setAreaPath] = useState(initial.areaPath);
  const [state, setState] = useState(initial.state);
  const [iterationPath, setIterationPath] = useState(initial.iterationPath);
  const [dedupScope, setDedupScope] = useState<'area_path' | 'project'>(initial.dedupScope);
  const [model, setModel] = useState(initial.model);
  // Mirror the user's work into the draft store so it survives a visit to another page (cleared on submit, replace and logout).
  useEffect(() => {
    useNewJobDraftStore.getState().patch({ step, file, preview, parseStatus, mode, model, project, areaPath, state, iterationPath, dedupScope });
  }, [step, file, preview, parseStatus, mode, model, project, areaPath, state, iterationPath, dedupScope]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelListing, setModelListing] = useState<ModelListing | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  // The overview comes with the preview (made from the parsed text and structure alone), so it is always the current file's: nothing to fetch.
  // The bulky profile stays out of what is submitted with the job.
  const documentOverview: DocumentOverview | null = preview?.overview
    ? {
        synopsis: preview.overview.synopsis,
        caveat: preview.overview.caveat,
        ...(preview.overview.lines ? { lines: preview.overview.lines } : {}),
        ...(preview.overview.structureHint ? { structureHint: preview.overview.structureHint } : {}),
      }
    : null;
  // The optional AI summary: fetched in the background while step 3 is open, never waited on (Start is always available), and hidden when
  // there is none. 'pending' only while the request is in flight; any failure or timeout leaves nothing on screen.
  const [aiSummary, setAiSummary] = useState<{ status: 'idle' | 'pending' | 'ready' | 'none'; text?: string }>({ status: 'idle' });
  const summaryInput = preview?.overview?.profile?.summaryInput;
  // Bumped by "Write it again": a new value re-runs the effect below, which asks the model once more.
  const [summaryRun, setSummaryRun] = useState(0);
  useEffect(() => {
    if (!isFinalStep(step, mode) || mode !== 'survey' || !summaryInput) {
      setAiSummary({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    // Later than this it is not worth showing. The waiting note goes first: an abort resolves the request with null, and a cancelled request's
    // result is ignored below (it may be a stale one), so nothing else would clear it.
    const giveUp = window.setTimeout(() => {
      setAiSummary({ status: 'none' });
      controller.abort();
    }, AI_SUMMARY_WAIT_MS);
    setAiSummary({ status: 'pending' });
    // "Write it again" asks the model afresh; the first request may be answered from the server's summary cache.
    previewSummary({ summaryInput, model: model || undefined, ...(summaryRun > 0 ? { fresh: true } : {}) }, controller.signal).then((text) => {
      if (controller.signal.aborted) return;
      // The result is in: the give-up timer must not outlive it, or it later turns a summary that is already on screen into "none".
      window.clearTimeout(giveUp);
      setAiSummary(text ? { status: 'ready', text } : { status: 'none' });
    });
    return () => {
      window.clearTimeout(giveUp);
      controller.abort();
    };
  }, [step, mode, summaryInput, model, summaryRun]);
  // DESIGN.md §11.2.3.d -- server-computed, both modes shown side by side
  // (ModeCards) so both are fetched regardless of which is selected.
  // undefined while in flight/not-yet-fetched; ModeCards renders '--' for
  // that state rather than a locally-approximated number.
  const [baselineEstimate, setBaselineEstimate] = useState<EtaEstimate | undefined>(undefined);
  const [surveyEstimate, setSurveyEstimate] = useState<EtaEstimate | undefined>(undefined);
  const [costConfirmOpen, setCostConfirmOpen] = useState(false);
  // Request-sequence guard: a fast model-dropdown change can resolve out of
  // order (the older request finishing after the newer one) and paint a
  // stale number over a fresher one. Only the response matching the
  // request fired most recently is allowed to commit to state.
  const estimateRequestSeq = useRef(0);
  // Same stale-response guard, separate lineage: file re-selection races
  // are independent of the model-dropdown estimate refresh above.
  const previewRequestSeq = useRef(0);
  // Sync guard against double-submit -- a synchronous ref checked before
  // any await (state alone is too slow: clicks before the first re-render
  // read the stale `false` from closure).
  const isSubmittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // "Has this browser completed login" -- the real ADO credential is
  // resolved server-side from the vault (keyed by the session cookie), so
  // the pickers below need no credential object threaded through at all,
  // only this boolean to decide picker-vs-free-text mode.
  const hasAdoSession = !!orgUrl;

  useEffect(() => {
    if (mode !== 'survey' || availableModels.length > 0) return;
    // Best-effort: if this fails, the dropdown just stays empty and the job
    // submits with no model override (falls back to the orchestrator's
    // configured default), matching pre-model-selection behavior.
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


  // A stale area path picked under a previous project must not be
  // submittable once the project changes -- the two are meant to stay
  // coherent (browsing project X's area paths then writing to project Y
  // would be silently wrong).
  // Only on a real change: a project restored from the draft must keep its restored area path.
  // The new project's own last area path is offered instead of an empty one (B6); never its mode (D1: the mode stays what is selected).
  const lastProject = useRef(project);
  useEffect(() => {
    if (lastProject.current === project) return;
    lastProject.current = project;
    setAreaPath(loadProjectChoices(userId, project)?.areaPath ?? '');
  }, [project, userId]);

  // DESIGN.md §11.2.3.d -- both mode cards show a real server-computed
  // range side by side, so both are fetched together whenever the document
  // (blockCount/figureCount) or the selected model changes. Deliberately
  // NOT keyed on `mode` -- switching which mode is selected doesn't change
  // either estimate's value, only which one is highlighted.
  useEffect(() => {
    if (!preview) return;
    const seq = ++estimateRequestSeq.current;
    Promise.all([
      getEstimate({ blockCount: preview.blockCount, figureCount: preview.figureCount, mode: 'baseline' }),
      getEstimate({ blockCount: preview.blockCount, figureCount: preview.figureCount, mode: 'survey', model: model || undefined, documentTokens: preview.documentTokens }),
    ])
      .then(([baseline, survey]) => {
        // A later request may have already superseded this one (fast
        // model-dropdown changes) -- never let a stale response commit
        // over a fresher one.
        if (seq !== estimateRequestSeq.current) return;
        setBaselineEstimate(baseline);
        setSurveyEstimate(survey);
      })
      .catch(() => {
        // Best-effort: on failure, keep whatever was previously shown (or
        // the '--' placeholder if nothing has resolved yet) -- never a
        // locally-approximated number (DESIGN.md §11.2.3.e: "show the
        // previous value, or show nothing").
      });
  }, [preview?.blockCount, preview?.figureCount, model]);

  // P5: whether a SURVEY job of this file would be served from the result cache. Asked once mode and model are known (preview runs on upload,
  // before either is chosen); best effort, and a stale answer for an earlier choice is dropped.
  const [cachedResult, setCachedResult] = useState(false);
  const fileHash = preview?.fileHash;
  useEffect(() => {
    setCachedResult(false);
    if (!fileHash || mode !== 'survey') return undefined;
    const controller = new AbortController();
    void getCachedResult({ fileHash, mode, model: model || undefined }, controller.signal).then((cached) => {
      if (!controller.signal.aborted) setCachedResult(cached);
    });
    return () => controller.abort();
  }, [fileHash, mode, model]);

  // How the file states its structure (the pre-study): the model reads the file's conventions, every answer is checked against the whole file, and the job
  // is built from exactly the rulebook shown. It runs for every file, in both modes (the items are still built by code): asked once per file as soon as the
  // file is parsed, and shown on step 3 (with no model connection it is skipped). Moving between steps keeps the answer (still in flight or not); a new
  // file, "Change document" or leaving the page drops it. It reads with the model chosen at that moment (BASELINE: the deployment's default; SURVEY: the
  // job's model). The model is not part of what triggers it: once read, the same file keeps its rules until the user reads it again, and the card says
  // when the job will use another model. Start waits for it: the tree is built by what it learned (owner decision, 2026-11-25).
  const [rules, setRules] = useState<{ status: RulesStatus; view: RulebookView | null; error: string | null; model?: string; startedAt?: string }>({ status: 'idle', view: null, error: null });
  const rulesRequestSeq = useRef(0);
  const rulesAbort = useRef<AbortController | null>(null);
  // The file the study was asked for, so returning to step 3 does not ask again.
  const rulesAskedFor = useRef<File | null>(null);
  // Set by "Change document": the same file is asked again only once the user goes on from step 1, not while they may still replace it.
  const rulesHeld = useRef(false);
  const modelForRules = useRef<string | undefined>(undefined);
  modelForRules.current = mode === 'baseline' ? undefined : model || undefined;

  const learnRules = useCallback(async (forFile: File, relearn: boolean): Promise<void> => {
    rulesAbort.current?.abort();
    const controller = new AbortController();
    rulesAbort.current = controller;
    const seq = ++rulesRequestSeq.current;
    const usedModel = modelForRules.current;
    setRules({ status: 'loading', view: null, error: null, model: usedModel, startedAt: new Date().toISOString() });
    try {
      const view = await previewRules(forFile, usedModel, relearn, controller.signal);
      if (seq !== rulesRequestSeq.current) return;
      setRules(view ? { status: 'ready', view, error: null, model: usedModel } : { status: 'error', view: null, error: 'The server gave no answer.', model: usedModel });
    } catch (err) {
      if (seq !== rulesRequestSeq.current || controller.signal.aborted) return;
      setRules({ status: 'error', view: null, error: errorReason(err, 'The model did not finish reading the file.'), model: usedModel });
    }
  }, []);

  const resetRules = useCallback((): void => {
    rulesRequestSeq.current += 1; // whatever is still in flight is no longer wanted
    rulesAbort.current?.abort();
    rulesAskedFor.current = null;
    setRules({ status: 'idle', view: null, error: null });
  }, []);

  // A different file (or none) starts from nothing; the cleanup also drops a request still in flight when the page is left.
  const hasPreview = preview !== null;
  useEffect(() => {
    rulesHeld.current = false;
    resetRules();
    return resetRules;
  }, [file, fileHash, hasPreview, resetRules]);

  // Asked as soon as the file is parsed. Order matters: this effect must stay declared after the reset above. Both run when `hasPreview`/`fileHash`
  // flip in the same render, and the reset aborts whatever is in flight, so asking first would be cancelled at once (which is also why it is not
  // started in handleFileSelected). `step` is a dependency only for "Change document" (held until the user leaves step 1).
  useEffect(() => {
    if (!file || !hasPreview || rulesAskedFor.current === file) return;
    if (rulesHeld.current && step === 1) return;
    rulesHeld.current = false;
    rulesAskedFor.current = file;
    void learnRules(file, false);
  }, [step, file, fileHash, hasPreview, learnRules]);

  async function handleSaveRulesEdit(edited: Record<string, unknown>): Promise<string | null> {
    if (!file) return 'There is no file.';
    try {
      // Checked with the model the rules were read with, which the card names.
      const view = await editRules(file, edited, rules.model);
      rulesRequestSeq.current += 1; // an older answer still coming back must not replace the edit
      setRules((current) => ({ status: 'ready', view, error: null, model: current.model }));
      return null;
    } catch (err) {
      return errorReason(err);
    }
  }
  // Start waits for the reading; 'idle' there is the moment before it is asked (the effect above runs after the first paint). A failed reading
  // also holds Start (studyFailed, below): the study is required.
  const rulesBusy = rules.status === 'loading' || rules.status === 'idle';
  // The model the reading used against the one the job will use (BASELINE: the default). A later model pick does not read again by itself.
  const defaultModelName = 'the default model';
  const rulesModelHint =
    rules.status === 'ready' && rules.view && !rules.view.skipped && rules.view.source !== 'user' && rules.model !== modelForRules.current
      ? { readWith: rules.model ?? defaultModelName, jobUses: modelForRules.current ?? defaultModelName }
      : null;

  // What was read from a studied document (the verdict, the decisions, the outline), and the user's undos: each proposal applies unless undone
  // (owner rule R4, 2026-11-26). Decisions start from what the stored rulebook holds; they are saved with it when the job starts, so the job
  // applies exactly what was decided.
  const reading = rules.status === 'ready' ? (rules.view?.details?.reading ?? null) : null;
  const [decisions, setDecisions] = useState<Record<string, ProposalDecision | undefined>>({});
  useEffect(() => {
    setDecisions(Object.fromEntries((reading?.decisions ?? []).map((d) => [d.headingId, d.decision ?? undefined])));
  }, [reading]);
  const [aboutOpen, setAboutOpen] = useState(false);
  // The study needs a model, in both modes (owner decision, 2026-11-25): with no model connection Start is blocked, with the reason.
  const noModel = rules.status === 'ready' && Boolean(rules.view?.skipped);
  // The study is required (owner decision, 2026-11-25): a failed one holds Start until it is asked again and succeeds.
  const studyFailed = rules.status === 'error';

  // Reading and analyzing the document (the Study): the reading the job itself does before Analyze, done here while the user checks the page,
  // so the job reuses it (ingestion keeps it by user, text, rulebook and model) instead of reading again. It starts once the file's layout is
  // settled, because it reads the tables by the rulebook shown, and with the model the job will use (BASELINE: the default). A different file,
  // rulebook, mode or model reads again; leaving the page stops it. Start waits for it; a reading that fails frees Start (the job then says so).
  const [study, setStudy] = useState<{ status: StudyStatus; done: number; total: number; view: DocumentStudy | null; error: string | null; startedAt?: string }>({
    status: 'waiting',
    done: 0,
    total: 0,
    view: null,
    error: null,
  });
  const studyModel = mode === 'survey' ? model || undefined : undefined;
  const studyRulebookId = rules.view?.id || undefined;
  const studyKey = file && hasPreview && !rulesBusy ? [fileHash, mode, studyModel ?? '', studyRulebookId ?? ''].join('|') : null;
  useEffect(() => {
    if (!file || studyKey === null) {
      setStudy({ status: 'waiting', done: 0, total: 0, view: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setStudy({ status: 'reading', done: 0, total: 0, view: null, error: null, startedAt: new Date().toISOString() });
    previewStudy(
      { file, mode, model: studyModel, rulebookId: studyRulebookId },
      (done, total) => {
        if (!controller.signal.aborted) setStudy((current) => ({ ...current, done, total }));
      },
      controller.signal,
    ).then(
      (result) => {
        if (controller.signal.aborted) return;
        setStudy((current) =>
          result.kind === 'skipped'
            ? { status: 'skipped', done: 0, total: 0, view: null, error: null }
            : { status: 'ready', done: current.total, total: current.total, view: result.study, error: null },
        );
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setStudy({ status: 'error', done: 0, total: 0, view: null, error: err instanceof Error ? err.message : 'The document could not be read.' });
      },
    );
    return () => controller.abort();
  }, [studyKey, file, mode, studyModel, studyRulebookId]);
  const studyBusy = study.status === 'waiting' || study.status === 'reading';

  async function handleFileSelected(selected: File): Promise<void> {
    const seq = ++previewRequestSeq.current;
    setFile(selected);
    setPreview(null);
    setParseStatus('parsing');
    setParseError(null);
    try {
      const result = await previewJob(selected);
      // A later file selection may have already superseded this one (a
      // fast re-select before this request resolves) -- never let a stale
      // response commit over a fresher one.
      if (seq !== previewRequestSeq.current) return;
      setPreview(result);
      setParseStatus('parsed');
    } catch (err) {
      // Regression: an upload failure here previously had NO feedback at
      // all -- the promise just rejected silently (no try/catch, no
      // console-visible UI signal), leaving the user stuck on step 1 with
      // no indication anything went wrong. Any transient backend hiccup
      // (a redeploy mid-request, a network blip) looked identical to the
      // app refusing to accept the file. Now also a real dropzone state
      // (FileDropzone's own `error` variant), not just an easy-to-miss toast.
      if (seq !== previewRequestSeq.current) return;
      const message = 'Failed to parse the uploaded file. Please try again.';
      setParseStatus('error');
      setParseError(message);
      showErrorToast(message, err);
    }
  }

  function handleReplace(): void {
    setFile(null);
    setPreview(null);
    setParseStatus('idle');
    setParseError(null);
  }

  // Start on the final step. A run forecast above the deployment's threshold asks first (the server decides: COST_CONFIRM_TOKENS), so a very large file
  // is a deliberate choice; everything else starts at once as before.
  function requestStart(): void {
    if (forecast?.requiresConfirmation) setCostConfirmOpen(true);
    else void handleSubmit();
  }

  async function handleSubmit(): Promise<void> {
    if (!file || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      // The decisions made on this page are stored with the rulebook first, so the job is built from exactly what the user decided.
      let rulebookId = rules.view?.id ? rules.view.id : undefined;
      const pairs = decisionPairs(decisions);
      const stored = decisionPairs(Object.fromEntries((reading?.decisions ?? []).map((d) => [d.headingId, d.decision ?? undefined])));
      if (reading && rules.view && JSON.stringify(pairs) !== JSON.stringify(stored)) {
        const edited = structuredClone(rules.view.rulebook) as { document?: Record<string, unknown> | null };
        if (edited.document) edited.document = { ...edited.document, decisions: pairs };
        const view = await editRules(file, edited, rules.model);
        rulebookId = view.id || undefined;
      }
      const { jobId } = await submitJob({
        file,
        areaPath,
        adoProject: project || undefined,
        mode,
        state: state || undefined,
        iterationPath: iterationPath || undefined,
        dedupScope: dedupScope === 'project' ? 'project' : undefined,
        model: mode === 'survey' ? model || undefined : undefined,
        // The rulebook shown in the card: the job is built from exactly it (only when the study learned something worth storing).
        rulebookId,
        // The AI summary goes with the job only if it was ready: the start button never waits for it.
        documentOverview: mode === 'survey' ? (documentOverview && aiSummary.status === 'ready' && aiSummary.text ? { ...documentOverview, aiSummary: aiSummary.text } : documentOverview) : undefined,
      });
      // Remembered for the next one; then the next visit starts from those choices, not from this draft.
      rememberJobChoices(userId, { mode, project, areaPath });
      useNewJobDraftStore.getState().reset();
      navigate(`/jobs/${jobId}`);
    } catch (err) {
      showErrorToast('Failed to start the job. Please try again.', err);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  // Deliberately does NOT clear file/preview -- unlike handleReplace, going
  // Back to review/re-upload is not "start over": the already-parsed file
  // and its stat tiles should still be sitting there on step 1 exactly as
  // left, not force a re-upload just to tweak something and step back.
  function handleBack(): void {
    setStep(1);
  }

  // "Change document" keeps the parsed file like Back, but the reading of its conventions starts over: an answer still coming back is dropped.
  function handleChangeDocument(): void {
    resetRules();
    rulesHeld.current = true;
    setStep(1);
  }

  if (step === 1) {
    return (
      <div ref={stepRootRef} data-testid="wizard-step" className="flex flex-col gap-4">
        <PageHeader title={stepTitle} description="Upload a requirements document to get started" />
        <Stepper steps={steps} states={wizardStepStates(0, mode)} />
        {/* DESIGN.md §11.1 -- "a two-pane split that owns the viewport by
            construction" -- previously a single narrow column stretched
            across AppShell's full-viewport-height <main>, reading as a
            large dead void either side of it on a wide monitor. LEFT grows
            (dropzone, then the document map); RIGHT is the parse readout,
            same two-pane pattern step 2 already uses below. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
          <div className="flex min-w-0 flex-col gap-3">
            {/* Keyed on parse status, not on `file` -- handleFileSelected sets
                `file` BEFORE the parse resolves, so gating on `!file` hid the
                dropzone's own parsing/error states entirely: the user saw
                a Document card and '--' tiles with no sign anything was
                happening (or that it had failed). */}
            {parseStatus !== 'parsed' || !file ? (
              <FileDropzone
                onFileSelected={handleFileSelected}
                status={parseStatus}
                fileName={file?.name}
                errorMessage={parseError}
              />
            ) : (
              <>
                <SectionCard
                  title="Document"
                  action={
                    <Button size="sm" variant="outline" onClick={handleReplace}>
                      Replace
                    </Button>
                  }
                >
                  <div className="flex items-center gap-3">
                    <FileTypeIcon extension={preview?.fileType ?? file.name.split('.').pop() ?? ''} className="h-9 w-9" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{file.name}</p>
                      <p className="font-mono text-meta text-ink-3">
                        {formatFileSize(file.size)}
                        {preview && ` · ${preview.sectionCount} section${preview.sectionCount === 1 ? '' : 's'}`}
                      </p>
                    </div>
                  </div>
                </SectionCard>
                {/* The document map -- the honest answer to "what did it
                    read," one row per section, not just the 4 aggregate
                    totals in the right pane. Its own card (not nested under
                    "Document" above) -- matches the agreed mockup's split,
                    and gives a long map room to grow independently of the
                    file-identity row. */}
                {preview && preview.documentMap.length > 0 && (
                  <SectionCard
                    title={
                      <span className="flex items-center gap-2">
                        <AlignLeft className="h-4 w-4 flex-none text-ink-3" />
                        Document map
                        <span className="text-xs font-normal text-ink-3">what the parser found, in order</span>
                      </span>
                    }
                  >
                    <DocumentMapList sections={preview.documentMap} />
                  </SectionCard>
                )}
              </>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {/* '--' placeholders (not 0) while parsing/erroring -- 0 would
                read as a real, confirmed answer ("zero figures found")
                rather than "not known yet". */}
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile
                value={preview?.blockCount ?? '--'}
                label="Text blocks"
                icon={LayoutGrid}
                hint="Paragraphs, list items and table rows."
                interactive
              />
              <StatTile
                value={preview?.sectionCount ?? '--'}
                label="Sections"
                icon={AlignLeft}
                hint="Heading-level groups."
                interactive
              />
              <StatTile
                value={preview?.figureCount ?? '--'}
                label="Figures"
                icon={Image}
                hint="Images the vision model will describe."
                interactive
              />
              <StatTile
                value={preview?.depth ?? '--'}
                label="Heading levels"
                icon={Layers}
                hint="Deepest heading nesting found."
                interactive
              />
            </div>
            {/* Never renders empty -- with no file it states what will
                eventually fill this space, never a blank card. */}
            <SectionCard title="Worth knowing before you run it">
              <WorthKnowingCard preview={preview} parsing={parseStatus === 'parsing'} previousRuns={previousRuns} />
            </SectionCard>
            {file && (
              <div className="mt-auto flex flex-wrap items-center gap-3">
                <SafetyLine variant="wizard" />
                <Button onClick={() => setStep(2)} disabled={!preview} className="ml-auto">
                  {mode === 'baseline' ? 'Check and start' : 'Configure'}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // DESIGN.md §11.2.3.d -- the currently-selected mode's server-computed
  // estimate; the OTHER mode's is still fetched (see the effect above) so
  // ModeCards can show both side by side, but the footer only needs one.
  const selectedEstimate = mode === 'baseline' ? baselineEstimate : surveyEstimate;
  const estimateBasis = selectedEstimate && !cachedResult ? describeEstimateBasis(selectedEstimate) : null;
  const selectedEstimateLine = estimateLine(selectedEstimate, mode === 'survey' && cachedResult);
  // What a SURVEY run will spend in model tokens: not shown for a file served from the result cache, which spends none.
  const forecast = mode === 'survey' && !cachedResult ? surveyEstimate?.tokens : undefined;
  const forecastLine = tokenForecastLine(forecast);

  // SURVEY's step 3, or BASELINE's step 2 ("Check and start"): the page that shows what was read from the file and holds Start.
  const finalStep = isFinalStep(step, mode);
  // Start needs a destination. On BASELINE's single page it is chosen on the same page, so the bar says what Start is waiting for.
  const destinationMissing = !areaPath || (hasAdoSession && !project);
  // What was read from the file, shared by both final pages (SURVEY step 3, BASELINE step 2).
  const summaryBlock = mode === 'survey' ? <AiSummaryBlock aiSummary={aiSummary} onRewriteSummary={() => setSummaryRun((n) => n + 1)} /> : null;
  const studyPanel = rulesBusy ? (
    <>
      <FileStudyPanel status="studying" startedAt={rules.startedAt} decisions={decisions} onDecide={() => undefined} onOpenAbout={() => undefined} />
      {summaryBlock}
    </>
  ) : studyFailed ? (
    <>
      <FileStudyPanel
        status="failed"
        error={rules.error}
        decisions={decisions}
        onDecide={() => undefined}
        onOpenAbout={() => undefined}
        onRetry={() => file && void learnRules(file, true)}
      />
      {summaryBlock}
    </>
  ) : reading ? (
    <>
      {summaryBlock}
      <FileStudyPanel
        status="ready"
        reading={reading}
        decisions={decisions}
        onDecide={(headingId, decision) => setDecisions((current) => ({ ...current, [headingId]: decision }))}
        onOpenAbout={() => setAboutOpen(true)}
      />
      <AboutFilePanel
        open={aboutOpen}
        onOpenChange={setAboutOpen}
        reading={reading}
        codes={((rules.view?.rulebook as { document?: { grammar?: { requirement_codes?: string[] } } })?.document?.grammar?.requirement_codes) ?? []}
      />
    </>
  ) : null;
  const understanding = studyPanel ?? (
    <FileReadingCard
      overview={documentOverview ?? undefined}
      leftOut={preview?.leftOut}
      aiSummary={mode === 'survey' ? aiSummary : { status: 'idle' }}
      onRewriteSummary={() => setSummaryRun((n) => n + 1)}
      rules={{
        status: rules.status,
        view: rules.view,
        error: rules.error,
        startedAt: rules.startedAt,
        modelLabel: rules.model || (modelListing?.recommended ? `Default (${modelListing.recommended})` : 'Default'),
        modelHint: rulesModelHint,
      }}
      study={study}
      onRelearn={() => file && void learnRules(file, true)}
      onSaveEdit={handleSaveRulesEdit}
    />
  );
  const startBar = (
        // sticky: the list above can be long and a summary can appear or go away above it, and Start must not move out from under the pointer. Styled as the Write bar's dock (own border, shadow, z-10) so the content scrolling under it does not show through.
        <div data-dock className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-md border border-hairline-strong bg-surface px-3.5 py-2.5 shadow-dock">
          {/* One page in both modes: Back goes to the upload. */}
          <Button variant="outline" onClick={handleBack}>
            Back
          </Button>
          {/* One row (the approved mockup): Back, what Start is waiting for and the safety line, then Start. On a phone the text drops under the
              two buttons, so they share a row instead of Back standing alone. */}
          <div className="flex min-w-0 flex-1 flex-col gap-1 max-sm:order-last max-sm:basis-full">
          {/* Below lg the rail comes after this bar, so Start would be pressed without the destination in view: say it here. */}
          {areaPath && (
            <p className="min-w-0 break-words font-mono text-xs text-ink-2 lg:hidden">
              Lands in {formatDestinationPreview(project, areaPath, iterationPath, state)}
            </p>
          )}
          {destinationMissing && (
            <p className="text-xs text-ink-2">
              {hasAdoSession && !project ? 'Choose a team project and an area path to start.' : 'Choose an area path to start.'}
            </p>
          )}
          {/* Why Start waits, beside Start at every width (the card above holds the one status region and the timer). */}
          {(rulesBusy || studyBusy) && (
            <p className="text-xs text-ink-2" data-testid="start-waits">
              Start waits for: {readingLine(rules, study) ?? 'the file to be read'}.
            </p>
          )}
          {noModel && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-2" data-testid="start-needs-model">
              <span>An AI model is needed to read the file, in both modes. Connect a model, then read the file again.</span>
              <Button size="sm" variant="outline" onClick={() => file && void learnRules(file, true)}>
                Read the file again
              </Button>
            </p>
          )}
          {studyFailed && (
            <p className="text-xs text-ink-2" data-testid="start-study-failed">
              Start waits for the file study. Try again above.
            </p>
          )}
          <SafetyLine variant="wizard" />
          </div>
          <Button onClick={requestStart} disabled={isSubmitting || rulesBusy || studyBusy || destinationMissing || noModel || studyFailed} className="ml-auto">
            {isSubmitting ? <Spinner /> : <Activity className="h-3.5 w-3.5" />}
            {isSubmitting ? 'Starting…' : rulesBusy ? 'Reading the file…' : studyBusy ? 'Reading the document…' : 'Looks right — start job'}
          </Button>
        </div>
  );

  return (
    <div ref={stepRootRef} data-testid="wizard-step" className="flex flex-col gap-4">
      <PageHeader
        title={stepTitle}
        description={finalStep ? 'Set where it writes to and check what was read from the file before it runs' : 'Review the parsed document and set where it writes to'}
      />
      <Stepper steps={steps} states={wizardStepStates(1, mode)} />
      <FileStrip file={file} preview={preview} onChangeDocument={handleChangeDocument} />
      {/* DESIGN.md §11.2.5. Left: the decision path, in the order an engineer decides (how to read it, where it lands, then
          the folded options). Right: a quiet summary rail that reads the choices back and holds the action, so the primary
          button is in view without scrolling past the mode cards. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-7">
          {/* The approved mockup's order: what was read from the file, how to read it, where it lands, then the folded options and Start.
              Headings sit on the page, not in cards. */}
          {finalStep && understanding}
          <section aria-labelledby="wizard-mode-heading" className="flex flex-col gap-2.5">
            <h2 id="wizard-mode-heading" className="text-title">
              How should it read the document?
            </h2>
          <ModeCards
            value={mode}
            onChange={setMode}
            lastUsed={initial.lastUsedMode}
            baselineEstimate={baselineEstimate}
            surveyEstimate={surveyEstimate}
            surveyCached={cachedResult}
            model={model}
            onModelChange={setModel}
            availableModels={availableModels}
            modelDetails={modelListing?.details}
            recommendedModel={modelListing?.recommended}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
          />
          </section>
          <section aria-labelledby="wizard-destination-heading" className="flex flex-col gap-2.5">
            <h2 id="wizard-destination-heading" className="text-title">
              Where do the items land?
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            </div>
          </section>
          {/* Folded, but never unknown: the summary line states what each folded choice currently is. */}
          <details className="rounded-md border border-hairline bg-surface">
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
              <span className="text-sm font-semibold text-ink-1">More options</span>
              <span className="font-mono text-meta text-ink-3">
                Iteration: {iterationPath || 'project default'} · State: {state || 'default'} · Duplicates: {dedupScope === 'project' ? 'the whole project' : 'this area path and below'}
              </span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-hairline p-4">
              {/* labelExtra puts each InfoTip inline with its own label (see TextField/Select's labelExtra prop). */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {/* Gated on `project`: these pickers fetch per project, and without one they would show the backend's default project's data. */}
                {hasAdoSession && project ? (
                  <StatePicker
                    value={state}
                    onChange={setState}
                   
                    project={project}
                    labelExtra={
                      <InfoTip content="The workflow state each new item starts in, read from this project's own Epic, Feature and Requirement workflows — they vary by process template. Only states every type has are listed. Default starts each type in its own default state." />
                    }
                  />
                ) : (
                  <TextField
                    label="State (optional)"
                    labelExtra={
                      <InfoTip content="The workflow state each new item starts in, read from this project's own Epic, Feature and Requirement workflows — they vary by process template. Only states every type has are listed. Default starts each type in its own default state." />
                    }
                    value={state}
                    onChange={(event) => setState(event.target.value)}
                    disabled={hasAdoSession}
                    helperText={hasAdoSession ? 'Select a team project first' : undefined}
                    fullWidth
                  />
                )}
                {hasAdoSession && project ? (
                  <IterationPathPicker
                    value={iterationPath}
                    onChange={setIterationPath}
                    project={project}
                    labelExtra={
                      <InfoTip content="Every created item is assigned to this iteration. Leave it blank to use the project default if you plan to sort the backlog later." />
                    }
                  />
                ) : (
                  <TextField
                    label="Iteration path (optional)"
                    labelExtra={
                      <InfoTip content="Every created item is assigned to this iteration. Leave it blank to use the project default if you plan to sort the backlog later." />
                    }
                    value={iterationPath}
                    onChange={(event) => setIterationPath(event.target.value)}
                    disabled={hasAdoSession}
                    helperText={hasAdoSession ? 'Select a team project first' : undefined}
                    fullWidth
                  />
                )}
              </div>
              <DedupScopeSelect value={dedupScope} onChange={setDedupScope} />
            </div>
          </details>
          {finalStep && startBar}
        </div>

        {/* Sticky only on a viewport tall enough to hold it, so a short window never pins its bottom out of reach. */}
        <aside
          aria-label="This run"
          className="flex min-w-0 flex-col gap-4 lg:self-start lg:[@media(min-height:640px)]:sticky lg:[@media(min-height:640px)]:top-4"
        >
          <SectionCard title="This run">
            <div className="flex flex-col gap-3">
              <RunFacts
                mode={mode}
                model={model}
                project={project}
                areaPath={areaPath}
                iterationPath={iterationPath}
                state={state}
              />
              <PreviousRunLine previousRuns={previousRuns} />
              <div className="flex flex-col gap-2 border-t border-hairline pt-3">
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="font-mono text-metric font-semibold tabular-nums text-ink-1">{selectedEstimateLine?.value ?? '--'}</span>
                  <span className="text-xs text-ink-3">{selectedEstimateLine?.note ?? 'typically, once it starts'}</span>
                  {/* The basis is said here once; the mode card shows the range only. */}
                  {estimateBasis && <span className="basis-full text-meta text-ink-3">{estimateBasis}</span>}
                </div>
                {mode === 'survey' && selectedEstimate?.basis === 'blended' && selectedEstimate.nearSizeSampleCount === 0 && (
                  <p className="flex items-start gap-1.5 rounded-sm border border-info-border bg-info-soft px-2 py-1.5 text-xs text-info-ink">
                    <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
                    No finished With AI review run is near this document's size, so this estimate stretches the fit past what it has seen. Treat the range as rough.
                  </p>
                )}
                {mode === 'survey' && selectedEstimate?.basis === 'bootstrap' && (
                  <p className="flex items-start gap-1.5 rounded-sm border border-info-border bg-info-soft px-2 py-1.5 text-xs text-info-ink">
                    <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
                    No With AI review runs have finished here yet, so this is a starting estimate from the document's size. It becomes a measured range as With AI review jobs finish.
                  </p>
                )}
              </div>
              {forecastLine && (
                <div className="flex flex-wrap items-baseline gap-2.5 border-t border-hairline pt-3">
                  <span className="font-mono text-sm font-semibold tabular-nums text-ink-1">{forecastLine.value}</span>
                  <span className="text-xs text-ink-3">{forecastLine.note}</span>
                </div>
              )}
              {mode === 'survey' && (
                <div className="border-t border-hairline pt-3">
                  <KbReadinessStrip />
                </div>
              )}
            </div>
          </SectionCard>
          {finalStep && reading && <BuildPreview reading={reading} decisions={decisions} />}
        </aside>
      </div>
      {forecast && (
        <ConfirmDialog
          open={costConfirmOpen}
          onOpenChange={setCostConfirmOpen}
          title="Start a large With AI review run?"
          description={
            <>
              With {model || (modelListing?.recommended ? `your default model (${modelListing.recommended})` : 'your default model')}, this run is
              forecast to use roughly {formatTokenCount(forecast.inputTokens.low + forecast.outputTokens.low)} –{' '}
              {formatTokenCount(forecast.inputTokens.high + forecast.outputTokens.high)} model tokens (input and output),{' '}
              {forecast.costUsd ? `about ${formatUsdRange(forecast.costUsd)}` : 'no price is set for this model'}. It is a rough forecast made
              before the run, and your account is billed for what the run really uses.
              <span className="mt-2 block">Plus a short pre-study read of the file’s layout, not counted here.</span>
            </>
          }
          confirmLabel="Start the run"
          onConfirm={() => {
            setCostConfirmOpen(false);
            void handleSubmit();
          }}
          cancelVariant="outline"
        />
      )}
    </div>
  );
}
