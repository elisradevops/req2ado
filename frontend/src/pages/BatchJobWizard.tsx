import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Activity } from 'lucide-react';
import { MultiFileDropzone } from '../components/MultiFileDropzone';
import { ModeCards } from '../components/ModeCards';
import { AreaPathPicker } from '../components/AreaPathPicker';
import { IterationPathPicker } from '../components/IterationPathPicker';
import { StatePicker } from '../components/StatePicker';
import { ProjectPicker } from '../components/ProjectPicker';
import { formatDestinationPreview } from '../components/DestinationBar';
import { submitBatch } from '../api/batches';
import { listModels } from '../api/jobs';
import { useOrgUrl } from '../store/authStore';
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

export function BatchJobWizard(): React.ReactElement {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const orgUrl = useOrgUrl();
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<'baseline' | 'survey'>('baseline');
  const [project, setProject] = useState('');
  const [areaPath, setAreaPath] = useState('');
  const [state, setState] = useState('');
  const [iterationPath, setIterationPath] = useState('');
  const [model, setModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
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
      .then(setAvailableModels)
      .catch(() => {
        setAvailableModels([]);
        setModelsError(true);
      })
      .finally(() => setModelsLoading(false));
  }, [mode, availableModels.length]);

  useEffect(() => {
    setAreaPath('');
  }, [project]);

  function handleFilesAdded(added: File[]): void {
    setFiles((prev) => [...prev, ...added]);
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
      });
      navigate(`/jobs/batch/${batchId}`);
    } catch {
      showToast('Failed to start the batch. Please try again.', 'error');
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  const canSubmit = files.length > 0 && !!areaPath && (!hasAdoSession || !!project) && !isSubmitting;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="New Batch" description="Upload multiple requirements documents to process them together" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="Documents">
            <MultiFileDropzone files={files} onFilesAdded={handleFilesAdded} onFileRemoved={handleFileRemoved} disabled={isSubmitting} />
          </SectionCard>

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
              <div className="grid grid-cols-2 gap-2.5">
                {hasAdoSession && project ? (
                  <StatePicker value={state} onChange={setState} workItemType="Requirement" project={project} />
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
                    label="Iteration Path (optional)"
                    value={iterationPath}
                    onChange={(event) => setIterationPath(event.target.value)}
                    disabled={hasAdoSession}
                    helperText={hasAdoSession ? 'Select a team project first' : undefined}
                    fullWidth
                  />
                )}
              </div>
              {(project || areaPath) && (
                <p className="font-mono text-xs text-ink-3">{formatDestinationPreview(project, areaPath, iterationPath, state)}</p>
              )}
            </div>
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard title="How should each file be read?">
            {/* Applies uniformly to every file in this batch -- there is no
                per-file mode override in v1. No per-file estimate exists
                either (this wizard deliberately never parses a file before
                submitting -- see the doc comment above ModeCards' own
                estimate props for why '--' is the honest state here, not a
                locally-approximated number). */}
            <ModeCards
              value={mode}
              onChange={setMode}
              model={model}
              onModelChange={setModel}
              availableModels={availableModels}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
            />
          </SectionCard>
          {mode === 'survey' && (
            <Alert severity="warning">
              This deployment runs at most {SURVEY_BATCH_THROTTLE_HINT} SURVEY file(s) from a batch at a time. With {files.length} file
              {files.length === 1 ? '' : 's'} selected, some will wait in queue while earlier ones finish.
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              <Lock className="h-3.5 w-3.5 flex-none" />
              Nothing is written to Azure DevOps until you confirm each file's own diff.
            </span>
            <Button onClick={handleSubmit} disabled={!canSubmit} className="ml-auto">
              {isSubmitting ? <Spinner /> : <Activity className="h-3.5 w-3.5" />}
              {isSubmitting ? 'Starting…' : `Start batch (${files.length} file${files.length === 1 ? '' : 's'})`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
