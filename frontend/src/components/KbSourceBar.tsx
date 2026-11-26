import { redactSharingUrl } from '../utils/redactSharingUrl';
import { useEffect, useId, useState } from 'react';
import { CircleAlert, CircleCheck, FolderOpen, FolderSearch, KeyRound, Pencil, RefreshCw, TriangleAlert, Unplug, X, type LucideIcon } from 'lucide-react';
import type { SharePointStatus } from '../api/kb';
import { cn } from '../lib/cn';
import { formatRelativeTime } from '../utils/relativeTime';
import { formatSharePointExpiry } from '../utils/sharePointStatus';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { Skeleton } from '../ui/Skeleton';
import { Spinner } from '../ui/Spinner';
import { TextField } from '../ui/TextField';
import { Tooltip } from '../ui/Tooltip';

// The knowledge base's source: the SharePoint/OneDrive folder it is browsed from, and whether the
// token that reads it still works. One bar replaces the old status strip plus "Sharing URL" card.
// With a source saved it is a compact bar (source, status, Refresh / Change / Reconnect); with none,
// or under Change, it is the form that sets one.

const STATUS_COPY: Record<SharePointStatus['status'], { label: string; chipClassName: string; Icon: LucideIcon; iconClassName: string }> = {
  valid: { label: 'Connected', chipClassName: 'bg-ok-soft text-ok-ink border-ok-border', Icon: CircleCheck, iconClassName: 'text-ok-ink' },
  invalid: { label: 'Token invalid', chipClassName: 'bg-danger-soft text-danger-ink border-danger-border', Icon: CircleAlert, iconClassName: 'text-danger-ink' },
  unreachable: {
    label: "Can't reach Microsoft Graph",
    chipClassName: 'bg-warning-soft text-warning-ink border-warning-border',
    Icon: TriangleAlert,
    iconClassName: 'text-warning-ink',
  },
  not_configured: { label: 'Not connected', chipClassName: 'bg-surface-alt text-ink-3 border-hairline-strong', Icon: Unplug, iconClassName: 'text-ink-3' },
};

interface KbSourceBarProps {
  // The folder URL being shown (last successful browse, or restored on load); null when none is saved.
  sourceUrl: string | null;
  // What is typed in the URL field.
  draftUrl: string;
  onDraftUrlChange: (url: string) => void;
  // null while the first check is still running.
  status: SharePointStatus | null;
  browsing: boolean;
  // False until the signed-in user is known.
  canBrowse: boolean;
  lastBrowsedAt: number | null;
  // Browse the typed URL.
  onBrowse: () => void;
  // Browse the saved source again.
  onRefresh: () => void;
  onReconnect: () => void;
}

function StatusLine({
  status,
  reconnect,
}: {
  status: SharePointStatus | null;
  // The Reconnect button, when the form shows it beside the status.
  reconnect?: React.ReactNode;
}): React.ReactElement {
  if (!status) return <Skeleton className="h-5 w-40" />;
  const copy = STATUS_COPY[status.status];
  const expiry = formatSharePointExpiry(status.expiresInSeconds);
  return (
    <div data-status={status.status} className="flex flex-wrap items-center gap-2">
      <copy.Icon className={cn('h-4 w-4 flex-none', copy.iconClassName)} aria-hidden="true" />
      <Chip className={cn('border text-xs font-normal', copy.chipClassName)}>SharePoint</Chip>
      <span className="text-sm text-ink-2">
        {copy.label}
        {expiry && <span className="text-ink-3"> · {expiry}</span>}
      </span>
      {reconnect}
    </div>
  );
}

export function KbSourceBar({
  sourceUrl,
  draftUrl,
  onDraftUrlChange,
  status,
  browsing,
  canBrowse,
  lastBrowsedAt,
  onBrowse,
  onRefresh,
  onReconnect,
}: KbSourceBarProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const urlFieldId = useId();
  // A browse of a new URL that succeeds makes it the source: the form has done its job.
  useEffect(() => {
    setEditing(false);
  }, [sourceUrl]);

  // A token that is invalid or missing cannot read anything, so browsing would only fail. An unreachable Graph may be
  // transient, so it does not block.
  const blocked = status?.status === 'invalid' || status?.status === 'not_configured';
  const notConnected = status?.status === 'not_configured';
  const reconnectFirst =
    blocked && (
      <p className="text-xs text-warning-ink">
        {notConnected ? 'Connect SharePoint first, with your own token.' : 'Reconnect SharePoint first: your saved token cannot read this folder.'}
      </p>
    );
  // Tiers, not equal buttons: whichever action the user needs next is the one emphasised. While the token is healthy
  // nothing is (Reconnect recedes); when it needs attention Reconnect is, because nothing else will work until it is done.
  const reconnectButton = (
    <Button size="sm" variant={blocked ? 'primary' : 'ghost'} onClick={onReconnect}>
      <KeyRound className="h-4 w-4" aria-hidden="true" />
      {notConnected ? 'Connect' : 'Reconnect'}
    </Button>
  );

  if (!sourceUrl || editing) {
    return (
      <Card>
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 className="text-sm font-semibold text-ink-1">{editing ? 'Change source' : 'Connect a SharePoint folder'}</h2>
            <StatusLine status={status} reconnect={reconnectButton} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlFieldId} className="text-meta font-semibold tracking-normal text-ink-2">
              Sharing URL
            </label>
            {/* Only the input and its buttons share this row, so they stretch to one height and one baseline; the helper text sits
                below it. (Helper text inside the field block made `items-end` align the buttons to the text instead of the input.) */}
            <div className="flex items-stretch gap-2">
              <TextField id={urlFieldId} value={draftUrl} onChange={(event) => onDraftUrlChange(event.target.value)} fullWidth />
              <Button onClick={onBrowse} disabled={!draftUrl || !canBrowse || browsing || blocked}>
                {browsing ? <Spinner /> : <FolderSearch className="h-4 w-4" aria-hidden="true" />}
                {browsing ? 'Browsing…' : 'Browse'}
              </Button>
              {editing && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    onDraftUrlChange(sourceUrl ?? '');
                    setEditing(false);
                  }}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                  Cancel
                </Button>
              )}
            </div>
            <p className="text-xs text-ink-3">Paste a SharePoint or OneDrive folder's 'Share' link. Every file and subfolder inside becomes browsable below.</p>
          </div>
          {reconnectFirst}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusLine status={status} />
          <span className="flex min-w-0 flex-1 basis-48 items-center gap-1.5">
            <FolderOpen className="h-4 w-4 flex-none text-ink-3" aria-hidden="true" />
            {/* The link is the credential for the folder: only a redacted form is drawn, here and in the tooltip. Change edits the full one. */}
            <Tooltip content={redactSharingUrl(sourceUrl)}>
              <span className="min-w-0 truncate font-mono text-xs text-ink-2">{redactSharingUrl(sourceUrl)}</span>
            </Tooltip>
          </span>
          {lastBrowsedAt !== null && (
            <span className="text-xs text-ink-3">Browsed {formatRelativeTime(new Date(lastBrowsedAt).toISOString())}</span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={!canBrowse || browsing || blocked}>
              {browsing ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Refresh
            </Button>
            <span className="mx-1 h-5 w-px bg-hairline-strong" aria-hidden="true" />
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Change
            </Button>
            {reconnectButton}
          </div>
        </div>
        {reconnectFirst}
      </div>
    </Card>
  );
}
