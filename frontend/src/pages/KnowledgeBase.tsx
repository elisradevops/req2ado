import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { FolderTree } from 'lucide-react';
import {
  browseSharedFolder,
  browseSubfolder,
  deleteIngestedDocument,
  getSharePointStatus,
  ingestFolderItem,
  reconnectSharePoint,
  type FolderTreeEntry,
  type SharePointStatus,
} from '../api/kb';
import { SharePointFolderTree } from '../components/SharePointFolderTree';
import { KbFileList } from '../components/KbFileList';
import { KbFileDetailPane } from '../components/KbFileDetailPane';
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
import { cn } from '../lib/cn';

// Same semantic-token approach Settings.tsx's own SharePoint status chip
// already uses (TONE_CHIP_CLASSES) -- was raw bg/color CSS-var strings
// (including a bare hex white) here, a second, independent color system for
// the identical concept.
const STATUS_COPY: Record<SharePointStatus['status'], { label: string; chipClassName: string }> = {
  valid: { label: 'Connected', chipClassName: 'bg-ok-soft text-ok-ink border-ok-border' },
  invalid: { label: 'Token invalid', chipClassName: 'bg-danger-soft text-danger-ink border-danger-border' },
  unreachable: { label: "Can't reach Microsoft Graph", chipClassName: 'bg-warning-soft text-warning-ink border-warning-border' },
  not_configured: { label: 'Not configured', chipClassName: 'bg-surface-alt text-ink-3 border-hairline-strong' },
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
        <Chip className={cn('border text-xs font-normal', copy.chipClassName)}>SharePoint</Chip>
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
  entryId: string;
}

// The currently selected folder for the center/right panes -- `id: null`
// is the sentinel for "Root" (the pasted sharing URL's own top level,
// which has no id/driveId of its own to browse-children against).
interface CurrentFolder {
  id: string | null;
  driveId: string | null;
  path: string;
  name: string;
}

const ROOT_FOLDER: CurrentFolder = { id: null, driveId: null, path: '', name: 'Root' };

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
  // The root folder's own children -- also what the left-pane tree walks
  // recursively (foldersOnly) and what the center pane shows by default.
  const [rootEntries, setRootEntries] = useState<FolderTreeEntry[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const browsingRef = useRef(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // Three-pane navigation state (DESIGN.md Track B, phase B10) -- which
  // folder the center/right panes are currently showing, independent of
  // the left tree's own internal expand/collapse state.
  const [currentFolder, setCurrentFolder] = useState<CurrentFolder>(ROOT_FOLDER);
  const [centerEntries, setCenterEntries] = useState<FolderTreeEntry[] | null>(null);
  const [centerLoading, setCenterLoading] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  // Stale-response guard for navigateToFolder -- see its own comment below.
  const folderNavSeqRef = useRef(0);

  // Ingest/remove state lifted up here (rather than duplicated per-row
  // inside KbFileList AND KbFileDetailPane) so both panes always agree on
  // whether a given file is in the knowledge base -- a file ingested via
  // the center-pane row action must show as ingested in the right-hand
  // detail pane too, without a re-browse round trip.
  const [ingestOverrides, setIngestOverrides] = useState<Record<string, { ingested: boolean; docId: string | null }>>({});
  const [ingestingId, setIngestingId] = useState<string | null>(null);
  const ingestingRef = useRef(false);
  // Per-file "always include" (Full Context mode) choice, made in the
  // detail pane before ingest -- keyed by entry.id so switching the
  // selected file never leaks one file's choice onto another's checkbox.
  const [alwaysIncludeSelection, setAlwaysIncludeSelection] = useState<Record<string, boolean>>({});

  const [documentPendingRemoval, setDocumentPendingRemoval] = useState<PendingRemoval | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const isRemovingRef = useRef(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnectToken, setReconnectToken] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const isReconnectingRef = useRef(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);

  function isIngested(entry: FolderTreeEntry): boolean {
    return ingestOverrides[entry.id]?.ingested ?? entry.alreadyIngested;
  }

  function ingestedDocIdOf(entry: FolderTreeEntry): string | null {
    return ingestOverrides[entry.id]?.docId ?? entry.ingestedDocumentId;
  }

  // Optional urlOverride: the mount-restore effect below calls this with the
  // just-read localStorage value directly, since setBrowseUrl's own update
  // wouldn't be visible in this closure until the next render.
  async function handleBrowse(urlOverride?: string): Promise<void> {
    const url = urlOverride ?? browseUrl;
    if (!url || !userId || browsingRef.current) return;
    browsingRef.current = true;
    setBrowsing(true);
    setBrowseError(null);
    setRootEntries(null);
    try {
      const entries = await browseSharedFolder(url, userId);
      setRootEntries(entries);
      // A fresh browse is a new tree -- reset all navigation/selection back
      // to root rather than pointing at a folder/file that may no longer
      // exist under the newly-browsed link.
      setCurrentFolder(ROOT_FOLDER);
      setCenterEntries(entries);
      setSelectedFileId(null);
      setIngestOverrides({});
      localStorage.setItem(KB_BROWSE_URL_STORAGE_KEY, url);
    } catch (error) {
      setBrowseError(describeIngestError(error));
    } finally {
      browsingRef.current = false;
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

  async function navigateToFolder(id: string, driveId: string | null, path: string, name: string): Promise<void> {
    if (!userId || !driveId) return;
    // Stale-response guard, same pattern as NewJobWizard.tsx's own
    // estimateRequestSeq: only the response matching the request fired
    // most recently is allowed to commit to state -- otherwise clicking
    // folder A then quickly folder B can let A's slower response overwrite
    // B's already-painted contents under B's already-shown breadcrumb.
    const seq = ++folderNavSeqRef.current;
    setCurrentFolder({ id, driveId, path, name });
    setSelectedFileId(null);
    setCenterLoading(true);
    try {
      const entries = await browseSubfolder(driveId, id, userId, path);
      if (seq !== folderNavSeqRef.current) return;
      setCenterEntries(entries);
    } catch {
      if (seq !== folderNavSeqRef.current) return;
      showToast(`Failed to open "${name}" — please try again.`, 'error');
      setCenterEntries([]);
    } finally {
      if (seq === folderNavSeqRef.current) setCenterLoading(false);
    }
  }

  // Left-pane tree selection -- the tree already computes each node's own
  // full relative path as it recurses, so that path is reused as-is rather
  // than recomputed here.
  function handleSelectFolderFromTree(entry: FolderTreeEntry, path: string): void {
    void navigateToFolder(entry.id, entry.driveId, path, entry.name);
  }

  // Center-pane folder row navigation -- same destination as the tree
  // above, but the path has to be built from the CURRENT folder's own path
  // (the tree has no notion of "center pane" to compute it from).
  function handleNavigateFolder(entry: FolderTreeEntry): void {
    const path = currentFolder.path ? `${currentFolder.path}/${entry.name}` : entry.name;
    void navigateToFolder(entry.id, entry.driveId, path, entry.name);
  }

  function handleNavigateRoot(): void {
    setCurrentFolder(ROOT_FOLDER);
    setCenterEntries(rootEntries);
    setSelectedFileId(null);
  }

  async function handleIngestFile(entry: FolderTreeEntry): Promise<void> {
    if (!userId || !entry.downloadUrl || ingestingId || ingestingRef.current) return;
    ingestingRef.current = true;
    setIngestingId(entry.id);
    try {
      const relativePath = currentFolder.path ? `${currentFolder.path}/${entry.name}` : entry.name;
      const retrievalMode = alwaysIncludeSelection[entry.id] ? 'always_include' : undefined;
      const result = await ingestFolderItem(entry.name, entry.id, entry.downloadUrl, relativePath, userId, retrievalMode);
      setIngestOverrides((prev) => ({ ...prev, [entry.id]: { ingested: true, docId: result.ingestedDocumentId } }));
      showToast(`Added "${entry.name}" to the knowledge base.`, 'success');
    } catch {
      showToast(`Failed to add "${entry.name}" — please try again.`, 'error');
    } finally {
      ingestingRef.current = false;
      setIngestingId(null);
    }
  }

  function handleRequestRemove(entry: FolderTreeEntry): void {
    const docId = ingestedDocIdOf(entry);
    if (!docId) return;
    setDocumentPendingRemoval({ documentId: docId, name: entry.name, entryId: entry.id });
  }

  async function handleRemoveDocument(): Promise<void> {
    if (!documentPendingRemoval || !userId || isRemovingRef.current) return;
    isRemovingRef.current = true;
    setIsRemoving(true);
    try {
      await deleteIngestedDocument(documentPendingRemoval.documentId, userId);
      showToast(`Removed "${documentPendingRemoval.name}" from the knowledge base.`, 'success');
      setIngestOverrides((prev) => ({ ...prev, [documentPendingRemoval.entryId]: { ingested: false, docId: null } }));
      setDocumentPendingRemoval(null);
    } catch {
      showToast('Failed to remove the document. Please try again.', 'error');
    } finally {
      isRemovingRef.current = false;
      setIsRemoving(false);
    }
  }

  function openReconnect(): void {
    setReconnectToken('');
    setReconnectError(null);
    setReconnectOpen(true);
  }

  async function handleReconnect(): Promise<void> {
    if (isReconnectingRef.current) return;
    isReconnectingRef.current = true;
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
      isReconnectingRef.current = false;
      setIsReconnecting(false);
    }
  }

  const selectedFile = centerEntries?.find((entry) => entry.id === selectedFileId) ?? null;
  const breadcrumbSegments = currentFolder.path ? currentFolder.path.split('/') : [];

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
      ) : rootEntries && userId ? (
        // Three-pane explorer: folder hierarchy (left) / selected folder's
        // files (center) / selected file's details (right) -- replaces the
        // single scrolling tree-with-inline-actions layout.
        <Card className="overflow-hidden">
          <div className="grid h-[560px] grid-cols-[220px_minmax(0,1fr)_280px] divide-x divide-hairline">
            <div className="min-h-0 overflow-y-auto p-2">
              {rootEntries.filter((e) => e.isFolder).length === 0 ? (
                <p className="p-2 text-xs text-ink-3">No subfolders here.</p>
              ) : (
                <SharePointFolderTree
                  entries={rootEntries}
                  userId={userId}
                  onRequestRemove={() => {}}
                  foldersOnly
                  selectedFolderId={currentFolder.id}
                  onSelectFolder={handleSelectFolderFromTree}
                />
              )}
            </div>
            <KbFileList
              entries={centerEntries}
              loading={centerLoading}
              breadcrumb={breadcrumbSegments}
              onNavigateRoot={handleNavigateRoot}
              onNavigateFolder={handleNavigateFolder}
              selectedFileId={selectedFileId}
              onSelectFile={(entry) => setSelectedFileId(entry.id)}
              isIngested={isIngested}
              ingestingId={ingestingId}
              onIngest={handleIngestFile}
              onRequestRemove={handleRequestRemove}
            />
            <div className="min-h-0 overflow-y-auto">
              <KbFileDetailPane
                entry={selectedFile}
                ingested={selectedFile ? isIngested(selectedFile) : false}
                isIngesting={selectedFile ? ingestingId === selectedFile.id : false}
                alwaysInclude={selectedFile ? (alwaysIncludeSelection[selectedFile.id] ?? false) : false}
                onToggleAlwaysInclude={(value) =>
                  selectedFile && setAlwaysIncludeSelection((prev) => ({ ...prev, [selectedFile.id]: value }))
                }
                onIngest={() => selectedFile && handleIngestFile(selectedFile)}
                onRequestRemove={() => selectedFile && handleRequestRemove(selectedFile)}
              />
            </div>
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
        variant="destructive"
      />
    </div>
  );
}
