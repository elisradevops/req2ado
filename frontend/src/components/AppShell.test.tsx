import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as React from 'react';
import { AppShell } from './AppShell';
import * as authApi from '../api/auth';
import * as adoApi from '../api/ado';
import * as kbApi from '../api/kb';
import { useAuthStore } from '../store/authStore';

vi.mock('../api/auth');
vi.mock('../api/ado');
vi.mock('../api/kb');
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: vi.fn() };
});

describe('AppShell sign-out', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
  });

  it('revokes the server session before clearing local auth state and navigating to /login', async () => {
    const mockNavigate = vi.fn();
    const reactRouterDom = await import('react-router-dom');
    vi.mocked(reactRouterDom.useNavigate).mockReturnValue(mockNavigate);
    vi.spyOn(authApi, 'logoutSession').mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: /Jane/i }));
    await userEvent.click(await screen.findByText(/sign out/i));

    await waitFor(() => expect(authApi.logoutSession).toHaveBeenCalled());
    await waitFor(() => expect(useAuthStore.getState().orgUrl).toBeNull());
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('still clears local state and navigates even when revoking the session fails (already expired)', async () => {
    const mockNavigate = vi.fn();
    const reactRouterDom = await import('react-router-dom');
    vi.mocked(reactRouterDom.useNavigate).mockReturnValue(mockNavigate);
    vi.spyOn(authApi, 'logoutSession').mockRejectedValue(new Error('401'));

    render(
      <MemoryRouter>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: /Jane/i }));
    await userEvent.click(await screen.findByText(/sign out/i));

    await waitFor(() => expect(useAuthStore.getState().orgUrl).toBeNull());
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });
});

describe('AppShell connection-status LEDs', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
  });

  it('shows both ADO and SharePoint connection rows once their status resolves', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });

    render(
      <MemoryRouter>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Azure DevOps')).toBeInTheDocument();
    expect(screen.getByText('SharePoint')).toBeInTheDocument();
  });

  it('falls back to unreachable when either status call rejects, rather than leaving the LED stuck on a stale state', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockRejectedValue(new Error('network'));
    vi.spyOn(kbApi, 'getSharePointStatus').mockRejectedValue(new Error('network'));

    render(
      <MemoryRouter>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Azure DevOps')).toBeInTheDocument();
    expect(screen.getByText('SharePoint')).toBeInTheDocument();
  });
});
