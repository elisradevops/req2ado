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
      useAuthStore.getState().login(normalizedOrgUrl, response.data.displayName, response.data.userId, { email: response.data.email, accountName: response.data.accountName });
      navigate('/jobs');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      isLoggingInRef.current = false;
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas md:flex-row">
      {/* The brand panel is decoration: no control lives in it. Its colours are the brand tokens, which exist only for this panel. */}
      <aside data-testid="login-brand" className="flex flex-none flex-col justify-between bg-brand-blue px-6 py-4 text-white md:w-[40%] md:px-12 md:py-12">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-md bg-brand-yellow text-sm font-bold tracking-wide text-brand-blue">R2</span>
          <span className="text-title font-semibold">req2ado</span>
        </div>
        <div className="hidden flex-col gap-3 md:flex">
          <h2 className="text-display font-semibold leading-tight">From requirement documents to Azure DevOps work items</h2>
          <p className="max-w-[360px] text-sm text-white/80">Review every proposed change before anything is written to your project.</p>
        </div>
        <span className="hidden h-1 w-16 rounded-sm bg-brand-yellow md:block" aria-hidden="true" />
      </aside>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleLogin();
          }}
          className="w-full max-w-[420px] rounded-md border border-hairline bg-surface p-8 shadow-card"
        >
          <h1 className="text-title font-semibold">Welcome to req2ado</h1>
          <p className="mb-6 mt-1 text-sm text-ink-3">
            Your Azure DevOps personal access token identifies you and grants exactly the permissions your Azure DevOps account already has.
          </p>

          <div className="flex flex-col gap-3">
            <TextField
              label="Azure DevOps organization URL"
              value={adoOrgUrl}
              onChange={(e) => setAdoOrgUrl(e.target.value)}
              placeholder="https://tfs.example.com/tfs/DefaultCollection"
              fullWidth
              autoFocus
            />
            <TextField
              label="Personal Access Token"
              labelExtra={
                <InfoTip content="In Azure DevOps: User settings → Personal access tokens → New Token. Grant Work Items (Read, write, & manage) at minimum — that's the only scope req2ado needs." />
              }
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              fullWidth
            />
            <Button type="submit" disabled={!adoOrgUrl || !pat || status === 'checking'}>
              {status === 'checking' && <Spinner />}
              Sign in
            </Button>
            {status === 'error' && <Alert severity="error">{errorMessage}</Alert>}
          </div>
        </form>
      </main>
    </div>
  );
}
