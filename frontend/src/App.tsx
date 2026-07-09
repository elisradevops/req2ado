import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppThemeProvider } from './theme/AppThemeProvider.js';
import { RouteGuard } from './components/RouteGuard';
import { AppShell } from './components/AppShell';
import { Login } from './pages/Login';
import { JobsList } from './pages/JobsList';
import { NewJobWizard } from './pages/NewJobWizard';
import { JobDetail } from './pages/JobDetail';
import { Wiki } from './pages/Wiki';

export function App(): React.ReactElement {
  return (
    <AppThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/*"
            element={
              <RouteGuard>
                <AppShell>
                  <Routes>
                    <Route path="/jobs" element={<JobsList />} />
                    <Route path="/jobs/new" element={<NewJobWizard />} />
                    <Route path="/jobs/:id" element={<JobDetail />} />
                    <Route path="/help" element={<Wiki />} />
                  </Routes>
                </AppShell>
              </RouteGuard>
            }
          />
        </Routes>
      </BrowserRouter>
    </AppThemeProvider>
  );
}
