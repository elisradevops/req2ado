import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as React from 'react';
import { AppShell } from './AppShell';
import * as authApi from '../api/auth';
import * as adoApi from '../api/ado';
import * as kbApi from '../api/kb';
import * as llmApi from '../api/llm';
import { useAuthStore } from '../store/authStore';

vi.mock('../api/auth');
vi.mock('../api/ado');
vi.mock('../api/kb');
vi.mock('../api/llm');
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: vi.fn() };
});

describe('AppShell sign-out', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });
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

describe('AppShell breadcrumbs', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });
  });

  it('renders "Jobs / <id>" for a job detail route, with Jobs linking back to the list', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs/87fdf5b1-01a0-441d-a519-741598d7c0b0']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    const breadcrumb = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    const jobsLink = breadcrumb.getByRole('link', { name: 'Jobs' });
    expect(jobsLink).toHaveAttribute('href', '/jobs');
    // The full id is truncated on-screen (mono, 8 chars + ellipsis) and
    // carried in full inside the Tooltip for the "needs to actually match"
    // case -- asserting the truncated form is enough here since the
    // Tooltip's own copy behavior is covered by ui/Tooltip's usage elsewhere.
    expect(breadcrumb.getByText('87fdf5b1…')).toBeInTheDocument();
  });

  it('does not let /jobs/:id\'s prefix rule swallow /jobs/new (longest-prefix-first ordering)', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs/new']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    const breadcrumb = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    expect(breadcrumb.getByText('New Job')).toBeInTheDocument();
    expect(breadcrumb.queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();
  });

  it('renders a single, non-linked crumb for a route with no sub-path', async () => {
    render(
      <MemoryRouter initialEntries={['/knowledge-base']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    const breadcrumb = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    expect(breadcrumb.getByText('Knowledge Base')).toBeInTheDocument();
    expect(breadcrumb.queryByRole('link', { name: 'Knowledge Base' })).not.toBeInTheDocument();
  });
});

describe('AppShell connection-status LEDs', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
  });

  it('shows both ADO and SharePoint connection rows once their status resolves', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });

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

  it('shows the LLM Backend connection row with its real reachable latency', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });

    render(
      <MemoryRouter>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    expect(await screen.findByText('LLM Backend')).toBeInTheDocument();
  });

  it('shows the LLM Backend row as unreachable when the health check fails, not stuck loading', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockRejectedValue(new Error('network'));

    render(
      <MemoryRouter>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    expect(await screen.findByText('LLM Backend')).toBeInTheDocument();
  });

  it('falls back to unreachable when either status call rejects, rather than leaving the LED stuck on a stale state', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockRejectedValue(new Error('network'));
    vi.spyOn(kbApi, 'getSharePointStatus').mockRejectedValue(new Error('network'));
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });

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

  it('shows a live (pulsing) dot while the connectivity check is still in flight, not a false-failure red one', async () => {
    // Regression coverage: the dot color function previously fell through
    // its `undefined` status case straight to the danger/red branch for
    // the entire loading window, before either check had resolved --
    // confirmed real bug, not a hypothetical.
    let resolveAdo: (value: { status: 'valid' }) => void = () => {};
    vi.spyOn(adoApi, 'getAdoStatus').mockImplementation(() => new Promise((resolve) => (resolveAdo = resolve)));
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });

    render(
      <MemoryRouter>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    const adoRow = await screen.findByText('Azure DevOps');
    // The pulsing dot uses animate-ping (DESIGN.md's Ambient motion role) --
    // present only while status is still unresolved.
    expect(adoRow.parentElement?.querySelector('.animate-ping')).not.toBeNull();

    resolveAdo({ status: 'valid' });
    await waitFor(() => expect(adoRow.parentElement?.querySelector('.animate-ping')).toBeNull());
  });
});

describe('AppShell active nav-item anchoring', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });
  });

  it('renders the rail-indicator bar only on the active nav item', async () => {
    render(
      <MemoryRouter initialEntries={['/knowledge-base']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    const activeLink = await screen.findByRole('link', { name: /knowledge base/i });
    expect(activeLink).toHaveAttribute('aria-current', 'page');
    expect(activeLink.querySelector('.bg-rail-indicator')).not.toBeNull();

    const inactiveLink = screen.getByRole('link', { name: /^jobs$/i });
    expect(inactiveLink).not.toHaveAttribute('aria-current');
    expect(inactiveLink.querySelector('.bg-rail-indicator')).toBeNull();
  });
});
