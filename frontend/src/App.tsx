import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppThemeProvider } from './theme/AppThemeProvider.js';
import { RouteGuard } from './components/RouteGuard';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastProvider';
import { Login } from './pages/Login';
import { JobsList } from './pages/JobsList';
import { NewJobWizard } from './pages/NewJobWizard';
import { JobDetail } from './pages/JobDetail';
import { Wiki } from './pages/Wiki';
import { KnowledgeBase } from './pages/KnowledgeBase';

export function App(): React.ReactElement {
  return (
    <AppThemeProvider>
      <ErrorBoundary>
        <ToastProvider>
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
                        <Route path="/knowledge-base" element={<KnowledgeBase />} />
                        <Route path="/help" element={<Wiki />} />
                      </Routes>
                    </AppShell>
                  </RouteGuard>
                }
              />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </ErrorBoundary>
    </AppThemeProvider>
  );
}
