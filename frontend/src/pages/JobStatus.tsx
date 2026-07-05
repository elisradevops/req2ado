import { useEffect, useRef, useState, type JSX } from 'react';
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { httpClient } from '../api/httpClient.js';
import { themeTokens } from '../theme/tokens.js';

interface DryRunDiffEntry {
  localId: string;
  action: 'create' | 'reuse';
  existingAdoId: number | null;
}

interface JobData {
  id: string;
  status: string;
  dryRunDiff: DryRunDiffEntry[] | null;
}

export interface JobStatusProps {
  jobId: string;
}

function DiffMarker({ action }: { action: 'create' | 'reuse' }): JSX.Element {
  const isCreate = action === 'create';
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        flexShrink: 0,
        bgcolor: isCreate ? 'success.main' : 'transparent',
        border: isCreate ? 'none' : `2px solid ${themeTokens.color.textSecondary}`,
      }}
    />
  );
}

export function JobStatus({ jobId }: JobStatusProps): JSX.Element {
  const [job, setJob] = useState<JobData | null>(null);
  const [confirmResult, setConfirmResult] = useState<{ createdCount: number } | null>(null);
  const isConfirmingRef = useRef(false);
  const [isConfirming, setIsConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const response = await httpClient.get(`/jobs/${jobId}`);
      if (!cancelled) setJob(response.data);
    };
    void poll();
    const interval = setInterval(() => {
      if (job?.status === 'pending' || job?.status === 'running' || job === null) {
        void poll();
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId, job?.status]);

  const handleConfirm = async (): Promise<void> => {
    if (isConfirmingRef.current) return;
    isConfirmingRef.current = true;
    setIsConfirming(true);
    try {
      const response = await httpClient.post(`/jobs/${jobId}/confirm`);
      setConfirmResult({ createdCount: response.data.createdCount });
    } finally {
      isConfirmingRef.current = false;
      setIsConfirming(false);
    }
  };

  if (!job || job.status === 'pending' || job.status === 'running') {
    return (
      <Stack direction="row" spacing={2} alignItems="center" sx={{ justifyContent: 'center', mt: 8 }}>
        <CircularProgress size={20} />
        <Typography color="text.secondary">Processing…</Typography>
      </Stack>
    );
  }

  const createCount = job.dryRunDiff?.filter((e) => e.action === 'create').length ?? 0;
  const reuseCount = job.dryRunDiff?.filter((e) => e.action === 'reuse').length ?? 0;

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h5" gutterBottom sx={{ fontFamily: themeTokens.font.mono, fontSize: '1.1rem' }}>
        Job {job.id}
      </Typography>

      {job.dryRunDiff && (
        <>
          <Stack spacing={1.5} sx={{ my: 3 }}>
            {job.dryRunDiff.map((entry) => (
              <Stack
                key={entry.localId}
                direction="row"
                spacing={2}
                alignItems="center"
                sx={{ p: 1.5, bgcolor: 'background.paper', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
              >
                <DiffMarker action={entry.action} />
                <Typography sx={{ fontFamily: themeTokens.font.mono, fontSize: '0.85rem', minWidth: 48 }}>
                  {entry.localId}
                </Typography>
                <Typography sx={{ flexGrow: 1 }}>{entry.action}</Typography>
                {entry.existingAdoId !== null && (
                  <Typography sx={{ fontFamily: themeTokens.font.mono, fontSize: '0.85rem', color: 'text.secondary' }}>
                    → ADO #{entry.existingAdoId}
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {createCount} new · {reuseCount} reused
          </Typography>
        </>
      )}

      {job.status === 'diff_ready' && !confirmResult && (
        <Button variant="contained" onClick={handleConfirm} disabled={isConfirming}>
          Confirm Write
        </Button>
      )}
      {confirmResult && (
        <Typography sx={{ mt: 2 }}>
          {confirmResult.createdCount} item{confirmResult.createdCount === 1 ? '' : 's'} written to ADO.
        </Typography>
      )}
    </Box>
  );
}
