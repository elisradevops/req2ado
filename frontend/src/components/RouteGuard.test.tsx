import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RouteGuard } from './RouteGuard';
import { ToastProvider } from './ToastProvider';
import { useAuthStore } from '../store/authStore';
import { useLlmConnectionStore } from '../store/llmConnectionStore';
import * as llmConnectionApi from '../api/llmConnection';

vi.mock('../api/llmConnection');

function renderAt(path: string): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<div>Login Page</div>} />
          <Route path="/jobs" element={<RouteGuard><div>Jobs Page</div></RouteGuard>} />
          <Route path="/settings" element={<RouteGuard><div>Settings Page</div></RouteGuard>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('RouteGuard', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    vi.spyOn(llmConnectionApi, 'getLlmConnection').mockResolvedValue({ configured: true });
  });

  it('redirects to /login when unauthenticated', () => {
    renderAt('/jobs');
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });

  it('renders children when authenticated and the Open WebUI connection is configured', async () => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    renderAt('/jobs');
    expect(screen.getByText('Jobs Page')).toBeInTheDocument();
    await waitFor(() => expect(llmConnectionApi.getLlmConnection).toHaveBeenCalled());
  });

  it('redirects to /settings (with an explanatory toast) when the Open WebUI connection is not configured yet', async () => {
    vi.spyOn(llmConnectionApi, 'getLlmConnection').mockResolvedValue({ configured: false });
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    renderAt('/jobs');

    await waitFor(() => expect(screen.getByText('Settings Page')).toBeInTheDocument());
    expect(screen.getByText(/configure your open webui connection/i)).toBeInTheDocument();
  });

  it('does not redirect away from /settings itself when the connection is not configured', async () => {
    vi.spyOn(llmConnectionApi, 'getLlmConnection').mockResolvedValue({ configured: false });
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    renderAt('/settings');

    await waitFor(() => expect(llmConnectionApi.getLlmConnection).toHaveBeenCalled());
    expect(screen.getByText('Settings Page')).toBeInTheDocument();
  });

  it('fails open (does not gate) when the connection check itself errors', async () => {
    vi.spyOn(llmConnectionApi, 'getLlmConnection').mockRejectedValue(new Error('network error'));
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    renderAt('/jobs');

    await waitFor(() => expect(llmConnectionApi.getLlmConnection).toHaveBeenCalled());
    expect(screen.getByText('Jobs Page')).toBeInTheDocument();
  });

  it('logging out resets the cached connection-configured state for the next login', () => {
    useLlmConnectionStore.getState().setConfigured(false);
    useAuthStore.getState().logout();
    expect(useLlmConnectionStore.getState().configured).toBeNull();
  });
});
