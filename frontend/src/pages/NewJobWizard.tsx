import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { FileDropzone } from '../components/FileDropzone';
import { previewJob } from '../api/jobs';

export interface PreviewResult {
  blockCount: number;
  sectionCount: number;
  fileType: string;
}

export function NewJobWizard(): React.ReactElement {
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  async function handleFileSelected(selected: File): Promise<void> {
    setFile(selected);
    const result = await previewJob(selected);
    setPreview(result);
    setStep(2);
  }

  if (step === 1) {
    return (
      <Box>
        <Typography variant="h5">New Job — Step 1: Upload</Typography>
        <FileDropzone onFileSelected={handleFileSelected} />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5">New Job — Step 2: Review &amp; Configure</Typography>
      <Typography>Parsed {preview?.blockCount} blocks, {preview?.sectionCount} sections ({preview?.fileType}).</Typography>
      {/* Step 2 form (mode, area path, state/iteration, submit) added in Task 18 */}
    </Box>
  );
}
