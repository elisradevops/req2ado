import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Popover } from 'radix-ui';
import { CircleCheck, CircleX, Minus, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useConnectionStatusStore } from '../store/connectionStatusStore';
import { connectionRows, summarizeConnections, type ConnectionRow, type HealthState } from '../utils/connectionHealth';
import { cn } from '../lib/cn';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Tooltip } from '../ui/Tooltip';

// The one place the rail says whether Azure DevOps, SharePoint and the LLM backend are usable: "All systems OK", or how many need
// attention. The detail (each connection in words, when it was checked, where to fix it) is one click away in a popover, so the rail
// stays calm when all is well and loud only when something is not. Status is always said in words and an icon, never by colour alone.

const STATE_ICON: Record<Exclude<HealthState, 'checking'>, { Icon: LucideIcon; className: string; word: string | null }> = {
  ok: { Icon: CircleCheck, className: 'text-ok-ink', word: null },
  attention: { Icon: TriangleAlert, className: 'text-warning-ink', word: 'Needs attention' },
  danger: { Icon: CircleX, className: 'text-danger-ink', word: 'Action needed' },
  off: { Icon: Minus, className: 'text-ink-3', word: null },
};

const pad = (n: number): string => String(n).padStart(2, '0');

function checkedText(checkedAt: number | null): string | null {
  if (checkedAt === null) return null;
  const at = new Date(checkedAt);
  return `Checked ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function RowIcon({ state }: { state: HealthState }): React.ReactElement {
  if (state === 'checking') return <Spinner className="h-3.5 w-3.5 text-live" />;
  const { Icon, className } = STATE_ICON[state];
  return <Icon className={cn('h-4 w-4 flex-none', className)} aria-hidden="true" />;
}

function Row({ row }: { row: ConnectionRow }): React.ReactElement {
  const flag = row.state === 'checking' ? null : STATE_ICON[row.state].word;
  const checked = checkedText(row.checkedAt);
  return (
    <li className="flex items-start gap-2.5 px-3.5 py-2.5 text-sm">
      <span className="mt-0.5">
        <RowIcon state={row.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="font-medium text-ink-1">{row.label}</span>
          {flag && <span className="text-xs font-medium text-ink-2">{flag}</span>}
        </span>
        <span className="text-ink-2">{row.word}</span>
        {checked && <span className="text-xs text-ink-3">{checked}</span>}
      </span>
    </li>
  );
}

export function ConnectionStatusItem({ collapsed }: { collapsed: boolean }): React.ReactElement {
  const ado = useConnectionStatusStore((s) => s.ado);
  const sharePoint = useConnectionStatusStore((s) => s.sharePoint);
  const llm = useConnectionStatusStore((s) => s.llm);
  const refresh = useConnectionStatusStore((s) => s.refresh);
  const [open, setOpen] = useState(false);

  const rows = connectionRows({ ado, sharePoint, llm });
  const summary = summarizeConnections(rows);
  const checking = ado.inFlight || sharePoint.inFlight || llm.inFlight;
  const anyDanger = rows.some((row) => row.state === 'danger');
  const sharePointRow = rows.find((row) => row.kind === 'sharePoint');
  const sharePointNeedsFixing = sharePointRow?.state === 'attention' || sharePointRow?.state === 'danger';
  // Only a rejected token is fixed by a new one; an unreachable server is not.
  const adoTokenRejected = rows.find((row) => row.kind === 'ado')?.state === 'danger';

  const trigger = (
    <button
      type="button"
      aria-label={`System status: ${summary.label}`}
      className="relative flex h-10 w-full items-center gap-3 rounded-sm pl-4 pr-3 text-sm text-ink-on-dark-dim transition-colors duration-instant hover:bg-rail-hover hover:text-white max-md:h-11"
    >
      {summary.state === 'checking' ? (
        <Spinner className="h-4 w-4 flex-none text-live" />
      ) : summary.state === 'ok' ? (
        <CircleCheck className="h-4 w-4 flex-none text-ok" aria-hidden="true" />
      ) : anyDanger ? (
        <CircleX className="h-4 w-4 flex-none text-danger" aria-hidden="true" />
      ) : (
        <TriangleAlert className="h-4 w-4 flex-none text-warning" aria-hidden="true" />
      )}
      <span className={collapsed ? 'sr-only' : 'min-w-0 truncate'}>{summary.label}</span>
      {summary.attentionCount > 0 && (
        <span
          data-testid="connection-count"
          aria-hidden="true"
          // Collapsed, the rail has no room beside the icon: the count sits on the icon's corner, inside the rail, instead of hanging over its edge.
          className={cn(
            'grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs font-semibold tabular-nums text-white',
            collapsed ? 'absolute left-7 top-0.5' : 'ml-auto',
            anyDanger ? 'bg-danger' : 'bg-warning',
          )}
        >
          {summary.attentionCount}
        </span>
      )}
    </button>
  );

  return (
    <div className="px-2">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tooltip content={summary.label} disabled={!collapsed || open}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        </Tooltip>
        <Popover.Portal>
          <Popover.Content
            side="right"
            align="end"
            sideOffset={8}
            collisionPadding={8}
            aria-labelledby="connection-status-title"
            className="z-50 w-[340px] max-w-[calc(100vw-1rem)] rounded-md bg-surface shadow-popover focus:outline-none"
          >
            <h2 id="connection-status-title" className="border-b border-hairline px-3.5 py-2.5 text-sm font-semibold text-ink-1">
              Connections
            </h2>
            <ul className="divide-y divide-hairline">
              {rows.map((row) => (
                <Row key={row.kind} row={row} />
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline bg-canvas px-3.5 py-2.5">
              <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={checking}>
                {checking ? 'Checking…' : 'Check now'}
              </Button>
              <span className="ml-auto flex flex-col items-end text-xs">
                {sharePointNeedsFixing && (
                  <Link to="/knowledge-base" onClick={() => setOpen(false)} className="py-1.5 font-medium text-accent-ink hover:underline max-md:py-3">
                    Reconnect SharePoint
                  </Link>
                )}
                {adoTokenRejected && (
                  <Link to="/settings" onClick={() => setOpen(false)} className="py-1.5 font-medium text-accent-ink hover:underline max-md:py-3">
                    Reconnect Azure DevOps
                  </Link>
                )}
                <Link to="/settings" onClick={() => setOpen(false)} className="py-1.5 font-medium text-accent-ink hover:underline max-md:py-3">
                  Profile & connections
                </Link>
              </span>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
