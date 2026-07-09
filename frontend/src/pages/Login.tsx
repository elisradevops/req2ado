import { useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Card, CardContent, Stack, TextField, Typography, Alert } from '@mui/material';
import { httpClient } from '../api/httpClient.js';
import { useAuthStore } from '../store/authStore.js';

/**
 * Single-step login: the ADO Server itself is the identity provider. The
 * entered PAT is validated against ADO's own connectionData endpoint
 * (orchestrator's POST /auth/login), which both proves the credential works
 * and identifies the user — no separate app-level identity system, no
 * session/JWT, no app-level RBAC (see docs/architecture.md "App auth" /
 * CR4 of the corrected work plan: the org URL + PAT ARE the identity AND
 * the permissions, matching DocGen's login pattern). The PAT lives only in
 * this component's state — never persisted to localStorage/sessionStorage/
 * disk directly by this component — and is handed to the app-wide authStore
 * (session-storage-backed, see store/authStore.ts) on success so it can be
 * resent as a per-request header on ADO-write-triggering calls later (POST
 * /jobs/:id/confirm) — the app never stores a copy anywhere beyond that
 * single store.
 */
export interface AdoCredential {
  orgUrl: string;
  pat: string;
}

export function Login(): JSX.Element {
  const navigate = useNavigate();
  const [adoOrgUrl, setAdoOrgUrl] = useState('');
  const [pat, setPat] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);

  const handleLogin = async (): Promise<void> => {
    setStatus('checking');
    setErrorMessage(null);
    try {
      const response = await httpClient.post('/auth/login', { adoOrgUrl, pat });
      setDisplayName(response.data.displayName);
      setStatus('ok');
      useAuthStore.getState().login(adoOrgUrl, pat, response.data.displayName);
      navigate('/jobs');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Sign-in failed');
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default', px: 2 }}>
      <Card sx={{ maxWidth: 420, width: '100%' }}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" gutterBottom>
            Sign in to req2ado
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Your ADO Personal Access Token identifies you and grants exactly the permissions your ADO account already has.
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
            {status === 'ok' && <Alert severity="success">Signed in as {displayName}.</Alert>}
            {status === 'error' && <Alert severity="error">{errorMessage}</Alert>}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
