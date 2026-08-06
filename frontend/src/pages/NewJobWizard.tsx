import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileTypeIcon } from '../components/FileTypeIcon';
import { FileDropzone, type FileDropzoneStatus } from '../components/FileDropzone';
import { ModeCards } from '../components/ModeCards';
import { AreaPathPicker } from '../components/AreaPathPicker';
import { IterationPathPicker } from '../components/IterationPathPicker';
import { StatePicker } from '../components/StatePicker';
import { ProjectPicker } from '../components/ProjectPicker';
import { previewJob, submitJob, listModels } from '../api/jobs';
import { computeEtaMinutes, formatEtaMinutes } from '../utils/eta';
import { useOrgUrl } from '../store/authStore';
import { useToast } from '../components/ToastProvider';
import { PageHeader } from '../ui/PageHeader';
import { SectionCard } from '../ui/SectionCard';
import { TextField } from '../ui/TextField';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Alert } from '../ui/Alert';
import { StatTile } from '../ui/StatTile';
import { Stepper } from '../ui/Stepper';
import { InfoTip } from '../ui/Tooltip';

// The flow is genuinely two screens (upload, then configure+review) -- a
// 4-label stepper (Source/Target/Options/Review) would claim stages that
// don't exist as separate screens, since target/options/review all live on
// one page today. Two honest stages instead of a stage count the UI can't
// back up.
const WIZARD_STEPS = ['Upload document', 'Configure & review'];

export interface PreviewResult {
  blockCount: number;
  sectionCount: number;
  figureCount: number;
  // The document's own numbering depth (max heading level) -- NOT the
  // eventual work-item tree depth, which only exists after /level's
  // (expensive, LLM-driven for SURVEY) hierarchy inference. See
  // jobs.controller.ts's preview() doc comment.
  depth: number;
  fileType: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function NewJobWizard(): React.ReactElement {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const orgUrl = useOrgUrl();
  const [step, setStep] = useState<1 | 2>(1);
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

  // A stale area path picked under a previous project must not be
  // submittable once the project changes -- the two are meant to stay
  // coherent (browsing project X's area paths then writing to project Y
  // would be silently wrong).
  useEffect(() => {
    setAreaPath('');
  }, [project]);

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
      });
      navigate(`/jobs/${jobId}`);
    } catch {
      showToast('Failed to start the job. Please try again.', 'error');
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

  if (step === 1) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="New Job" description="Upload a requirements document to get started" />
        <Stepper steps={WIZARD_STEPS} activeIndex={0} />
        <FileDropzone onFileSelected={handleFileSelected} status={parseStatus} fileName={file?.name} errorMessage={parseError} />
        {file && (
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
                <p className="text-xs text-ink-3">{formatFileSize(file.size)}</p>
              </div>
            </div>
          </SectionCard>
        )}
        {file && (
          // '--' placeholders (not 0) while parsing/erroring -- 0 would
          // read as a real, confirmed answer ("zero figures found") rather
          // than "not known yet".
          <div className="grid grid-cols-4 gap-2.5">
            <StatTile value={preview?.blockCount ?? '--'} label="Blocks" />
            <StatTile value={preview?.sectionCount ?? '--'} label="Sections" />
            <StatTile value={preview?.figureCount ?? '--'} label="Figures" />
            <StatTile value={preview?.depth ?? '--'} label="Depth" />
          </div>
        )}
        {file && (
          <div className="flex justify-end">
            <Button onClick={() => setStep(2)} disabled={!preview}>
              Next Step
            </Button>
          </div>
        )}
      </div>
    );
  }

  const eta = preview ? computeEtaMinutes(preview.blockCount, mode) : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="New Job" description="Review the parsed document and set where it writes to" />
      <Stepper steps={WIZARD_STEPS} activeIndex={1} />
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
            </div>
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="How should it read the document?">
            <ModeCards value={mode} onChange={setMode} />
          </SectionCard>
          {mode === 'survey' && (
            <Alert severity="warning">
              SURVEY mode can run 15-40+ minutes depending on document size. You'll see progress on the job page once it starts.
            </Alert>
          )}
          <SectionCard title="Options">
            <div className="flex flex-col gap-3">
              {/* No "follow-up document" checkbox -- checking whether a work
                  item already exists under this destination is now always
                  performed, not an opt-in a reviewer has to remember to tick. */}
              {mode === 'survey' && (
                <div className="flex items-end gap-1.5">
                  <Select
                    label="LLM Model (optional)"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    helperText="Leave blank to use the orchestrator's default model"
                    fullWidth
                  >
                    <option value="">Default</option>
                    {availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                  <InfoTip content="Fetched live from the LLM backend, not a fixed list. Only change this if you know why you need a different model." />
                </div>
              )}
            </div>
          </SectionCard>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button variant="outline" onClick={handleBack}>
              Back
            </Button>
            <span className="ml-auto flex items-center gap-1.5 text-sm text-ink-2">
              Estimated: ~{formatEtaMinutes(eta)}
              <InfoTip content="BASELINE parses structure only, minutes. SURVEY additionally runs an LLM quality/dedup pass per clause, which scales with document size -- typically 15-40+ minutes." />
            </span>
            <Button onClick={handleSubmit} disabled={!areaPath || (hasAdoSession && !project) || isSubmitting}>
              {isSubmitting && <Spinner />}
              {isSubmitting ? 'Starting…' : 'Start'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
