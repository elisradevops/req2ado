import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { httpClient } from '../api/httpClient.js';
import { useAuthStore } from '../store/authStore.js';
import { TextField } from '../ui/TextField';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { Spinner } from '../ui/Spinner';
import { InfoTip } from '../ui/Tooltip';

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
  const [status, setStatus] = useState<'idle' | 'checking' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isLoggingInRef = useRef(false);

  const handleLogin = async (): Promise<void> => {
    // Synchronous ref guard, checked before any await -- form onSubmit can
    // re-fire (double-click / Enter resubmission) before React re-renders
    // the disabled submit button.
    if (isLoggingInRef.current) return;
    isLoggingInRef.current = true;
    setStatus('checking');
    setErrorMessage(null);
    try {
      // Stripped here, once, so every downstream consumer (work-item links in
      // ActionBadge.tsx/CollapsibleWarnings.tsx build `${orgUrl}/_workitems/edit/{id}`)
      // never has to guard against a trailing slash producing a broken `//`.
      const normalizedOrgUrl = adoOrgUrl.trim().replace(/\/+$/, '');
      const response = await httpClient.post('/auth/login', { adoOrgUrl: normalizedOrgUrl, pat });
      useAuthStore.getState().login(normalizedOrgUrl, response.data.displayName, response.data.userId);
      navigate('/jobs');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      isLoggingInRef.current = false;
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleLogin();
        }}
        className="w-full max-w-[420px] rounded-md border border-hairline bg-surface p-8 shadow-card"
      >
        <h1 className="text-lg font-semibold">Sign in to req2ado</h1>
        <p className="mb-6 mt-1 text-sm text-ink-3">
          Your ADO Personal Access Token identifies you and grants exactly the permissions your ADO account already has.
        </p>

        <div className="flex flex-col gap-3">
          <TextField label="ADO Organization URL" value={adoOrgUrl} onChange={(e) => setAdoOrgUrl(e.target.value)} fullWidth autoFocus />
          <div className="flex items-end gap-1.5">
            <TextField
              label="Personal Access Token"
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              fullWidth
            />
            <InfoTip content="In Azure DevOps: User settings → Personal access tokens → New Token. Grant Work Items (Read, write, & manage) at minimum — that's the only scope req2ado needs." />
          </div>
          <Button type="submit" disabled={!adoOrgUrl || !pat || status === 'checking'}>
            {status === 'checking' && <Spinner />}
            Sign in
          </Button>
          {status === 'error' && <Alert severity="error">{errorMessage}</Alert>}
        </div>
      </form>
    </div>
  );
}
