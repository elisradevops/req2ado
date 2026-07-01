import { useState } from 'react';
import type { JSX } from 'react';
import { Box, Button, Stack, TextField, Typography, Alert } from '@mui/material';
import { httpClient } from '../api/httpClient.js';

/**
 * Two-step entry: (1) app-level sign-in via Azure AD [placeholder until a
 * live tenant + orchestrator /auth/login route exist], (2) per-user ADO PAT
 * entry. The PAT lives only in this component's state — never persisted to
 * localStorage/sessionStorage/disk, and sent as a header on each request
 * rather than stored server-side (see docs/architecture.md "PAT entry").
 */
export function Login(): JSX.Element {
  const [adoOrgUrl, setAdoOrgUrl] = useState('');
  const [pat, setPat] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleValidate = async (): Promise<void> => {
    setStatus('checking');
    setErrorMessage(null);
    try {
      await httpClient.post(
        '/connection/validate',
        {},
        { headers: { 'X-Ado-Org-Url': adoOrgUrl, 'X-Ado-Pat': pat } },
      );
      setStatus('ok');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  return (
    <Box sx={{ maxWidth: 420, mx: 'auto', mt: 8 }}>
      <Typography variant="h5" gutterBottom>
        Sign in to req2ado
      </Typography>

      {/* Azure AD sign-in is wired once a tenant + orchestrator /auth/login route exist (tracked separately). */}
      <Button variant="outlined" fullWidth disabled sx={{ mb: 3 }}>
        Sign in with Azure AD (coming soon)
      </Button>

      <Stack spacing={2}>
        <TextField
          label="ADO Organization URL"
          value={adoOrgUrl}
          onChange={(e) => setAdoOrgUrl(e.target.value)}
          fullWidth
        />
        <TextField
          label="Personal Access Token"
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          fullWidth
        />
        <Button variant="contained" onClick={handleValidate} disabled={!adoOrgUrl || !pat || status === 'checking'}>
          Validate connection
        </Button>
        {status === 'ok' && <Alert severity="success">Connection validated.</Alert>}
        {status === 'error' && <Alert severity="error">{errorMessage}</Alert>}
      </Stack>
    </Box>
  );
}
