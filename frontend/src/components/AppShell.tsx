import { AT_LEAST_MD, BELOW_MD, useMediaQuery } from '../hooks/useMediaQuery';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Briefcase, Plus, HelpCircle, Database, Menu, LogOut, UserCog } from 'lucide-react';
import { cn } from '../lib/cn';
import { useDisplayName, useAuthStore } from '../store/authStore';
import { usePageLabelStore } from '../store/pageLabelStore';
import { logoutSession } from '../api/auth';
import { getAdoStatus, type AdoStatus } from '../api/ado';
import { getSharePointStatus, type SharePointStatus } from '../api/kb';
import { getLlmStatus, type LlmStatus } from '../api/llm';
import { formatSharePointExpiry } from '../utils/sharePointStatus';
import { Tooltip } from '../ui/Tooltip';
import { ARRIVE, useReplayOnChange } from '../ui/motion';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from '../ui/DropdownMenu';

const DOT_TONE: Record<string, string> = {
  ok: 'bg-ok',
  warn: 'bg-warning',
  bad: 'bg-danger',
  dim: 'bg-white/25',
};

// `live` (cyan) is reserved for "genuinely in flight right now" (DESIGN.md
// §3: never a terminal/static state) -- the connectivity check itself,
// while its result is still unknown. Confirmed real bug this fixes: the
// dot previously fell through adoDotTone's `undefined` case straight to
// the danger/red branch for the entire loading window, before the check
// had even resolved -- a false failure signal, not "checking".
function connectionDotState(status: string | undefined, isBad: (status: string) => boolean, isDim: (status: string) => boolean): { tone: string; live: boolean } {
  if (!status) return { tone: DOT_TONE.dim, live: true };
  if (isDim(status)) return { tone: DOT_TONE.dim, live: false };
  if (isBad(status)) return { tone: DOT_TONE.bad, live: false };
  return { tone: DOT_TONE.ok, live: false };
}

function adoConnectionState(status: AdoStatus['status'] | undefined): { tone: string; live: boolean } {
  return connectionDotState(
    status,
    (s) => s !== 'valid' && s !== 'not_configured',
    (s) => s === 'not_configured',
  );
}

function adoDetail(status: AdoStatus['status'] | undefined): string {
  if (!status) return 'Checking…';
  if (status === 'valid') return 'Connected';
  if (status === 'not_configured') return 'Not configured';
  return "Can't reach Azure DevOps";
}

function sharePointConnectionState(status: SharePointStatus['status'] | undefined): { tone: string; live: boolean } {
  if (!status) return { tone: DOT_TONE.dim, live: true };
  if (status === 'valid') return { tone: DOT_TONE.ok, live: false };
  if (status === 'invalid' || status === 'unreachable') return { tone: DOT_TONE.warn, live: false };
  return { tone: DOT_TONE.dim, live: false };
}

function sharePointDetail(status: SharePointStatus | null): string {
  if (!status) return 'Checking…';
  const expiry = formatSharePointExpiry(status.expiresInSeconds);
  if (status.status === 'valid') return expiry ? `Connected, ${expiry}` : 'Connected';
  if (status.status === 'invalid') return 'Token invalid';
  if (status.status === 'unreachable') return "Can't reach Microsoft Graph";
  return 'Not configured';
}

function llmConnectionState(status: LlmStatus['status'] | undefined): { tone: string; live: boolean } {
  return connectionDotState(status, (s) => s === 'unreachable', (s) => s === 'not_configured');
}

function llmDetail(status: LlmStatus | null): string {
  if (!status) return 'Checking…';
  if (status.status === 'reachable') return `Connected, ${status.latencyMs}ms`;
  if (status.status === 'not_configured') return 'Not configured';
  return "Can't reach the LLM backend";
}

const RAIL_EXPANDED_WIDTH = 220;
const RAIL_COLLAPSED_WIDTH = 64;

const NAV_ITEMS = [
  { to: '/jobs', label: 'Jobs', icon: Briefcase },
  { to: '/jobs/new', label: 'New Job', icon: Plus },
  { to: '/knowledge-base', label: 'Knowledge Base', icon: Database },
  { to: '/help', label: 'Help', icon: HelpCircle },
];

interface Crumb {
  label: string;
  to?: string;
  // Job ids are real identifiers (DESIGN.md §2.2's mono-identifier rule),
  // not prose -- rendered font-mono, truncated with a Tooltip carrying the
  // full value since the header bar is only 52px tall.
  mono?: boolean;
}

// Route breadcrumb registry — the real fix for the header printing a bare
// page title with a second, duplicate breadcrumb re-declared in the page
// body (JobDetail used to do exactly this). Matched longest-prefix-first so
// /jobs/:id falls through to its own crumbs() without needing a param-aware
// router integration (App.tsx nests plain <Routes> inside AppShell, so
// there is no route `handle`/`useMatches` to read a param from here).
type CrumbLabels = Record<string, string>;
const ROUTE_CRUMBS: { prefix: string; crumbs: (pathname: string, jobLabels: CrumbLabels) => Crumb[] }[] = [
  { prefix: '/jobs/new', crumbs: () => [{ label: 'New Job' }] },
  // Both NEW-05 batch routes must sit ABOVE the generic '/jobs/' catch-all
  // below -- that entry matches any '/jobs/...' path via startsWith, and
  // without these more-specific entries first, a batch path would render
  // its own second path segment ("batch/new" or "batch/<id>") as if it
  // were a job id.
  { prefix: '/jobs/batch/new', crumbs: () => [{ label: 'New Batch' }] },
  {
    prefix: '/jobs/batch/',
    crumbs: (pathname) => [{ label: 'Jobs', to: '/jobs' }, { label: pathname.slice('/jobs/batch/'.length), mono: true }],
  },
  {
    prefix: '/jobs/',
    crumbs: (pathname, jobLabels) => {
      const jobId = pathname.slice('/jobs/'.length);
      // The job's file name once the page has loaded it; the (shortened) id until then.
      const name = jobLabels[jobId];
      return [{ label: 'Jobs', to: '/jobs' }, name ? { label: name } : { label: jobId, mono: true }];
    },
  },
  { prefix: '/jobs', crumbs: () => [{ label: 'Jobs' }] },
  { prefix: '/knowledge-base', crumbs: () => [{ label: 'Knowledge Base' }] },
  { prefix: '/help', crumbs: () => [{ label: 'Help' }] },
  { prefix: '/settings', crumbs: () => [{ label: 'Profile & Connections' }] },
];

function crumbsForPath(pathname: string, jobLabels: CrumbLabels): Crumb[] {
  const match = ROUTE_CRUMBS.find((route) => pathname.startsWith(route.prefix));
  // An unknown address is named, not echoed back as a raw path.
  return match ? match.crumbs(pathname, jobLabels) : [{ label: 'Page not found' }];
}

function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

// A resolved connection state is a static dot -- `live` only pulses (the
// same ping+solid-dot pattern ProgressBanner's "Running" chip uses) while a
// status check is genuinely still in flight, never once it's known.
function ConnectionDot({ tone, live }: { tone: string; live: boolean }): React.ReactElement {
  if (!live) return <span className={cn('h-1.5 w-1.5 flex-none rounded-full', tone)} />;
  return (
    <span className="relative flex h-1.5 w-1.5 flex-none">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-live/70" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-live" />
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  // Below md the rail is an off-canvas drawer, closed until the header button opens it; at md and up this flag has no visual effect.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const displayName = useDisplayName();
  const jobLabels = usePageLabelStore((state) => state.jobLabels);
  // The collapsed (icon-only) rail is a desktop state: below md the rail is the drawer and always shows full labels. This is derived from the
  // breakpoint, not written back, so the desktop rail keeps the collapse choice made before the window was narrowed, and the drawer never
  // shrinks while it slides out.
  const narrowViewport = useMediaQuery(BELOW_MD);
  const railCollapsed = collapsed && !narrowViewport;
  const width = railCollapsed ? RAIL_COLLAPSED_WIDTH : RAIL_EXPANDED_WIDTH;
  const railRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  // Opacity only, on the one element that persists across routes (DESIGN.md section 8, Entrance).
  useReplayOnChange(mainRef, location.pathname, ARRIVE.fade);
  // Set when the drawer closes because a link was followed: focus then belongs to the new page, not to the menu button.
  const closedByNavigation = useRef(false);
  const [adoStatus, setAdoStatus] = useState<AdoStatus | null>(null);
  const [sharePointStatus, setSharePointStatus] = useState<SharePointStatus | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);

  // Following a link, or pressing Escape, puts the drawer away; it never stays over the page that was just opened.
  useEffect(() => {
    if (drawerWasOpen.current) closedByNavigation.current = true;
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setDrawerOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  // Widening past md makes the drawer a plain rail again; an open flag left over would hold the page behind it inert.
  useEffect(() => {
    const query = window.matchMedia(AT_LEAST_MD);
    function onChange(event: MediaQueryListEvent): void {
      if (event.matches) {
        // the menu button is hidden at md and up, so focus cannot go back to it
        closedByNavigation.current = true;
        setDrawerOpen(false);
      }
    }
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Focus goes into the drawer when it opens and back to the header button when it closes, so a keyboard user is never left on a hidden element.
  useEffect(() => {
    if (drawerOpen) {
      // a flag set by a link followed while the drawer was closed (desktop) must not steer the next close
      closedByNavigation.current = false;
      railRef.current?.querySelector<HTMLElement>('a')?.focus();
    } else if (drawerWasOpen.current) {
      (closedByNavigation.current ? mainRef.current : menuButtonRef.current)?.focus();
      closedByNavigation.current = false;
    }
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);

  useEffect(() => {
    getAdoStatus()
      .then(setAdoStatus)
      .catch(() => setAdoStatus({ status: 'unreachable' }));
    getSharePointStatus()
      .then(setSharePointStatus)
      .catch(() => setSharePointStatus({ status: 'unreachable', expiresInSeconds: null }));
    getLlmStatus()
      .then(setLlmStatus)
      .catch(() => setLlmStatus({ status: 'unreachable', latencyMs: null }));
  }, []);

  // Revokes the real server session FIRST (a DELETE against the Session
  // table -- clearing only local state would leave that session's cookie
  // valid server-side until its 7-day TTL). Local state and navigation
  // still happen even if the revoke call fails (e.g. already expired) --
  // signing out must never get the user stuck.
  async function handleSignOut(): Promise<void> {
    try {
      await logoutSession();
    } catch {
      // Best-effort: an already-invalid/expired session 401s here, which is
      // fine -- there's nothing left to revoke.
    }
    useAuthStore.getState().logout();
    navigate('/login');
  }

  return (
    // h-screen + overflow-hidden (not min-h-screen) -- with min-h-screen,
    // a long page (e.g. JobsList's unpaginated job table) grows the whole
    // flex row past one viewport height, so `nav` (a stretched flex
    // sibling) grows right along with it and the whole page scrolls at
    // the body level instead of just `main`. That pushed the rail
    // footer's connection-status LEDs thousands of pixels below the
    // viewport -- confirmed live: nav.getBoundingClientRect().height was
    // 3189px against a 900px viewport, footer at y=3123. Bounding this
    // container to exactly one viewport height makes `main`'s own
    // overflow-y-auto the only scroll region, so `nav` (and its footer)
    // stays pinned regardless of page content length.
    <div className="flex h-screen overflow-hidden">
      {drawerOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-scrim md:hidden"
        />
      )}
      <nav
        ref={railRef}
        data-testid="app-rail"
        aria-label="Main"
        data-open={drawerOpen ? 'true' : 'false'}
        style={{ width }}
        className={cn(
          'flex flex-none flex-col gap-4 bg-rail-900 py-3 text-white transition-[width] duration-300 ease-in-out',
          // Below md: leaves the page flow and slides in over it. `invisible` while closed keeps its links out of the tab order.
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40',
          // Opening must not animate `visibility`: focus() on a still-hidden element is a no-op and focus would fall to <body>. Closing
          // does animate it, so the slide-out stays visible until it ends.
          drawerOpen ? 'max-md:transition-[transform]' : 'max-md:invisible max-md:-translate-x-full max-md:transition-[transform,visibility]',
        )}
      >
        <Tooltip content={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className="m-1 grid h-8 w-8 place-items-center rounded-sm text-white transition-colors duration-instant hover:bg-rail-active max-md:hidden"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
        <ul className="flex flex-col gap-0.5 px-2">
          {NAV_ITEMS.map((item) => {
            const isActive = location.pathname === item.to || (item.to !== '/jobs' && location.pathname.startsWith(item.to));
            const Icon = item.icon;
            const link = (
              <Link
                to={item.to}
                // following the link to the page already open changes no pathname, so the close cannot wait for the pathname effect
                onClick={() => {
                  closedByNavigation.current = true;
                  setDrawerOpen(false);
                }}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-2.5 rounded-sm px-2.5 py-2 max-md:py-3 text-sm text-ink-on-dark-dim transition-colors duration-instant hover:bg-rail-hover hover:text-white',
                  isActive && 'bg-rail-active font-semibold text-white',
                )}
              >
                {/* Active-item anchoring (DESIGN.md Track B, phase B8) --
                    the fill alone read as too subtle against the already-
                    dark rail; a left indicator bar in the rail's own
                    reserved accent (§15.8: rail-* stays inside AppShell)
                    makes "this is where you are" unambiguous at a glance. */}
                {isActive && <span className="absolute inset-y-0 left-0 w-[3px] rounded-r-sm bg-rail-indicator" />}
                <Icon className="h-4 w-4 flex-none" />
                {!railCollapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
            // always wrapped, so the link is not remounted (and does not lose focus) when the rail collapses or expands; the tooltip only opens
            // while the labels are hidden
            return (
              <li key={item.to}>
                <Tooltip content={item.label} disabled={!railCollapsed}>
                  {link}
                </Tooltip>
              </li>
            );
          })}
        </ul>

        <div role="group" aria-label="Connections" className="mt-auto flex flex-col gap-1 px-2">
          {!railCollapsed && <span className="px-1 pb-0.5 text-meta font-semibold tracking-normal text-ink-on-dark-dim">Connections</span>}
          <Tooltip content={`Azure DevOps — ${adoDetail(adoStatus?.status)}`}>
            <div className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-ink-on-dark-dim">
              <ConnectionDot {...adoConnectionState(adoStatus?.status)} />
              <span className={railCollapsed ? 'sr-only' : 'truncate'}>Azure DevOps</span>
              <span className="sr-only max-md:not-sr-only max-md:ml-auto max-md:truncate max-md:text-micro">{adoDetail(adoStatus?.status)}</span>
            </div>
          </Tooltip>
          <Tooltip content={`SharePoint — ${sharePointDetail(sharePointStatus)}`}>
            <div className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-ink-on-dark-dim">
              <ConnectionDot {...sharePointConnectionState(sharePointStatus?.status)} />
              <span className={railCollapsed ? 'sr-only' : 'truncate'}>SharePoint</span>
              <span className="sr-only max-md:not-sr-only max-md:ml-auto max-md:truncate max-md:text-micro">{sharePointDetail(sharePointStatus)}</span>
            </div>
          </Tooltip>
          <Tooltip content={`LLM Backend — ${llmDetail(llmStatus)}`}>
            <div className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-ink-on-dark-dim">
              <ConnectionDot {...llmConnectionState(llmStatus?.status)} />
              <span className={railCollapsed ? 'sr-only' : 'truncate'}>LLM Backend</span>
              <span className="sr-only max-md:not-sr-only max-md:ml-auto max-md:truncate max-md:text-micro">{llmDetail(llmStatus)}</span>
            </div>
          </Tooltip>
        </div>
      </nav>

      <div inert={drawerOpen} className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] flex-none items-center gap-3 border-b border-hairline-strong bg-surface px-3 md:px-4.5">
          <button
            type="button"
            ref={menuButtonRef}
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="grid h-11 w-11 flex-none place-items-center rounded-sm text-ink-2 hover:bg-canvas md:hidden"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 truncate text-sm">
            {crumbsForPath(location.pathname, jobLabels).map((crumb, index, all) => {
              const isLast = index === all.length - 1;
              const label = crumb.mono ? (
                <Tooltip content={crumb.label}>
                  <span className="font-mono">{truncateId(crumb.label)}</span>
                </Tooltip>
              ) : (
                crumb.label
              );
              return (
                <span key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
                  {index > 0 && (
                    <span className="text-ink-3" aria-hidden="true">
                      /
                    </span>
                  )}
                  {crumb.to ? (
                    <Link to={crumb.to} className="font-medium text-ink-3 transition-colors duration-instant hover:text-ink-1 hover:underline">
                      {label}
                    </Link>
                  ) : (
                    <span className="font-semibold text-ink-1" aria-current={isLast ? 'page' : undefined}>
                      {label}
                    </span>
                  )}
                </span>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <DropdownMenu
              trigger={
                <button
                  type="button"
                  aria-label={displayName ? `Account menu, ${displayName}` : undefined}
                  className="flex items-center gap-2 rounded-sm border border-hairline-strong bg-surface px-2.5 py-1.5 text-sm hover:bg-canvas max-md:min-h-11 max-md:min-w-11 max-md:justify-center"
                >
                  <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-accent text-meta font-bold text-white">
                    {displayName?.[0] ?? '?'}
                  </span>
                  <span className="max-md:hidden">{displayName ?? ''}</span>
                </button>
              }
            >
              <DropdownMenuLabel>
                <span className="block text-sm font-semibold">{displayName ?? ''}</span>
              </DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => navigate('/settings')}>
                  <UserCog className="h-3.5 w-3.5 flex-none" />
                  Profile & connections
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={handleSignOut} danger>
                  <LogOut className="h-3.5 w-3.5 flex-none" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenu>
          </div>
        </header>
        <main ref={mainRef} tabIndex={-1} className="flex-1 overflow-y-auto p-3 focus:outline-none md:p-5">{children}</main>
      </div>
    </div>
  );
}
