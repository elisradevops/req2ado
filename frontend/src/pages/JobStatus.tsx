import { useEffect, useRef, useState, type JSX } from 'react';
import { Box, Button, CircularProgress, Stack, Tooltip, Typography } from '@mui/material';
import { httpClient } from '../api/httpClient.js';
import type { AdoCredential } from './Login.js';
import { themeTokens } from '../theme/tokens.js';

interface DryRunDiffEntry {
  localId: string;
  parentLocalId?: string | null;
  type?: string;
  title?: string;
  description?: string;
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId: number | null;
  similarity: number | null;
}

interface JobData {
  id: string;
  status: string;
  dryRunDiff: DryRunDiffEntry[] | null;
}

export interface JobStatusProps {
  jobId: string;
  // Optional so existing/standalone renders of this component keep working
  // unchanged (e.g. against ADO_BACKEND=mock, which needs no credential) —
  // required only for a real ADO_BACKEND=real write to succeed.
  credential?: AdoCredential;
}

function DiffMarker({ action }: { action: 'create' | 'reuse' | 'dedup_skip' }): JSX.Element {
  // 'dedup_skip' gets its own amber/warning marker, distinct from both
  // 'create' (solid green) and 'reuse' (hollow) — it is a probabilistic
  // similarity match, not the certain exact-hash match 'reuse' represents,
  // and a reviewer needs to be able to tell the two apart at a glance.
  const style =
    action === 'create'
      ? { bgcolor: 'success.main', border: 'none' }
      : action === 'dedup_skip'
        ? { bgcolor: themeTokens.color.warning, border: 'none' }
        : { bgcolor: 'transparent', border: `2px solid ${themeTokens.color.textSecondary}` };
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

export function JobStatus({ jobId, credential }: JobStatusProps): JSX.Element {
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
      const headers = credential
        ? { 'X-Ado-Org-Url': credential.orgUrl, 'X-Ado-Pat': credential.pat }
        : undefined;
      const response = await httpClient.post(`/jobs/${jobId}/confirm`, undefined, { headers });
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
  const dedupSkipCount = job.dryRunDiff?.filter((e) => e.action === 'dedup_skip').length ?? 0;

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
                spacing={0.5}
                sx={{ p: 1.5, bgcolor: 'background.paper', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
              >
                <Stack direction="row" spacing={2} alignItems="center">
                  <DiffMarker action={entry.action} />
                  <Typography sx={{ fontFamily: themeTokens.font.mono, fontSize: '0.85rem', minWidth: 48 }}>
                    {entry.localId}
                  </Typography>
                  {entry.type && (
                    <Typography
                      sx={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        px: 0.75,
                        py: 0.25,
                        borderRadius: 0.5,
                        bgcolor: 'action.selected',
                        color: 'text.secondary',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {entry.type}
                    </Typography>
                  )}
                  {entry.title && <Typography sx={{ flexGrow: 1, fontWeight: 500 }}>{entry.title}</Typography>}
                  <Typography sx={{ flexGrow: entry.title ? 0 : 1, fontFamily: themeTokens.font.mono, fontSize: '0.8rem', color: 'text.secondary' }}>
                    {entry.action}
                  </Typography>
                  {entry.action === 'dedup_skip' && entry.similarity !== null && (
                    <Typography sx={{ fontFamily: themeTokens.font.mono, fontSize: '0.85rem', color: themeTokens.color.warning }}>
                      {Math.round(entry.similarity * 100)}% match
                    </Typography>
                  )}
                  {entry.existingAdoId !== null && (
                    <Typography sx={{ fontFamily: themeTokens.font.mono, fontSize: '0.85rem', color: 'text.secondary' }}>
                      → ADO #{entry.existingAdoId}
                    </Typography>
                  )}
                </Stack>
                {entry.description && (
                  <Typography sx={{ fontSize: '0.85rem', color: 'text.secondary', pl: '76px', whiteSpace: 'pre-wrap' }}>
                    {entry.description}
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {createCount} new · {reuseCount} reused
            {dedupSkipCount > 0 ? ` · ${dedupSkipCount} probable duplicate${dedupSkipCount === 1 ? '' : 's'} skipped` : ''}
          </Typography>
        </>
      )}

      {job.status === 'diff_ready' && !confirmResult && (
        <Tooltip title="This will write the 'create' rows above to Azure DevOps. This cannot be automatically undone.">
          <span>
            <Button variant="contained" onClick={handleConfirm} disabled={isConfirming}>
              Confirm Write
            </Button>
          </span>
        </Tooltip>
      )}
      {confirmResult && (
        <Typography sx={{ mt: 2 }}>
          {confirmResult.createdCount} item{confirmResult.createdCount === 1 ? '' : 's'} written to ADO.
        </Typography>
      )}
    </Box>
  );
}
