import { useState, type JSX } from 'react';
import { Button } from '@mui/material';
import { AppThemeProvider } from './theme/AppThemeProvider.js';
import { AppShell } from './components/AppShell.js';
import { Login } from './pages/Login.js';
import { Upload } from './pages/Upload.js';
import { JobStatus } from './pages/JobStatus.js';
import { Wiki } from './pages/Wiki.js';

export function App(): JSX.Element {
  const [loggedIn, setLoggedIn] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [showWiki, setShowWiki] = useState(false);

  return (
    <AppThemeProvider>
      {!loggedIn && <Login onLoginSuccess={() => setLoggedIn(true)} />}
      {loggedIn && (
        <AppShell
          headerActions={
            <Button color="inherit" onClick={() => setShowWiki((prev) => !prev)}>
              {showWiki ? 'Back' : 'Help / Wiki'}
            </Button>
          }
        >
          {showWiki && <Wiki />}
          {!showWiki && !jobId && <Upload onJobSubmitted={setJobId} />}
          {!showWiki && jobId && <JobStatus jobId={jobId} />}
        </AppShell>
      )}
    </AppThemeProvider>
  );
}
