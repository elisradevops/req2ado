import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutGrid, AlignLeft, Image, Layers, Table2, TriangleAlert, Lock, ArrowRight, Activity, Cpu, Info } from 'lucide-react';
import { cn } from '../lib/cn';
import { FileTypeIcon } from '../components/FileTypeIcon';
import { FileDropzone, type FileDropzoneStatus } from '../components/FileDropzone';
import { ModeCards } from '../components/ModeCards';
import { AreaPathPicker } from '../components/AreaPathPicker';
import { IterationPathPicker } from '../components/IterationPathPicker';
import { StatePicker } from '../components/StatePicker';
import { ProjectPicker } from '../components/ProjectPicker';
import { formatDestinationPreview } from '../components/DestinationBar';
import { previewJob, submitJob, listModels, getEstimate, type EtaEstimate, type PreviewResult } from '../api/jobs';
import { previewExposition, type DocumentOverview } from '../api/jobs';
import { formatEtaRange } from '../utils/eta';
import { useOrgUrl } from '../store/authStore';
import { useToast } from '../components/ToastProvider';
import { PageHeader } from '../ui/PageHeader';
import { SectionCard } from '../ui/SectionCard';
import { TextField } from '../ui/TextField';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Alert } from '../ui/Alert';
import { Chip } from '../ui/Chip';
import { StatTile } from '../ui/StatTile';
import { Stepper } from '../ui/Stepper';
import { InfoTip } from '../ui/Tooltip';

// The flow is genuinely two screens (upload, then configure+review) -- a
// 4-label stepper (Source/Target/Options/Review) would claim stages that
// don't exist as separate screens, since target/options/review all live on
// one page today. Two honest stages instead of a stage count the UI can't
// back up.
const WIZARD_STEPS_BASELINE = ['Upload document', 'Configure & review'];
const WIZARD_STEPS_SURVEY = ['Upload document', 'Configure & review', 'Confirm understanding'];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
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
          <span className="w-10 flex-none font-mono text-meta text-ink-3">{section.number ?? '—'}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{section.title}</span>
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

// DESIGN.md §11.1 -- derived facts, not raw counts, and never empty: with
// no file it shows what will eventually fill this space. Every note here is
// a real, current-parse fact (table/figure/open-TBD counts already
// returned by preview()) -- never an invented risk to fill space.
function WorthKnowingCard({ preview }: { preview: PreviewResult | null }): React.ReactElement {
  if (!preview) {
    return <p className="text-xs text-ink-3">Drop a document and this fills with what the parser found in it.</p>;
  }
  const notes: { icon: typeof Table2; tone: 'warning' | 'neutral'; text: React.ReactNode }[] = [];
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
          Survey mode describes each one with a separate vision-model call — the main reason a Survey estimate runs longer than Baseline.
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

export function NewJobWizard(): React.ReactElement {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const orgUrl = useOrgUrl();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  // Dropzone status now lives on step 1 alongside the stat tiles (DESIGN.md
  // Track B, phase B14) -- previously step 1 was JUST the dropzone, and a
  // successful parse immediately navigated to step 2, so the tiles could
  // never actually show a "not parsed yet" state (by the time they render,
  // preview is always already resolved). Real placeholder-to-real-value
  // fill-in requires the tiles to exist on the SAME screen as the dropzone.
  const [parseStatus, setParseStatus] = useState<FileDropzoneStatus>('idle');
  const [parseError, setParseError] = useState<string | null>(null);
  const [mode, setMode] = useState<'baseline' | 'survey'>('baseline');
  const [project, setProject] = useState('');
  const [areaPath, setAreaPath] = useState('');
  const [state, setState] = useState('');
  const [iterationPath, setIterationPath] = useState('');
  const [model, setModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [documentOverview, setDocumentOverview] = useState<DocumentOverview | null>(null);
  const [expositionStatus, setExpositionStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  // DESIGN.md §11.2.3.d -- server-computed, both modes shown side by side
  // (ModeCards) so both are fetched regardless of which is selected.
  // undefined while in flight/not-yet-fetched; ModeCards renders '--' for
  // that state rather than a locally-approximated number.
  const [baselineEstimate, setBaselineEstimate] = useState<EtaEstimate | undefined>(undefined);
  const [surveyEstimate, setSurveyEstimate] = useState<EtaEstimate | undefined>(undefined);
  // Request-sequence guard: a fast model-dropdown change can resolve out of
  // order (the older request finishing after the newer one) and paint a
  // stale number over a fresher one. Only the response matching the
  // request fired most recently is allowed to commit to state.
  const estimateRequestSeq = useRef(0);
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
    listModels()
      .then(setAvailableModels)
      .catch(() => setAvailableModels([]));
  }, [mode, availableModels.length]);

  // Fires the exposition call exactly once per entry into step 3 -- guarded
  // on expositionStatus !== 'idle' so re-renders while step 3 is already
  // loading/ready/error don't re-fire the request.
  useEffect(() => {
    if (step !== 3 || expositionStatus !== 'idle' || !preview) return;
    setExpositionStatus('loading');
    previewExposition({ documentMap: preview.documentMap, sectionCount: preview.sectionCount, depth: preview.depth })
      .then((result) => {
        setDocumentOverview(result);
        setExpositionStatus('ready');
      })
      .catch(() => {
        setDocumentOverview(null);
        setExpositionStatus('error');
      });
  }, [step, expositionStatus, preview]);

  // A stale area path picked under a previous project must not be
  // submittable once the project changes -- the two are meant to stay
  // coherent (browsing project X's area paths then writing to project Y
  // would be silently wrong).
  useEffect(() => {
    setAreaPath('');
  }, [project]);

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
      getEstimate({ blockCount: preview.blockCount, figureCount: preview.figureCount, mode: 'survey', model: model || undefined }),
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

  async function handleFileSelected(selected: File): Promise<void> {
    setFile(selected);
    setPreview(null);
    setParseStatus('parsing');
    setParseError(null);
    try {
      const result = await previewJob(selected);
      setPreview(result);
      setParseStatus('parsed');
    } catch {
      // Regression: an upload failure here previously had NO feedback at
      // all -- the promise just rejected silently (no try/catch, no
      // console-visible UI signal), leaving the user stuck on step 1 with
      // no indication anything went wrong. Any transient backend hiccup
      // (a redeploy mid-request, a network blip) looked identical to the
      // app refusing to accept the file. Now also a real dropzone state
      // (FileDropzone's own `error` variant), not just an easy-to-miss toast.
      const message = 'Failed to parse the uploaded file. Please try again.';
      setParseStatus('error');
      setParseError(message);
      showToast(message, 'error');
    }
  }

  function handleReplace(): void {
    setFile(null);
    setPreview(null);
    setParseStatus('idle');
    setParseError(null);
  }

  async function handleSubmit(): Promise<void> {
    if (!file || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      const { jobId } = await submitJob({
        file,
        areaPath,
        mode,
        state: state || undefined,
        iterationPath: iterationPath || undefined,
        model: mode === 'survey' ? model || undefined : undefined,
        documentOverview: mode === 'survey' ? documentOverview : undefined,
      });
      navigate(`/jobs/${jobId}`);
    } catch {
      showToast('Failed to start the job. Please try again.', 'error');
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  // Step 2's own submit button: BASELINE creates the job directly
  // (unchanged); SURVEY instead advances to step 3, where the real
  // creation trigger lives.
  function handleContinueFromConfigure(): void {
    if (mode === 'survey') {
      setStep(3);
    } else {
      void handleSubmit();
    }
  }

  // Deliberately does NOT clear file/preview -- unlike handleReplace, going
  // Back to review/re-upload is not "start over": the already-parsed file
  // and its stat tiles should still be sitting there on step 1 exactly as
  // left, not force a re-upload just to tweak something and step back.
  function handleBack(): void {
    setStep(1);
  }

  if (step === 1) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="New Job" description="Upload a requirements document to get started" />
        <Stepper steps={mode === 'survey' ? WIZARD_STEPS_SURVEY : WIZARD_STEPS_BASELINE} activeIndex={0} />
        {/* DESIGN.md §11.1 -- "a two-pane split that owns the viewport by
            construction" -- previously a single narrow column stretched
            across AppShell's full-viewport-height <main>, reading as a
            large dead void either side of it on a wide monitor. LEFT grows
            (dropzone, then the document map); RIGHT is the parse readout,
            same two-pane pattern step 2 already uses below. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
          <div className="flex min-w-0 flex-col gap-3">
            {!file ? (
              <FileDropzone onFileSelected={handleFileSelected} status={parseStatus} errorMessage={parseError} />
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
                label="Blocks"
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
                label="Depth"
                icon={Layers}
                hint="Deepest heading nesting found."
                interactive
              />
            </div>
            {/* Never renders empty -- with no file it states what will
                eventually fill this space, never a blank card. */}
            <SectionCard title="Worth knowing before you run it">
              <WorthKnowingCard preview={preview} />
            </SectionCard>
            {file && (
              <div className="mt-auto flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-1.5 text-xs text-ink-3">
                  <Lock className="h-3.5 w-3.5 flex-none" />
                  Nothing is written to Azure DevOps until you approve the diff.
                </span>
                <Button onClick={() => setStep(2)} disabled={!preview} className="ml-auto">
                  Configure
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="New Job" description="Confirm the AI understood this document before it runs" />
        <Stepper steps={WIZARD_STEPS_SURVEY} activeIndex={2} />
        <SectionCard title="Does this look right?">
          <div className="flex flex-col gap-3">
            {expositionStatus === 'loading' && (
              <p className="flex items-center gap-2 text-sm text-ink-3">
                <Spinner /> Reading the document's structure…
              </p>
            )}
            {expositionStatus === 'ready' && documentOverview && (
              <>
                <p className="text-sm text-ink-1">{documentOverview.synopsis}</p>
                {documentOverview.caveat && (
                  <Alert severity="warning">{documentOverview.caveat}</Alert>
                )}
              </>
            )}
            {expositionStatus === 'error' && (
              <p className="text-sm text-ink-3">Couldn't generate a summary — you can still continue.</p>
            )}
          </div>
        </SectionCard>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => setStep(2)}>
            ← Back to configure
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting} className="ml-auto">
            {isSubmitting ? <Spinner /> : <Activity className="h-3.5 w-3.5" />}
            {isSubmitting ? 'Starting…' : 'Looks right — start job'}
          </Button>
        </div>
      </div>
    );
  }

  // DESIGN.md §11.2.3.d -- the currently-selected mode's server-computed
  // estimate; the OTHER mode's is still fetched (see the effect above) so
  // ModeCards can show both side by side, but the footer only needs one.
  const selectedEstimate = mode === 'baseline' ? baselineEstimate : surveyEstimate;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="New Job" description="Review the parsed document and set where it writes to" />
      <Stepper steps={mode === 'survey' ? WIZARD_STEPS_SURVEY : WIZARD_STEPS_BASELINE} activeIndex={1} />
      {/* Two-column split (prototype's `.split`, ~1.6:1) -- left column is
          document identity + destination, right column is how-to-read +
          options + the submit action. Previously one full-width vertical
          stack; this was the single biggest layout deviation from the
          approved prototype. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="Destination in Azure DevOps">
            <div className="flex flex-col gap-3">
              {hasAdoSession ? (
                <>
                  <ProjectPicker value={project} onChange={setProject} />
                  {project ? (
                    <AreaPathPicker value={areaPath} onChange={setAreaPath} project={project} />
                  ) : (
                    <TextField label="Area Path" value={areaPath} disabled helperText="Select a team project first" fullWidth />
                  )}
                </>
              ) : (
                <TextField label="Area Path" value={areaPath} onChange={(event) => setAreaPath(event.target.value)} fullWidth />
              )}
              {/* labelExtra puts each InfoTip inline with its own label
                  (see TextField/Select's labelExtra prop) instead of an
                  external items-end wrapper -- that previously tracked
                  whichever sibling's helper text made it tallest, so State's
                  icon (has helper text) and Iteration Path's icon (none)
                  landed at visibly different heights side by side. */}
              <div className="grid grid-cols-2 gap-2.5">
                {/* Gated on `project`, same reasoning/fix as Iteration Path
                    below -- StatePicker previously fetched unconditionally
                    with no project scoping at all (getStates had no project
                    param anywhere in the stack), so it silently showed the
                    backend's single default project's workflow states
                    regardless of which team project was actually selected. */}
                {hasAdoSession && project ? (
                  <StatePicker
                    value={state}
                    onChange={setState}
                    workItemType="Requirement"
                    project={project}
                    labelExtra={
                      <InfoTip content="The workflow state each new item starts in, fetched from this project's Requirement workflow -- it varies by process template. Proposed keeps items out of active sprint metrics until someone triages them." />
                    }
                  />
                ) : (
                  <TextField
                    label="State (optional)"
                    labelExtra={
                      <InfoTip content="The workflow state each new item starts in, fetched from this project's Requirement workflow -- it varies by process template. Proposed keeps items out of active sprint metrics until someone triages them." />
                    }
                    value={state}
                    onChange={(event) => setState(event.target.value)}
                    disabled={hasAdoSession}
                    helperText={hasAdoSession ? 'Select a team project first' : undefined}
                    fullWidth
                  />
                )}
                {/* Gated on `project` the same way AreaPathPicker above is --
                    previously this rendered the real picker unconditionally
                    with project={project || undefined}, so an undefined
                    project silently fell back to the backend's own
                    configured default and showed real iteration data before
                    the user had picked a team project at all (confirmed:
                    reported live as "why are these fields loaded before I
                    selected a project"). */}
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
                    label="Iteration Path (optional)"
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
              {/* One compact mono line, not JobDetail's full 4-box
                  DestinationBar -- the agreed design (§11.2.2) wants a
                  live "read it back" restatement here, but this card's 4
                  fields above already show every one of these values once;
                  a second set of 4 boxed segments would be showing the
                  exact same facts twice for no new information. This line
                  earns its place: it's the ONE place the resolved path
                  reads as a single sentence instead of 4 separate field
                  values, which is the actual point of "can you read the
                  destination back" -- JobDetail's boxed version stays full
                  there because that screen has no editable form to read
                  values off of at all. */}
              {(project || areaPath) && (
                <p className="font-mono text-xs text-ink-3">{formatDestinationPreview(project, areaPath, iterationPath, state)}</p>
              )}
            </div>
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="How should it read the document?">
            {/* Model picker now lives INSIDE the SURVEY card (ModeCards) --
                the standalone "Options" card below this used to exist for
                exactly one control, which only ever rendered for one of the
                two modes; the other mode saw an empty card. Removed rather
                than left as a sometimes-empty box. */}
            <ModeCards
              value={mode}
              onChange={setMode}
              baselineEstimate={baselineEstimate}
              surveyEstimate={surveyEstimate}
              model={model}
              onModelChange={setModel}
              availableModels={availableModels}
            />
          </SectionCard>
          {mode === 'survey' && (
            <Alert severity="warning">
              SURVEY mode scales with document size -- figures cost the most, since each triggers a separate vision-model call. You'll
              see progress on the job page once it starts.
            </Alert>
          )}
          <SectionCard title="What will it cost you?">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="font-mono text-metric font-semibold tabular-nums text-ink-1">
                  {selectedEstimate ? (
                    (() => {
                      const { lower, upper } = formatEtaRange(selectedEstimate.lowerMinutes, selectedEstimate.upperMinutes);
                      return lower === upper ? lower : `${lower} – ${upper}`;
                    })()
                  ) : (
                    '--'
                  )}
                </span>
                <span className="text-xs text-ink-3">typically, once it starts</span>
                <span className="ml-auto flex items-center gap-1">
                  <Chip className="border border-info-border bg-info-soft font-mono text-micro font-normal normal-case tabular-nums text-info-ink">
                    <Cpu className="h-3 w-3 flex-none" />
                    {mode.toUpperCase()}
                    {preview && ` · ${preview.blockCount} blocks, ${preview.figureCount} figures`}
                    {selectedEstimate && ` · ${selectedEstimate.basis === 'blended' ? `n=${selectedEstimate.sampleCount}` : 'no completed runs yet'}`}
                  </Chip>
                  <InfoTip
                    content={
                      selectedEstimate?.basis === 'blended'
                        ? `Based on ${selectedEstimate.sampleCount} previous SURVEY run${selectedEstimate.sampleCount === 1 ? '' : 's'} on this deployment. BASELINE parses structure only; SURVEY additionally runs an LLM quality/dedup pass per clause -- figures cost the most, since each triggers a separate vision call.`
                        : 'No completed SURVEY runs on this deployment yet -- this is a conservative starting estimate based on document size, not a measured one. BASELINE parses structure only; SURVEY additionally runs an LLM quality/dedup pass per clause.'
                    }
                  />
                </span>
              </div>
              {selectedEstimate?.basis === 'bootstrap' && (
                <p className="flex items-start gap-1.5 rounded-sm border border-info-border bg-info-soft px-2 py-1.5 text-xs text-info-ink">
                  <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
                  The first few runs use a conservative default. Every completed job feeds the fit, and this number sharpens on its own.
                </p>
              )}
            </div>
          </SectionCard>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={handleBack}>
              Back
            </Button>
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              <Lock className="h-3.5 w-3.5 flex-none" />
              Starting a job writes nothing. You approve the diff first.
            </span>
            <Button onClick={handleContinueFromConfigure} disabled={!areaPath || (hasAdoSession && !project) || isSubmitting} className="ml-auto">
              {isSubmitting ? <Spinner /> : mode === 'survey' ? <ArrowRight className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
              {isSubmitting ? 'Starting…' : mode === 'survey' ? 'Continue' : 'Start job'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
