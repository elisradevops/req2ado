import { useState } from 'react';
import type { JSX } from 'react';
import { Box, Button, Stack, TextField, Typography, Alert } from '@mui/material';
import { httpClient } from '../api/httpClient.js';

/**
 * Single-step login: the ADO Server itself is the identity provider. The
 * entered PAT is validated against ADO's own connectionData endpoint
 * (orchestrator's POST /auth/login), which both proves the credential works
 * and identifies the user — no separate app-level identity system (e.g.
 * Azure AD) is needed for this deployment. The PAT lives only in this
 * component's state — never persisted to localStorage/sessionStorage/disk —
 * and continues to be sent as a header on ADO-bound requests, unchanged from
 * Phase 0. The returned session token is held in memory only, for app-level
 * RBAC identity (see docs/architecture.md "PAT entry" / auth corrections).
 *
 * Azure AD remains a supported backend option (AUTH_PROVIDER=azure_ad) for
 * deployments that can register an app, but is not surfaced in this UI,
 * which targets the local-ADO-account-only case. A provider-switchable UI
 * is a future enhancement, not built now.
 */
export function Login(): JSX.Element {
  const [adoOrgUrl, setAdoOrgUrl] = useState('');
  const [pat, setPat] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setToken] = useState<string | null>(null);

  const handleLogin = async (): Promise<void> => {
    setStatus('checking');
    setErrorMessage(null);
    try {
      const response = await httpClient.post('/auth/login', { adoOrgUrl, pat });
      setToken(response.data.token);
      setStatus('ok');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Sign-in failed');
    }
  };

  return (
    <Box sx={{ maxWidth: 420, mx: 'auto', mt: 8 }}>
      <Typography variant="h5" gutterBottom>
        Sign in to req2ado
      </Typography>

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
        <Button variant="contained" onClick={handleLogin} disabled={!adoOrgUrl || !pat || status === 'checking'}>
          Sign in
        </Button>
        {status === 'ok' && <Alert severity="success">Signed in successfully.</Alert>}
        {status === 'error' && <Alert severity="error">{errorMessage}</Alert>}
      </Stack>
    </Box>
  );
}
