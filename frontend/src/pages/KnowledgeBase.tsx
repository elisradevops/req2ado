import { useEffect, useState } from 'react';
import { isAxiosError } from 'axios';
import { FolderTree } from 'lucide-react';
import {
  browseSharedFolder,
  deleteIngestedDocument,
  getSharePointStatus,
  reconnectSharePoint,
  type FolderTreeEntry,
  type SharePointStatus,
} from '../api/kb';
import { SharePointFolderTree } from '../components/SharePointFolderTree';
import { useToast } from '../components/ToastProvider';
import { useUserId } from '../store/authStore';
import { PageHeader } from '../ui/PageHeader';
import { TextField } from '../ui/TextField';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { Chip } from '../ui/Chip';
import { Alert } from '../ui/Alert';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Dialog } from '../ui/Dialog';
import { formatSharePointExpiry } from '../utils/sharePointStatus';

const STATUS_COPY: Record<SharePointStatus['status'], { label: string; bg: string; color: string }> = {
  valid: { label: 'Connected', bg: 'var(--color-ok)', color: '#fff' },
  invalid: { label: 'Token invalid', bg: 'var(--color-danger)', color: '#fff' },
  unreachable: { label: "Can't reach Microsoft Graph", bg: 'var(--color-warning)', color: '#fff' },
  not_configured: { label: 'Not configured', bg: 'var(--color-surface-alt)', color: 'var(--color-ink-2)' },
};

function SharePointStatusStrip({ onReconnect }: { onReconnect: () => void }): React.ReactElement {
  const [status, setStatus] = useState<SharePointStatus | null>(null);

  useEffect(() => {
    getSharePointStatus()
      .then(setStatus)
      .catch(() => setStatus({ status: 'unreachable', expiresInSeconds: null }));
  }, []);

  if (!status) {
    return (
      <Card>
        <div className="flex items-center gap-2 p-2.5">
          <Skeleton className="h-5 w-40" />
        </div>
      </Card>
    );
  }

  const copy = STATUS_COPY[status.status];
  const expiry = formatSharePointExpiry(status.expiresInSeconds);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 p-2.5">
        <Chip bg={copy.bg} color={copy.color}>
          SharePoint
        </Chip>
        <span className="text-sm text-ink-2">
          {copy.label}
          {expiry && <span className="text-ink-3"> · {expiry}</span>}
        </span>
        <Button size="sm" variant="outline" onClick={onReconnect} className="ml-auto">
          Reconnect
        </Button>
      </div>
    </Card>
  );
}

// Maps the backend's Graph/SharePoint error status codes (see
// ingestion/app/kb/graph_client.py's _error_for_status and
// app/main.py's kb_ingest_url/kb_ingest_folder_url) to an actionable message
// -- these are NOT interchangeable: a 424 means the configured
// SHAREPOINT_TOKEN expired (nothing wrong with the link -- the orchestrator
// remaps ingestion's real 401 to 424, see kb.controller.ts's
// mapIngestionErrorStatus), while a 404 means the link itself is wrong.
// Collapsing all of them into one generic "check the sharing link" message
// (the prior behavior) actively misleads on the token-expiry case, the
// single most common real-world failure.
function describeIngestError(error: unknown): string {
  if (isAxiosError(error)) {
    switch (error.response?.status) {
      case 400:
        return 'SharePoint access isn’t configured on the server (no access token set) — contact an admin.';
      case 424:
        // The orchestrator remaps a downstream SharePoint/Graph 401 to 424
        // (Failed Dependency) before it ever reaches this axios instance --
        // see kb.controller.ts's mapIngestionErrorStatus doc comment for
        // why: a bare 401 here would trip httpClient.ts's global "your
        // session died" interceptor and log the user out of the whole app
        // over an expired SharePoint token, not an expired orchestrator
        // session.
        return 'The server’s SharePoint access token has expired or is invalid — ask an admin to refresh it, then try again.';
      case 403:
        return 'The configured SharePoint access token doesn’t have permission to read this link.';
      case 404:
        return 'File or folder not found at this sharing link — double check the URL.';
      case 502:
        return 'Could not reach Microsoft Graph — check network connectivity and try again.';
      default:
        break;
    }
  }
  return 'Ingest failed — check the sharing link and try again.';
}

interface PendingRemoval {
  documentId: string;
  name: string;
}

// Not a secret -- the user's own pasted SharePoint/OneDrive sharing URL, so
// localStorage (survives across tabs/restarts, unlike authStore's session-
// scoped sessionStorage) is fine here. Without this, the tree looked like it
// "cleared" every time the user left the page or refreshed: the browse
// state was 100% in-memory with nothing to restore from, so returning to
// the page always required re-pasting the URL and clicking Browse again --
// the underlying ingested documents were never actually lost.
const KB_BROWSE_URL_STORAGE_KEY = 'req2ado-kb-browse-url';

export function KnowledgeBase(): React.ReactElement {
  const { showToast } = useToast();
  const userId = useUserId();
  const [browseUrl, setBrowseUrl] = useState('');
  const [browseEntries, setBrowseEntries] = useState<FolderTreeEntry[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [documentPendingRemoval, setDocumentPendingRemoval] = useState<PendingRemoval | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnectToken, setReconnectToken] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);

  // Optional urlOverride: the mount-restore effect below calls this with the
  // just-read localStorage value directly, since setBrowseUrl's own update
  // wouldn't be visible in this closure until the next render.
  async function handleBrowse(urlOverride?: string): Promise<void> {
    const url = urlOverride ?? browseUrl;
    if (!url || !userId) return;
    setBrowsing(true);
    setBrowseError(null);
    setBrowseEntries(null);
    try {
      setBrowseEntries(await browseSharedFolder(url, userId));
      localStorage.setItem(KB_BROWSE_URL_STORAGE_KEY, url);
    } catch (error) {
      setBrowseError(describeIngestError(error));
    } finally {
      setBrowsing(false);
    }
  }

  // Restores the last-browsed folder on mount (page refresh, or navigating
  // back to this page) -- runs once userId is available, matching every
  // other userId-gated fetch in this file.
  useEffect(() => {
    if (!userId) return;
    const saved = localStorage.getItem(KB_BROWSE_URL_STORAGE_KEY);
    if (!saved) return;
    setBrowseUrl(saved);
    void handleBrowse(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore-on-mount only, not on every browseUrl/handleBrowse change
  }, [userId]);

  async function handleRemoveDocument(): Promise<void> {
    if (!documentPendingRemoval || !userId) return;
    setIsRemoving(true);
    try {
      await deleteIngestedDocument(documentPendingRemoval.documentId, userId);
      showToast(`Removed "${documentPendingRemoval.name}" from the knowledge base.`, 'success');
      setDocumentPendingRemoval(null);
      // The tree's own rows track their ingested state locally (see
      // SharePointFolderTree) and won't reflect this removal on their own --
      // re-browsing from the root is the simplest correct refresh, even
      // though it collapses any expanded subfolders.
      if (browseUrl) await handleBrowse();
    } catch {
      showToast('Failed to remove the document. Please try again.', 'error');
    } finally {
      setIsRemoving(false);
    }
  }

  function openReconnect(): void {
    setReconnectToken('');
    setReconnectError(null);
    setReconnectOpen(true);
  }

  async function handleReconnect(): Promise<void> {
    setIsReconnecting(true);
    setReconnectError(null);
    try {
      const status = await reconnectSharePoint(reconnectToken);
      if (status.status !== 'valid') {
        setReconnectError('SharePoint rejected that token. Check you copied the whole value — they are long.');
        return;
      }
      showToast('SharePoint reconnected.', 'success');
      setReconnectOpen(false);
      setStatusRefreshKey((k) => k + 1);
    } catch {
      setReconnectError('SharePoint rejected that token. Check you copied the whole value — they are long.');
    } finally {
      setIsReconnecting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Knowledge Base" description="Documents your SURVEY jobs are judged against. Only visible to your own jobs." />
      <SharePointStatusStrip key={statusRefreshKey} onReconnect={openReconnect} />
      <Card>
        <div className="flex max-w-[560px] items-end gap-1.5 p-4">
          <TextField
            label="Sharing URL"
            helperText="Paste a SharePoint or OneDrive folder's 'Share' link -- every file and subfolder inside becomes browsable below."
            value={browseUrl}
            onChange={(event) => setBrowseUrl(event.target.value)}
            fullWidth
          />
          <Button onClick={() => handleBrowse()} disabled={!browseUrl || !userId || browsing}>
            {browsing && <Spinner />}
            {browsing ? 'Browsing…' : 'Browse'}
          </Button>
        </div>
      </Card>
      {browsing ? (
        <Card>
          <div className="flex flex-col gap-2 p-3.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </Card>
      ) : browseError ? (
        <Alert severity="error">{browseError}</Alert>
      ) : browseEntries ? (
        <Card>
          <div className="p-3.5">
            {browseEntries.length === 0 ? (
              <p className="py-1 text-sm text-ink-3">This folder is empty.</p>
            ) : (
              userId && <SharePointFolderTree entries={browseEntries} userId={userId} onRequestRemove={(documentId, name) => setDocumentPendingRemoval({ documentId, name })} />
            )}
          </div>
        </Card>
      ) : (
        <EmptyState
          icon={FolderTree}
          title="No folder browsed yet"
          description="Paste a SharePoint or OneDrive folder link above to see its contents -- add or remove any file directly from the tree."
        />
      )}
      <Dialog
        open={reconnectOpen}
        onOpenChange={setReconnectOpen}
        title="Reconnect SharePoint"
        description="Paste a fresh access token. This is checked against SharePoint before saving, and one token is shared by everyone using the knowledge base."
        footer={
          <>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={() => setReconnectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleReconnect} disabled={!reconnectToken || isReconnecting}>
              {isReconnecting && <Spinner />}
              Reconnect
            </Button>
          </>
        }
      >
        <TextField
          label="SharePoint access token"
          type="password"
          value={reconnectToken}
          onChange={(e) => setReconnectToken(e.target.value)}
          fullWidth
        />
        {reconnectError && <p className="text-sm text-danger">{reconnectError}</p>}
      </Dialog>
      <ConfirmDialog
        open={!!documentPendingRemoval}
        onOpenChange={(open) => !open && setDocumentPendingRemoval(null)}
        title="Remove this document from the knowledge base?"
        description={
          <>
            <strong>{documentPendingRemoval?.name}</strong> will no longer be judged against or cited by SURVEY jobs. This deletes its
            stored content and cannot be undone -- add it again from the tree if you need it back.
          </>
        }
        confirmLabel="Remove document"
        onConfirm={handleRemoveDocument}
        isConfirming={isRemoving}
        destructive
      />
    </div>
  );
}
