import { useEffect, useState } from 'react';
import { httpClient } from '../api/httpClient';
import { getSharePointStatus, reconnectSharePoint, type SharePointStatus } from '../api/kb';
import { useAuthStore, useDisplayName, useOrgUrl, useUserId } from '../store/authStore';
import { useDenseView, useAutoSyncLedgers, useUiPreferencesStore } from '../store/uiPreferencesStore';
import { useToast } from '../components/ToastProvider';
import { formatSharePointExpiry } from '../utils/sharePointStatus';
import { PageHeader } from '../ui/PageHeader';
import { SectionCard } from '../ui/SectionCard';
import { Button } from '../ui/Button';
import { TextField } from '../ui/TextField';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { Chip } from '../ui/Chip';
import { InfoTip } from '../ui/Tooltip';
import { Switch } from '../ui/Switch';
import { cn } from '../lib/cn';

type IntegrationTone = 'ok' | 'danger' | 'warning' | 'dim';

const SHAREPOINT_COPY: Record<SharePointStatus['status'], { label: string; tone: IntegrationTone; reason: string | null }> = {
  valid: { label: 'Connected', tone: 'ok', reason: null },
  invalid: { label: 'Token invalid', tone: 'danger', reason: 'Token expired. Reauthentication required.' },
  unreachable: { label: 'Unreachable', tone: 'warning', reason: "Can't reach Microsoft Graph right now." },
  not_configured: { label: 'Not configured', tone: 'dim', reason: 'No access token has been set for the knowledge base.' },
};

const TONE_CHIP_CLASSES: Record<IntegrationTone, string> = {
  ok: 'bg-ok-soft text-ok-ink border-ok-border',
  danger: 'bg-danger-soft text-danger-ink border-danger-border',
  warning: 'bg-warning-soft text-warning-ink border-warning-border',
  dim: 'bg-surface-alt text-ink-3 border-hairline-strong',
};

// Only a real failure (danger/warning) gets the tinted card treatment --
// "not_configured" is a neutral, expected state (nothing was ever set up),
// not an error, so it stays visually calm like the connected case.
const TONE_CARD_CLASSES: Record<IntegrationTone, string> = {
  ok: 'border-hairline',
  dim: 'border-hairline',
  danger: 'border-danger-border bg-danger-soft/40',
  warning: 'border-warning-border bg-warning-soft/40',
};

const TONE_ACTION_LABEL: Record<IntegrationTone, string> = {
  ok: 'Configure',
  dim: 'Configure',
  danger: 'Reconnect',
  warning: 'Reconnect',
};

// A single integration row -- Azure DevOps and SharePoint both render the
// same shape (status chip, optional inline failure reason, one action
// button), matching the reference Settings mockup instead of the ADO-only
// SectionCard the page previously had.
function IntegrationRow({
  icon,
  name,
  detail,
  tone,
  reason,
  // Overrides TONE_ACTION_LABEL's generic default -- Azure DevOps always
  // says "Reconnect" regardless of tone (rotating/re-validating a PAT is
  // always a reconnect action here, matching this row's own dialog title,
  // "Reconnect to Azure DevOps"), unlike SharePoint's Configure/Reconnect
  // split which genuinely depends on whether a token was ever set.
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  tone: IntegrationTone;
  reason?: string | null;
  actionLabel?: string;
  onAction: () => void;
}): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-3 rounded-md border p-3', TONE_CARD_CLASSES[tone])}>
      <span className="grid h-8 w-8 flex-none place-items-center rounded-md bg-surface-alt text-ink-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-ink-1">
          {name}
          <Chip className={cn('border text-xs font-normal', TONE_CHIP_CLASSES[tone])}>{detail}</Chip>
        </p>
        {reason && <p className="mt-0.5 text-xs text-danger-ink">{reason}</p>}
      </div>
      <Button size="sm" variant={tone === 'ok' || tone === 'dim' ? 'outline' : 'primary'} onClick={onAction}>
        {actionLabel ?? TONE_ACTION_LABEL[tone]}
      </Button>
    </div>
  );
}

function DisplayPreferenceRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-1">{label}</p>
        <p className="text-xs text-ink-3">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} ariaLabel={label} />
    </div>
  );
}

/**
 * Profile & Connections. The ADO PAT is vaulted server-side (encrypted,
 * keyed to this session's userId -- credential-vault.service.ts), never
 * held by the browser after login. This screen's "Reconnect" calls
 * POST /auth/ado-credential -- re-validates the PAT and re-vaults it
 * WITHOUT issuing a new session, so rotating a PAT or fixing a typo'd org
 * URL doesn't force a full sign-out/sign-in.
 *
 * SharePoint's own reconnect (a single access token shared by every user of
 * the knowledge base, not per-user OAuth) reuses the exact same
 * getSharePointStatus/reconnectSharePoint calls KnowledgeBase.tsx already
 * makes -- surfaced here too so connection health for BOTH integrations is
 * visible from one place, matching the reference Settings layout, rather
 * than only ever being discoverable by visiting the Knowledge Base page.
 */
export function Settings(): React.ReactElement {
  const displayName = useDisplayName();
  const orgUrl = useOrgUrl();
  const userId = useUserId();
  const { showToast } = useToast();
  const denseView = useDenseView();
  const autoSyncLedgers = useAutoSyncLedgers();
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [newOrgUrl, setNewOrgUrl] = useState(orgUrl ?? '');
  const [newPat, setNewPat] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  const [sharePointStatus, setSharePointStatus] = useState<SharePointStatus | null>(null);
  const [sharePointReconnectOpen, setSharePointReconnectOpen] = useState(false);
  const [sharePointToken, setSharePointToken] = useState('');
  const [isSharePointReconnecting, setIsSharePointReconnecting] = useState(false);
  const [sharePointReconnectError, setSharePointReconnectError] = useState<string | null>(null);

  useEffect(() => {
    getSharePointStatus()
      .then(setSharePointStatus)
      .catch(() => setSharePointStatus({ status: 'unreachable', expiresInSeconds: null }));
  }, []);

  function openReconnect(): void {
    setNewOrgUrl(orgUrl ?? '');
    setNewPat('');
    setReconnectError(null);
    setReconnectOpen(true);
  }

  async function handleReconnect(): Promise<void> {
    setIsReconnecting(true);
    setReconnectError(null);
    try {
      await httpClient.post('/auth/ado-credential', { adoOrgUrl: newOrgUrl, pat: newPat });
      // orgUrl is the only locally-cached field this touches -- the PAT
      // itself never enters authStore; the vault write already happened
      // server-side in the request above.
      useAuthStore.getState().login(newOrgUrl, displayName ?? '', userId ?? '');
      showToast('Azure DevOps connection updated.', 'success');
      setReconnectOpen(false);
    } catch {
      setReconnectError('Invalid ADO organization URL or Personal Access Token, or it belongs to a different ADO account.');
    } finally {
      setIsReconnecting(false);
    }
  }

  function openSharePointReconnect(): void {
    setSharePointToken('');
    setSharePointReconnectError(null);
    setSharePointReconnectOpen(true);
  }

  async function handleSharePointReconnect(): Promise<void> {
    setIsSharePointReconnecting(true);
    setSharePointReconnectError(null);
    try {
      const status = await reconnectSharePoint(sharePointToken);
      if (status.status !== 'valid') {
        setSharePointReconnectError('SharePoint rejected that token. Check you copied the whole value — they are long.');
        return;
      }
      setSharePointStatus(status);
      showToast('SharePoint reconnected.', 'success');
      setSharePointReconnectOpen(false);
    } catch {
      setSharePointReconnectError('SharePoint rejected that token. Check you copied the whole value — they are long.');
    } finally {
      setIsSharePointReconnecting(false);
    }
  }

  const sharePointCopy = sharePointStatus ? SHAREPOINT_COPY[sharePointStatus.status] : null;
  const sharePointExpiry = sharePointStatus ? formatSharePointExpiry(sharePointStatus.expiresInSeconds) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Profile & Connections" />
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <SectionCard title="Profile">
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium text-ink-1">{displayName}</p>
            <p className="font-mono text-xs text-ink-3">{userId}</p>
          </div>
        </SectionCard>

        <div className="flex flex-col gap-4">
          <SectionCard title="Integrations">
            <div className="flex flex-col gap-2.5">
              <IntegrationRow
                icon={<span className="text-xs font-bold">ADO</span>}
                name="Azure DevOps"
                detail={orgUrl ?? 'Not connected'}
                tone="ok"
                actionLabel="Reconnect"
                onAction={openReconnect}
              />
              {sharePointCopy && (
                <IntegrationRow
                  icon={<span className="text-xs font-bold">SP</span>}
                  name="SharePoint"
                  detail={sharePointCopy.label + (sharePointExpiry ? ` · ${sharePointExpiry}` : '')}
                  tone={sharePointCopy.tone}
                  reason={sharePointCopy.reason}
                  onAction={openSharePointReconnect}
                />
              )}
            </div>
          </SectionCard>

          <SectionCard title="Display Preferences">
            <div className="flex flex-col gap-3">
              <DisplayPreferenceRow
                label="Dense View"
                description="Reduce padding for data tables"
                checked={denseView}
                onCheckedChange={(value) => useUiPreferencesStore.getState().setDenseView(value)}
              />
              <DisplayPreferenceRow
                label="Auto-Sync Ledgers"
                description="Periodically fetch updates from ADO"
                checked={autoSyncLedgers}
                onCheckedChange={(value) => useUiPreferencesStore.getState().setAutoSyncLedgers(value)}
              />
            </div>
          </SectionCard>
        </div>
      </div>

      <Dialog
        open={reconnectOpen}
        onOpenChange={setReconnectOpen}
        title="Reconnect to Azure DevOps"
        description="Re-enter your organization URL and a valid Personal Access Token."
        footer={
          <>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={() => setReconnectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleReconnect} disabled={!newOrgUrl || !newPat || isReconnecting}>
              {isReconnecting && <Spinner />}
              Reconnect
            </Button>
          </>
        }
      >
        <TextField label="ADO Organization URL" value={newOrgUrl} onChange={(e) => setNewOrgUrl(e.target.value)} fullWidth />
        <div className="flex items-end gap-1.5">
          <TextField label="Personal Access Token" type="password" value={newPat} onChange={(e) => setNewPat(e.target.value)} fullWidth />
          <InfoTip content="Needs Work Items (Read, write, & manage) scope at minimum. Reconnecting re-validates and re-encrypts this token server-side without signing you out." />
        </div>
        {reconnectError && <p className="text-sm text-danger">{reconnectError}</p>}
      </Dialog>

      <Dialog
        open={sharePointReconnectOpen}
        onOpenChange={setSharePointReconnectOpen}
        title="Reconnect SharePoint"
        description="Paste a fresh access token. This is checked against SharePoint before saving, and one token is shared by everyone using the knowledge base."
        footer={
          <>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={() => setSharePointReconnectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSharePointReconnect} disabled={!sharePointToken || isSharePointReconnecting}>
              {isSharePointReconnecting && <Spinner />}
              Reconnect
            </Button>
          </>
        }
      >
        <TextField label="SharePoint access token" type="password" value={sharePointToken} onChange={(e) => setSharePointToken(e.target.value)} fullWidth />
        {sharePointReconnectError && <p className="text-sm text-danger">{sharePointReconnectError}</p>}
      </Dialog>
    </div>
  );
}
