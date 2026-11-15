import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { Tooltip } from '../ui/Tooltip';

// One link in the navigation rail. The icon sits on one vertical line whether the rail is open or closed (the padding that places it
// never depends on the collapsed state), and the label stays in the page when the rail closes: it fades out instead of being removed, so
// the link keeps its name and nothing jumps. rail-* colours are only for the rail (DESIGN.md §15.8), which is why this lives next to it.

export function RailNavItem({
  to,
  label,
  icon: Icon,
  active,
  collapsed,
  onFollow,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed: boolean;
  onFollow: () => void;
}): React.ReactElement {
  const link = (
    <Link
      to={to}
      onClick={onFollow}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-10 items-center gap-3 rounded-sm pl-4 pr-3 text-sm text-ink-on-dark-dim transition-colors duration-instant hover:bg-rail-hover hover:text-white max-md:h-11',
        active && 'bg-rail-active font-semibold text-white',
      )}
    >
      {/* Active-item anchoring (DESIGN.md Track B, phase B8): a left indicator bar in the rail's own reserved accent, because the fill
          alone read as too subtle against the dark rail. */}
      {active && <span className="absolute inset-y-0 left-0 w-[3px] rounded-r-sm bg-rail-indicator" />}
      <Icon className="h-4 w-4 flex-none" aria-hidden="true" />
      <span className={cn('min-w-0 truncate whitespace-nowrap transition-opacity duration-fast', collapsed && 'opacity-0')}>{label}</span>
    </Link>
  );
  // Always wrapped, so the link is not remounted (and does not lose focus) when the rail collapses or opens; the tooltip only opens while
  // the labels are hidden.
  return (
    <li>
      <Tooltip content={label} disabled={!collapsed}>
        {link}
      </Tooltip>
    </li>
  );
}
