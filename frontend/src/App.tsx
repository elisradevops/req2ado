import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RouteGuard } from './components/RouteGuard';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastProvider';
import { Login } from './pages/Login';
import { JobsList } from './pages/JobsList';
import { NewJobWizard } from './pages/NewJobWizard';
import { BatchJobWizard } from './pages/BatchJobWizard';
import { BatchStatus } from './pages/BatchStatus';
import { JobDetail } from './pages/JobDetail';
import { Wiki } from './pages/Wiki';
import { KnowledgeBase } from './pages/KnowledgeBase';
import { Settings } from './pages/Settings';

export function App(): React.ReactElement {
  return (
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
                      <Route path="/" element={<Navigate to="/jobs" replace />} />
                      <Route path="/jobs" element={<JobsList />} />
                      <Route path="/jobs/new" element={<NewJobWizard />} />
                      <Route path="/jobs/batch/new" element={<BatchJobWizard />} />
                      <Route path="/jobs/batch/:batchId" element={<BatchStatus />} />
                      <Route path="/jobs/:id" element={<JobDetail />} />
                      <Route path="/knowledge-base" element={<KnowledgeBase />} />
                      <Route path="/help" element={<Wiki />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route
                        path="*"
                        element={
                          <div className="flex flex-col items-center gap-2 py-16 text-center">
                            <h1 className="text-lg font-semibold">Page not found</h1>
                            <p className="text-sm text-ink-3">This page doesn't exist.</p>
                          </div>
                        }
                      />
                    </Routes>
                  </AppShell>
                </RouteGuard>
              }
            />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
