import { useState, type JSX } from 'react';
import { AppThemeProvider } from './theme/AppThemeProvider.js';
import { AppShell } from './components/AppShell.js';
import { Login } from './pages/Login.js';
import { Upload } from './pages/Upload.js';
import { JobStatus } from './pages/JobStatus.js';

export function App(): JSX.Element {
  const [loggedIn, setLoggedIn] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  return (
    <AppThemeProvider>
      {!loggedIn && <Login onLoginSuccess={() => setLoggedIn(true)} />}
      {loggedIn && (
        <AppShell>
          {!jobId && <Upload onJobSubmitted={setJobId} />}
          {jobId && <JobStatus jobId={jobId} />}
        </AppShell>
      )}
    </AppThemeProvider>
  );
}
