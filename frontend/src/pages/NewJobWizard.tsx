import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import { FileDropzone } from '../components/FileDropzone';
import { ModeCards } from '../components/ModeCards';
import { AreaPathPicker } from '../components/AreaPathPicker';
import { previewJob, submitJob } from '../api/jobs';
import { computeEtaMinutes } from '../utils/eta';
import { useOrgUrl, usePat } from '../store/authStore';

export interface PreviewResult {
  blockCount: number;
  sectionCount: number;
  fileType: string;
}

export function NewJobWizard(): React.ReactElement {
  const navigate = useNavigate();
  const orgUrl = useOrgUrl();
  const pat = usePat();
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [mode, setMode] = useState<'baseline' | 'survey'>('baseline');
  const [areaPath, setAreaPath] = useState('');
  const [state, setState] = useState('');
  const [iterationPath, setIterationPath] = useState('');

  async function handleFileSelected(selected: File): Promise<void> {
    setFile(selected);
    const result = await previewJob(selected);
    setPreview(result);
    setStep(2);
  }

  async function handleSubmit(): Promise<void> {
    if (!file) return;
    const { jobId } = await submitJob({
      file,
      areaPath,
      mode,
      state: state || undefined,
      iterationPath: iterationPath || undefined,
    });
    navigate(`/jobs/${jobId}`);
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
      {orgUrl && pat ? (
        <AreaPathPicker value={areaPath} onChange={setAreaPath} credential={{ orgUrl, pat }} />
      ) : (
        <TextField label="Area Path" value={areaPath} onChange={(event) => setAreaPath(event.target.value)} />
      )}
      <TextField label="State (optional)" value={state} onChange={(event) => setState(event.target.value)} />
      <TextField label="Iteration Path (optional)" value={iterationPath} onChange={(event) => setIterationPath(event.target.value)} />
      <Button variant="contained" onClick={handleSubmit} disabled={!areaPath}>Start</Button>
    </Box>
  );
}
