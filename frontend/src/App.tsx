import { useState, type JSX } from 'react';
import { Button } from '@mui/material';
import { AppThemeProvider } from './theme/AppThemeProvider.js';
import { AppShell } from './components/AppShell.js';
import { Login, type AdoCredential } from './pages/Login.js';
import { Upload } from './pages/Upload.js';
import { JobStatus } from './pages/JobStatus.js';
import { Wiki } from './pages/Wiki.js';

export function App(): JSX.Element {
  // Held only in top-level component state — never persisted to
  // localStorage/sessionStorage/disk — so JobStatus can resend it as a
  // per-request header on POST /jobs/:id/confirm (the only route that
  // actually needs an ADO credential; Upload/GET status don't).
  const [credential, setCredential] = useState<AdoCredential | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [showWiki, setShowWiki] = useState(false);

  return (
    <AppThemeProvider>
      {!credential && <Login onLoginSuccess={setCredential} />}
      {credential && (
        <AppShell
          headerActions={
            <Button color="inherit" onClick={() => setShowWiki((prev) => !prev)}>
              {showWiki ? 'Back' : 'Help / Wiki'}
            </Button>
          }
        >
          {showWiki && <Wiki />}
          {!showWiki && !jobId && <Upload onJobSubmitted={setJobId} />}
          {!showWiki && jobId && <JobStatus jobId={jobId} credential={credential} />}
        </AppShell>
      )}
    </AppThemeProvider>
  );
}
