import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter } from 'react-router-dom';
import * as React from 'react';
import { AppShell } from './AppShell';
import * as authApi from '../api/auth';
import * as adoApi from '../api/ado';
import * as kbApi from '../api/kb';
import * as llmApi from '../api/llm';
import { useAuthStore } from '../store/authStore';
import { AT_LEAST_MD, BELOW_MD } from '../hooks/useMediaQuery';
import { usePageLabelStore } from '../store/pageLabelStore';
import { useUiPreferencesStore } from '../store/uiPreferencesStore';

// The collapse choice is remembered, so it must not leak from one test to the next.
beforeEach(() => {
  useUiPreferencesStore.setState({ railCollapsed: false });
});

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
    // A hit area of at least 24 px tall (WCAG 2.5.8; DESIGN.md §5): a 20 px text link was under the floor.
    expect(jobsLink.className).toMatch(/min-h-6/);
    expect(jobsLink.className).toMatch(/inline-flex/);
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
    expect(breadcrumb.getByText('New job')).toBeInTheDocument();
    expect(breadcrumb.queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();
  });

  it('does not let /jobs/\'s prefix rule swallow /jobs/batch/new (NEW-05, longest-prefix-first ordering)', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs/batch/new']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    const breadcrumb = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    expect(breadcrumb.getByText('New batch')).toBeInTheDocument();
    // Must not render as "Jobs / batch/new" (the generic /jobs/ catch-all
    // misreading the second path segment as a job id) -- neither a "batch"
    // nor a "batch/new" crumb should appear.
    expect(breadcrumb.queryByText(/batch\/new/)).not.toBeInTheDocument();
  });

  it('renders "Jobs / <batchId>" for a batch status route (NEW-05), with Jobs linking back to the list', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs/batch/87fdf5b1-01a0-441d-a519-741598d7c0b0']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    const breadcrumb = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    const jobsLink = breadcrumb.getByRole('link', { name: 'Jobs' });
    expect(jobsLink).toHaveAttribute('href', '/jobs');
    expect(breadcrumb.getByText('87fdf5b1…')).toBeInTheDocument();
  });

  it('shows the job file name in the crumb once the job page has loaded it', async () => {
    usePageLabelStore.getState().setJobLabel('87fdf5b1-01a0-441d-a519-741598d7c0b0', 'mock_icd.docx');
    render(
      <MemoryRouter initialEntries={['/jobs/87fdf5b1-01a0-441d-a519-741598d7c0b0']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );
    const breadcrumb = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    expect(breadcrumb.getByText('mock_icd.docx')).toBeInTheDocument();
    expect(breadcrumb.queryByText('87fdf5b1…')).not.toBeInTheDocument();
    usePageLabelStore.setState({ jobLabels: {} });
  });

  it('names an unknown route instead of echoing its path', async () => {
    render(
      <MemoryRouter initialEntries={['/no/such/page']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );
    const breadcrumb = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    expect(breadcrumb.getByText('Page not found')).toBeInTheDocument();
    expect(breadcrumb.queryByText('/no/such/page')).not.toBeInTheDocument();
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
    expect(breadcrumb.getByText('Knowledge base')).toBeInTheDocument();
    expect(breadcrumb.queryByRole('link', { name: 'Knowledge base' })).not.toBeInTheDocument();
  });
});

describe('AppShell connection status', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
  });

  function renderApp() {
    return render(
      <MemoryRouter>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );
  }

  it('says all systems are OK once every connection has answered', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });

    renderApp();

    expect(await screen.findByRole('button', { name: 'System status: All systems OK' })).toBeInTheDocument();
  });

  it('says one needs attention when the LLM health check fails, not stuck loading', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockRejectedValue(new Error('network'));

    renderApp();

    expect(await screen.findByRole('button', { name: 'System status: 1 needs attention' })).toBeInTheDocument();
  });

  it('counts every call that rejects as needing attention, rather than leaving a stale state', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockRejectedValue(new Error('network'));
    vi.spyOn(kbApi, 'getSharePointStatus').mockRejectedValue(new Error('network'));
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });

    renderApp();

    expect(await screen.findByRole('button', { name: 'System status: 2 need attention' })).toBeInTheDocument();
  });

  it('says it is checking while a check is still in flight, not a false failure', async () => {
    // Regression coverage: a status that had not answered yet used to read as a failure for the whole loading window.
    let resolveAdo: (value: { status: 'valid' }) => void = () => {};
    vi.spyOn(adoApi, 'getAdoStatus').mockImplementation(() => new Promise((resolve) => (resolveAdo = resolve)));
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });

    renderApp();

    expect(await screen.findByRole('button', { name: 'System status: Checking connections…' })).toBeInTheDocument();
    expect(screen.queryByTestId('connection-count')).toBeNull();

    resolveAdo({ status: 'valid' });
    expect(await screen.findByRole('button', { name: 'System status: All systems OK' })).toBeInTheDocument();
  });

  it('opens the detail of each connection from the rail item', async () => {
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });
    renderApp();

    await userEvent.click(await screen.findByRole('button', { name: 'System status: All systems OK' }));

    const dialog = await screen.findByRole('dialog', { name: /connections/i });
    expect(within(dialog).getByText('Azure DevOps')).toBeInTheDocument();
    expect(within(dialog).getByText('Connected, expires in 47 minutes')).toBeInTheDocument();
    expect(within(dialog).getByText('Connected, 42ms')).toBeInTheDocument();
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

describe('AppShell below the md breakpoint', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });
  });

  function renderShell(path = '/jobs') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );
  }

  it('keeps the navigation closed until the header button opens it, and closes it again from the backdrop', async () => {
    renderShell();
    const nav = screen.getByTestId('app-rail');
    expect(nav).toHaveAttribute('data-open', 'false');
    expect(screen.queryByRole('button', { name: 'Close navigation' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(nav).toHaveAttribute('data-open', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(nav).toHaveAttribute('data-open', 'false');
  });

  it('has a skip link as the very first stop on every page, and it sends focus to the page', async () => {
    renderShell();
    await userEvent.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('closes the open navigation when a link is followed', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await userEvent.click(screen.getByRole('link', { name: /knowledge base/i }));
    expect(screen.getByTestId('app-rail')).toHaveAttribute('data-open', 'false');
  });

  it('sends focus to the page, not the menu button, when a link in the drawer was followed', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await userEvent.click(screen.getByRole('link', { name: /knowledge base/i }));
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('closes the drawer when the link to the page already open is followed (no pathname change)', async () => {
    renderShell('/jobs');
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await userEvent.click(screen.getByRole('link', { name: /^jobs$/i }));
    expect(screen.getByTestId('app-rail')).toHaveAttribute('data-open', 'false');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('does not transition visibility while opening, so the first link can take focus at once', async () => {
    renderShell();
    const nav = screen.getByTestId('app-rail');
    expect(nav.className).toContain('max-md:transition-[transform,visibility]');
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(nav.className).not.toContain('visibility');
    expect(nav.className).toContain('max-md:transition-[transform]');
  });

  it('returns focus to the menu button after Escape even if a nav link was followed earlier with the drawer closed', async () => {
    renderShell();
    // desktop-style navigation: the drawer was never open
    await userEvent.click(screen.getByRole('link', { name: /knowledge base/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveFocus();
  });

  it('closes the open navigation on Escape', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('app-rail')).toHaveAttribute('data-open', 'false');
  });

  it('shows the full labels below md even after the desktop rail was collapsed, and keeps the collapse choice for when the window widens again', async () => {
    // a viewport whose width can be flipped across md, notifying every listener like a real MediaQueryList
    let narrow = false;
    const listeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>();
    const matchesFor = (query: string): boolean => (query === BELOW_MD ? narrow : query === AT_LEAST_MD ? !narrow : false);
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      get matches() {
        return matchesFor(query);
      },
      media: query,
      addEventListener: (_: string, handler: (event: MediaQueryListEvent) => void) => {
        if (!listeners.has(query)) listeners.set(query, new Set());
        listeners.get(query)!.add(handler);
      },
      removeEventListener: (_: string, handler: (event: MediaQueryListEvent) => void) => listeners.get(query)?.delete(handler),
    })) as unknown as typeof window.matchMedia;
    const setNarrow = (value: boolean): void => {
      narrow = value;
      act(() => {
        for (const [query, handlers] of listeners) handlers.forEach((handler) => handler({ matches: matchesFor(query) } as MediaQueryListEvent));
      });
    };
    try {
      renderShell();
      await userEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
      expect(screen.getByText('Knowledge base')).toHaveClass('opacity-0');

      setNarrow(true);
      expect(screen.getByText('Knowledge base')).not.toHaveClass('opacity-0');
      expect(screen.getByRole('button', { name: /^system status:/i })).toBeInTheDocument();
      expect(screen.getByText(/all systems ok|checking connections/i)).toBeVisible();

      setNarrow(false);
      expect(screen.getByText('Knowledge base')).toHaveClass('opacity-0');
      expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();

      // a focused nav link keeps focus across the flip, because it is not remounted
      // (icon-only while collapsed, so it has no name to look up: take the first nav link)
      const link = screen.getAllByRole('link')[0];
      link.focus();
      expect(link).toHaveFocus();
      setNarrow(true);
      expect(link).toHaveFocus();
    } finally {
      window.matchMedia = original;
    }
  });

  it('names the primary navigation landmark, so it is told apart from the breadcrumb', () => {
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBe(screen.getByTestId('app-rail'));
  });

  it('moves focus into the drawer when it opens and back to the header button when it closes', async () => {
    renderShell();
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    await userEvent.click(opener);
    expect(screen.getByTestId('app-rail')).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement?.tagName).toBe('A');
    await userEvent.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });

  it('holds the page behind the open drawer inert, and releases it on close', async () => {
    renderShell();
    const page = screen.getByRole('navigation', { name: 'Breadcrumb' }).closest('[class*="flex-col"]') as HTMLElement;
    expect(page).not.toHaveAttribute('inert');
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(page).toHaveAttribute('inert');
    await userEvent.keyboard('{Escape}');
    expect(page).not.toHaveAttribute('inert');
  });

  it('puts the drawer away when the window is widened past md', async () => {
    let onChange: ((event: MediaQueryListEvent) => void) | undefined;
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, handler: (event: MediaQueryListEvent) => void) => {
        onChange = handler;
      },
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      renderShell();
      await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
      expect(screen.getByTestId('app-rail')).toHaveAttribute('data-open', 'true');
      act(() => onChange?.({ matches: true } as MediaQueryListEvent));
      expect(screen.getByTestId('app-rail')).toHaveAttribute('data-open', 'false');
      // the menu button is hidden at md and up, so focus goes to the page rather than to <body>
      expect(screen.getByRole('main')).toHaveFocus();
    } finally {
      window.matchMedia = original;
    }
  });

  it('says the connection status in words, and names the account button as a menu', async () => {
    renderShell();
    expect(await screen.findByRole('button', { name: 'System status: All systems OK' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu, Jane' })).toBeInTheDocument();
  });

  it('keeps the status in words for screen readers on the collapsed rail', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(await screen.findByText('All systems OK')).toHaveClass('sr-only');
    expect(screen.getByRole('button', { name: 'System status: All systems OK' })).toBeInTheDocument();
  });
});

describe('AppShell route enter', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });
  });

  it('fades the page in after a route change, but not on the first load (DESIGN.md section 8)', async () => {
    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <AppShell>
          <Link to="/help">go to help</Link>
        </AppShell>
      </MemoryRouter>,
    );

    const main = screen.getByRole('main');
    expect(main.className).not.toContain('fadeIn');

    await userEvent.click(screen.getByRole('link', { name: 'go to help' }));
    expect(main.className).toContain('fadeIn');
  });
});

describe('AppShell rail layout', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiPreferencesStore.setState({ railCollapsed: false });
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    vi.spyOn(adoApi, 'getAdoStatus').mockResolvedValue({ status: 'valid' });
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(llmApi, 'getLlmStatus').mockResolvedValue({ status: 'reachable', latencyMs: 42 });
  });

  function renderRail() {
    return render(
      <MemoryRouter initialEntries={['/jobs']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );
  }

  it('keeps every label in the page when the rail is collapsed, hidden by fading, so the links keep their names', async () => {
    renderRail();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));

    expect(screen.getByText('Knowledge base')).toHaveClass('opacity-0');
    expect(screen.getByRole('link', { name: 'Knowledge base' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Expand navigation' }));
    expect(screen.getByText('Knowledge base')).not.toHaveClass('opacity-0');
  });

  it('keeps the icons on one vertical line whether the rail is open or closed', async () => {
    renderRail();
    const nav = within(screen.getByTestId('app-rail')).getByRole('list');
    const before = within(nav).getAllByRole('link').map((link) => link.className);
    await userEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    const after = within(nav).getAllByRole('link').map((link) => link.className);

    // class pin: jsdom has no layout. Nothing that positions the icon may depend on the collapsed state.
    const positioning = (className: string) => className.split(/\s+/).filter((token) => /^(h-10|pl-4|pr-3|gap-3)$/.test(token));
    expect(after.map(positioning)).toEqual(before.map(positioning));
    expect(positioning(before[0])).toEqual(expect.arrayContaining(['h-10', 'pl-4', 'gap-3']));
  });

  it('animates its width with the slow token, not a raw duration', () => {
    renderRail();

    const className = screen.getByTestId('app-rail').className;
    expect(className).toContain('duration-slow');
    expect(className).not.toContain('duration-300');
  });

  it('opens with the product name in a brand row, and fades the name when collapsed', async () => {
    renderRail();
    const rail = screen.getByTestId('app-rail');

    expect(within(rail).getByText('req2ado')).not.toHaveClass('opacity-0');
    expect(within(rail).getByText('R2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(within(rail).getByText('req2ado')).toHaveClass('opacity-0');
  });

  it('puts the collapse toggle at the bottom, and says whether the rail is open', async () => {
    renderRail();
    const toggle = screen.getByRole('button', { name: 'Collapse navigation' });

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const status = screen.getByRole('button', { name: /^system status:/i });
    expect(status.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('remembers the choice across a reload', async () => {
    const first = renderRail();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    first.unmount();

    renderRail();

    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
    expect(screen.getByText('Knowledge base')).toHaveClass('opacity-0');
  });
});
