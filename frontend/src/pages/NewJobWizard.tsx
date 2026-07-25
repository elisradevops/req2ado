import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import { FileDropzone } from '../components/FileDropzone';
import { ModeCards } from '../components/ModeCards';
import { AreaPathPicker } from '../components/AreaPathPicker';
import { ProjectPicker } from '../components/ProjectPicker';
import { previewJob, submitJob, listModels } from '../api/jobs';
import { computeEtaMinutes } from '../utils/eta';
import { useOrgUrl, usePat, useUserId } from '../store/authStore';
import { useToast } from '../components/ToastProvider';

export interface PreviewResult {
  blockCount: number;
  sectionCount: number;
  fileType: string;
}

export function NewJobWizard(): React.ReactElement {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const orgUrl = useOrgUrl();
  const pat = usePat();
  const userId = useUserId();
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [mode, setMode] = useState<'baseline' | 'survey'>('baseline');
  const [project, setProject] = useState('');
  const [areaPath, setAreaPath] = useState('');
  const [state, setState] = useState('');
  const [iterationPath, setIterationPath] = useState('');
  const [followUp, setFollowUp] = useState(false);
  const [model, setModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  // Stable reference across re-renders (including every keystroke in the
  // area-path field itself, which re-renders this component via setAreaPath)
  // -- an inline object literal here would give AreaPathPicker's useEffect a
  // new `credential` on every render, retriggering GET /ado/area-paths in a
  // tight loop. Only actually changes when orgUrl/pat themselves change.
  const credential = useMemo(() => (orgUrl && pat ? { orgUrl, pat } : null), [orgUrl, pat]);

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
    try {
      const result = await previewJob(selected);
      setPreview(result);
      setStep(2);
    } catch {
      // Regression: an upload failure here previously had NO feedback at
      // all -- the promise just rejected silently (no try/catch, no
      // console-visible UI signal), leaving the user stuck on step 1 with
      // no indication anything went wrong. Any transient backend hiccup
      // (a redeploy mid-request, a network blip) looked identical to the
      // app refusing to accept the file.
      showToast('Failed to parse the uploaded file. Please try again.', 'error');
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!file) return;
    try {
      const { jobId } = await submitJob({
        file,
        areaPath,
        userId,
        mode,
        state: state || undefined,
        iterationPath: iterationPath || undefined,
        followUp,
        model: mode === 'survey' ? model || undefined : undefined,
      });
      navigate(`/jobs/${jobId}`);
    } catch {
      showToast('Failed to start the job. Please try again.', 'error');
    }
  }

  if (step === 1) {
    return (
      <Box>
        <Typography variant="h5">New Job — Step 1: Upload</Typography>
        <FileDropzone onFileSelected={handleFileSelected} />
      </Box>
    );
  }

  const eta = preview ? computeEtaMinutes(preview.blockCount, mode) : 0;

  return (
    <Box>
      <Typography variant="h5">New Job — Step 2: Review &amp; Configure</Typography>
      <Typography>Parsed {preview?.blockCount} blocks, {preview?.sectionCount} sections ({preview?.fileType}).</Typography>
      <ModeCards value={mode} onChange={setMode} />
      <Typography>Estimated time: ~{eta} min</Typography>
      {credential ? (
        <>
          <ProjectPicker value={project} onChange={setProject} credential={credential} />
          {project ? (
            <AreaPathPicker value={areaPath} onChange={setAreaPath} credential={credential} project={project} />
          ) : (
            <TextField label="Area Path" value={areaPath} disabled helperText="Select a team project first" />
          )}
        </>
      ) : (
        <TextField label="Area Path" value={areaPath} onChange={(event) => setAreaPath(event.target.value)} />
      )}
      <TextField label="State (optional)" value={state} onChange={(event) => setState(event.target.value)} />
      <TextField label="Iteration Path (optional)" value={iterationPath} onChange={(event) => setIterationPath(event.target.value)} />
      <FormControlLabel
        control={<Checkbox checked={followUp} onChange={(event) => setFollowUp(event.target.checked)} />}
        label="This is a follow-up document — check for requirements already ingested here"
      />
      {mode === 'survey' && (
        <TextField
          select
          label="LLM Model (optional)"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          helperText="Leave blank to use the orchestrator's default model"
        >
          <MenuItem value="">Default</MenuItem>
          {availableModels.map((m) => (
            <MenuItem key={m} value={m}>
              {m}
            </MenuItem>
          ))}
        </TextField>
      )}
      <Button variant="contained" onClick={handleSubmit} disabled={!areaPath || (!!credential && !project)}>Start</Button>
    </Box>
  );
}
