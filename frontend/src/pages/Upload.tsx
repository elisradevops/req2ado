import { useState, type JSX } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  FormControlLabel,
  Radio,
  RadioGroup,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { httpClient } from '../api/httpClient.js';

export interface UploadProps {
  onJobSubmitted: (jobId: string) => void;
}

export function Upload({ onJobSubmitted }: UploadProps): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [areaPath, setAreaPath] = useState('');
  const [mode, setMode] = useState<'baseline' | 'survey'>('baseline');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');

  const handleSubmit = async (): Promise<void> => {
    if (!file || !areaPath) return;
    setStatus('submitting');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('areaPath', areaPath);
      form.append('mode', mode);
      const response = await httpClient.post('/jobs', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      onJobSubmitted(response.data.jobId);
    } catch {
      setStatus('error');
    }
  };

  return (
    <Box sx={{ maxWidth: 560, mx: 'auto' }}>
      <Typography variant="h5" gutterBottom>
        Upload a requirements document
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Baseline mode extracts your document's structure verbatim — nothing is summarized or rewritten.
      </Typography>

      <Card>
        <CardContent sx={{ p: 4 }}>
          <RadioGroup value={mode} onChange={(event) => setMode(event.target.value as 'baseline' | 'survey')} sx={{ mb: 3 }}>
            <FormControlLabel value="baseline" control={<Radio />} label="Baseline — verbatim, deterministic" />
            <FormControlLabel value="survey" control={<Radio />} label="Survey — generative, formalized requirements" />
          </RadioGroup>

          <Tooltip title="The ADO Area Path work items will be created under, e.g. MyProject\Requirements">
            <TextField
              fullWidth
              label="Area Path"
              placeholder="Project\\Area1"
              value={areaPath}
              onChange={(event) => setAreaPath(event.target.value)}
              sx={{ mb: 3 }}
            />
          </Tooltip>

          <Box
            sx={{
              border: '1px dashed',
              borderColor: 'divider',
              borderRadius: 2,
              p: 3,
              mb: 3,
              bgcolor: 'grey.50',
              textAlign: 'center',
            }}
          >
            <label htmlFor="file-input" style={{ cursor: 'pointer', display: 'block' }}>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {file ? file.name : 'Choose a file to upload'}
              </Typography>
              <input
                id="file-input"
                type="file"
                aria-label="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                style={{ display: 'block', margin: '0 auto' }}
              />
            </label>
          </Box>

          <Button
            variant="contained"
            fullWidth
            onClick={handleSubmit}
            disabled={!file || !areaPath || status === 'submitting'}
          >
            Upload
          </Button>
          {status === 'error' && (
            <Alert severity="error" sx={{ mt: 2 }}>
              Upload failed. Check the file and try again.
            </Alert>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
