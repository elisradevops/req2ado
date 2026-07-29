import { useState } from 'react';
import { httpClient } from '../api/httpClient';
import { useAuthStore, useDisplayName, useOrgUrl, useUserId } from '../store/authStore';
import { useToast } from '../components/ToastProvider';
import { PageHeader } from '../ui/PageHeader';
import { SectionCard } from '../ui/SectionCard';
import { Button } from '../ui/Button';
import { TextField } from '../ui/TextField';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { Chip } from '../ui/Chip';
import { InfoTip } from '../ui/Tooltip';

/**
 * Profile & Connections. The ADO PAT is vaulted server-side (encrypted,
 * keyed to this session's userId -- credential-vault.service.ts), never
 * held by the browser after login. This screen's "Reconnect" calls
 * POST /auth/ado-credential -- re-validates the PAT and re-vaults it
 * WITHOUT issuing a new session, so rotating a PAT or fixing a typo'd org
 * URL doesn't force a full sign-out/sign-in.
 *
 * Deliberately does NOT show a SharePoint or LLM/Open WebUI connection row
 * -- both are server-side-only credentials with no per-user rotation UI
 * built yet; presenting a row for a capability that doesn't exist would be
 * misleading, not helpful.
 */
export function Settings(): React.ReactElement {
  const displayName = useDisplayName();
  const orgUrl = useOrgUrl();
  const userId = useUserId();
  const { showToast } = useToast();
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [newOrgUrl, setNewOrgUrl] = useState(orgUrl ?? '');
  const [newPat, setNewPat] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Profile & Connections" />
      <SectionCard title="Profile">
        <div className="flex flex-col gap-1 text-sm">
          <p>
            <span className="text-ink-3">Signed in as</span> <span className="font-medium">{displayName}</span>
          </p>
        </div>
      </SectionCard>
      <SectionCard
        title="Azure DevOps"
        action={
          <Button size="sm" variant="outline" onClick={openReconnect}>
            Reconnect
          </Button>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <Chip bg="var(--color-ok)" color="#fff">
              Connected
            </Chip>
            <span className="font-mono text-xs text-ink-3">{orgUrl}</span>
          </div>
          <p className="text-xs text-ink-3">
            Your Personal Access Token is encrypted and stored server-side so it doesn't need to be resent on every request.
            Reconnect here if you rotated your PAT or need to point at a different organization.
          </p>
        </div>
      </SectionCard>

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
    </div>
  );
}
