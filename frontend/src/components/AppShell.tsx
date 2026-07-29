import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Briefcase, Plus, HelpCircle, Database, Menu, LogOut, UserCog } from 'lucide-react';
import { cn } from '../lib/cn';
import { useDisplayName, useAuthStore } from '../store/authStore';
import { logoutSession } from '../api/auth';
import { getAdoStatus, type AdoStatus } from '../api/ado';
import { getSharePointStatus, type SharePointStatus } from '../api/kb';
import { formatSharePointExpiry } from '../utils/sharePointStatus';
import { Tooltip } from '../ui/Tooltip';
import { DropdownMenu, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from '../ui/DropdownMenu';

const DOT_TONE: Record<string, string> = {
  ok: 'bg-ok',
  warn: 'bg-warning',
  bad: 'bg-danger',
  dim: 'bg-white/25',
};

function adoDotTone(status: AdoStatus['status'] | undefined): string {
  if (status === 'valid') return DOT_TONE.ok;
  if (status === 'not_configured') return DOT_TONE.dim;
  return DOT_TONE.bad;
}

function adoDetail(status: AdoStatus['status'] | undefined): string {
  if (!status) return 'Checking…';
  if (status === 'valid') return 'Connected';
  if (status === 'not_configured') return 'Not configured';
  return "Can't reach Azure DevOps";
}

function sharePointDotTone(status: SharePointStatus['status'] | undefined): string {
  if (status === 'valid') return DOT_TONE.ok;
  if (status === 'invalid' || status === 'unreachable') return DOT_TONE.warn;
  return DOT_TONE.dim;
}

function sharePointDetail(status: SharePointStatus | null): string {
  if (!status) return 'Checking…';
  const expiry = formatSharePointExpiry(status.expiresInSeconds);
  if (status.status === 'valid') return expiry ? `Connected, ${expiry}` : 'Connected';
  if (status.status === 'invalid') return 'Token invalid';
  if (status.status === 'unreachable') return "Can't reach Microsoft Graph";
  return 'Not configured';
}

const RAIL_EXPANDED_WIDTH = 220;
const RAIL_COLLAPSED_WIDTH = 64;

const NAV_ITEMS = [
  { to: '/jobs', label: 'Jobs', icon: Briefcase },
  { to: '/jobs/new', label: 'New Job', icon: Plus },
  { to: '/knowledge-base', label: 'Knowledge Base', icon: Database },
  { to: '/help', label: 'Help', icon: HelpCircle },
];

// Route title registry — the real fix for AppBar printing the raw
// pathname. Matched longest-prefix-first so /jobs/:id falls through to the
// generic "Job" title without needing a param-aware router integration.
const ROUTE_TITLES: { prefix: string; title: string }[] = [
  { prefix: '/jobs/new', title: 'New Job' },
  { prefix: '/jobs/', title: 'Job' },
  { prefix: '/jobs', title: 'Jobs' },
  { prefix: '/knowledge-base', title: 'Knowledge Base' },
  { prefix: '/help', title: 'Help' },
  { prefix: '/settings', title: 'Profile & Connections' },
];

function titleForPath(pathname: string): string {
  const match = ROUTE_TITLES.find((route) => pathname.startsWith(route.prefix));
  return match?.title ?? pathname;
}

export function AppShell({ children }: { children: ReactNode }): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const displayName = useDisplayName();
  const width = collapsed ? RAIL_COLLAPSED_WIDTH : RAIL_EXPANDED_WIDTH;
  const [adoStatus, setAdoStatus] = useState<AdoStatus | null>(null);
  const [sharePointStatus, setSharePointStatus] = useState<SharePointStatus | null>(null);

  useEffect(() => {
    getAdoStatus()
      .then(setAdoStatus)
      .catch(() => setAdoStatus({ status: 'unreachable' }));
    getSharePointStatus()
      .then(setSharePointStatus)
      .catch(() => setSharePointStatus({ status: 'unreachable', expiresInSeconds: null }));
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
      <nav
        style={{ width }}
        className="flex flex-none flex-col gap-4 bg-navy-900 py-3 text-white transition-[width] duration-300 ease-in-out"
      >
        <Tooltip content={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className="m-1 grid h-8 w-8 place-items-center rounded-sm text-white hover:bg-white/10"
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
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm text-[#C6D0E8] transition-colors hover:bg-white/[0.07] hover:text-white',
                  isActive && 'bg-white/10 font-semibold text-white',
                )}
              >
                <Icon className="h-4 w-4 flex-none" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
            return <li key={item.to}>{collapsed ? <Tooltip content={item.label}>{link}</Tooltip> : link}</li>;
          })}
        </ul>

        <div className="mt-auto flex flex-col gap-1.5 px-2">
          <Tooltip content={`Azure DevOps — ${adoDetail(adoStatus?.status)}`}>
            <div className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-[#C6D0E8]">
              <span className={cn('h-1.5 w-1.5 flex-none rounded-full', adoDotTone(adoStatus?.status))} />
              {!collapsed && <span className="truncate">Azure DevOps</span>}
            </div>
          </Tooltip>
          <Tooltip content={`SharePoint — ${sharePointDetail(sharePointStatus)}`}>
            <div className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-[#C6D0E8]">
              <span className={cn('h-1.5 w-1.5 flex-none rounded-full', sharePointDotTone(sharePointStatus?.status))} />
              {!collapsed && <span className="truncate">SharePoint</span>}
            </div>
          </Tooltip>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] flex-none items-center gap-3 border-b border-hairline-strong bg-surface px-4.5">
          <span className="truncate text-sm font-semibold">{titleForPath(location.pathname)}</span>
          <div className="ml-auto flex items-center gap-2">
            <DropdownMenu
              trigger={
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-sm border border-hairline-strong bg-surface px-2.5 py-1.5 text-sm hover:bg-canvas"
                >
                  <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-navy-300 text-[11.5px] font-bold text-white">
                    {displayName?.[0] ?? '?'}
                  </span>
                  <span>{displayName ?? ''}</span>
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
        <main className="flex-1 overflow-y-auto p-5">{children}</main>
      </div>
    </div>
  );
}
