import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { FolderTree } from 'lucide-react';
import {
  browseSharedFolder,
  browseSubfolder,
  deleteIngestedDocument,
  ingestFolderItem,
  reconnectSharePoint,
  setRetrievalMode,
  type FolderTreeEntry,
  type SharePointStatus,
} from '../api/kb';
import { SharePointFolderTree } from '../components/SharePointFolderTree';
import { KbSourceBar } from '../components/KbSourceBar';
import { KbFileList } from '../components/KbFileList';
import { KbFileDetailPane } from '../components/KbFileDetailPane';
import { RubricPanel } from '../components/RubricPanel';
import { useToast } from '../components/ToastProvider';
import { useUserId } from '../store/authStore';
import { useConnectionStatusStore } from '../store/connectionStatusStore';
import { PageHeader } from '../ui/PageHeader';
import { TextField } from '../ui/TextField';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Card } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { Alert } from '../ui/Alert';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Dialog } from '../ui/Dialog';

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
        return 'The SharePoint access token has expired or is invalid — use Reconnect above to refresh it, then try again.';
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

const SHAREPOINT_UNREACHABLE: SharePointStatus = { status: 'unreachable', expiresInSeconds: null };

export function KnowledgeBase(): React.ReactElement {
  const { showToast, showErrorToast } = useToast();
  const userId = useUserId();
  // What is typed in the URL field.
  const [browseUrl, setBrowseUrl] = useState('');
  // The folder URL actually being shown: restored on load, or set by a successful browse. The source bar shows it.
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [lastBrowsedAt, setLastBrowsedAt] = useState<number | null>(null);
  // Shared with the rest of the app (polled and refreshed in one place); a check that failed reads as unreachable.
  const sharePointEntry = useConnectionStatusStore((s) => s.sharePoint);
  const sharePointStatus = sharePointEntry.error ? SHAREPOINT_UNREACHABLE : sharePointEntry.data;
  useEffect(() => {
    void useConnectionStatusStore.getState().refresh('sharePoint');
  }, []);
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
  const [ingestOverrides, setIngestOverrides] = useState<Record<string, { ingested: boolean; docId: string | null; chunkCount?: number | null }>>({});
  const [ingestingId, setIngestingId] = useState<string | null>(null);
  const ingestingRef = useRef(false);
  // Per-file "always include" (Full Context mode) choice, made in the
  // detail pane before ingest -- keyed by entry.id so switching the
  // selected file never leaks one file's choice onto another's checkbox.
  const [alwaysIncludeSelection, setAlwaysIncludeSelection] = useState<Record<string, boolean>>({});
  // Entry id whose retrieval-mode switch (on an already-ingested file) is in flight.
  const [modeUpdatingId, setModeUpdatingId] = useState<string | null>(null);

  const [documentPendingRemoval, setDocumentPendingRemoval] = useState<PendingRemoval | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const isRemovingRef = useRef(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnectToken, setReconnectToken] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const isReconnectingRef = useRef(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  function isIngested(entry: FolderTreeEntry): boolean {
    return ingestOverrides[entry.id]?.ingested ?? entry.alreadyIngested;
  }

  // A fresh ingest/removal in this session supersedes the browse-time count:
  // the store's count after that ingest (chunksInStore, which can still be 0),
  // or unknown when the backend did not report one.
  function chunkCountOf(entry: FolderTreeEntry): number | null {
    const override = ingestOverrides[entry.id];
    if (override) return override.chunkCount ?? null;
    return entry.chunkCount ?? null;
  }

  function ingestedDocIdOf(entry: FolderTreeEntry): string | null {
    return ingestOverrides[entry.id]?.docId ?? entry.ingestedDocumentId;
  }

  // The user's choice this session, else the stored mode from the browse.
  function isAlwaysInclude(entry: FolderTreeEntry): boolean {
    return alwaysIncludeSelection[entry.id] ?? entry.retrievalMode === 'always_include';
  }

  // Before ingest the choice is only recorded (applied at ingest). On an
  // ingested file it is applied immediately by retagging the stored chunks,
  // and recorded only once that succeeded so the checkbox never claims a mode
  // the index doesn't have.
  async function handleToggleAlwaysInclude(entry: FolderTreeEntry, value: boolean): Promise<void> {
    const docId = isIngested(entry) ? ingestedDocIdOf(entry) : null;
    if (!docId) {
      setAlwaysIncludeSelection((prev) => ({ ...prev, [entry.id]: value }));
      return;
    }
    if (modeUpdatingId) return;
    setModeUpdatingId(entry.id);
    try {
      await setRetrievalMode(docId, value ? 'always_include' : 'retrieve');
      setAlwaysIncludeSelection((prev) => ({ ...prev, [entry.id]: value }));
      showToast(
        value
          ? `"${entry.name}" will now be included in full in every survey.`
          : `"${entry.name}" will now be retrieved only when relevant.`,
        'success',
      );
    } catch (err) {
      showErrorToast(`Failed to update "${entry.name}" — please try again.`, err);
    } finally {
      setModeUpdatingId(null);
    }
  }

  // Optional urlOverride: the mount-restore effect below calls this with the
  // just-read localStorage value directly, since setBrowseUrl's own update
  // wouldn't be visible in this closure until the next render.
  // Resolves true when the folder was browsed, false when it could not be (error shown) or a browse was already running.
  async function handleBrowse(urlOverride?: string): Promise<boolean> {
    const url = urlOverride ?? browseUrl;
    if (!url || !userId || browsingRef.current) return false;
    browsingRef.current = true;
    setBrowsing(true);
    setBrowseError(null);
    setRootEntries(null);
    try {
      const entries = await browseSharedFolder(url, userId);
      setRootEntries(entries);
      // A fresh browse is a new tree -- reset all navigation/selection back
      // to root rather than pointing at a folder/file that may no longer
      // exist under the newly-browsed link. Also bump the shared sequence
      // counter so any in-flight navigateToFolder call is invalidated --
      // see navigateToFolder's own comment for why this matters.
      folderNavSeqRef.current += 1;
      setCurrentFolder(ROOT_FOLDER);
      setCenterEntries(entries);
      setSelectedFileId(null);
      setIngestOverrides({});
      localStorage.setItem(KB_BROWSE_URL_STORAGE_KEY, url);
      setSourceUrl(url);
      setLastBrowsedAt(Date.now());
      return true;
    } catch (error) {
      setBrowseError(describeIngestError(error));
      return false;
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
    setSourceUrl(saved);
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
    } catch (err) {
      if (seq !== folderNavSeqRef.current) return;
      showErrorToast(`Failed to open "${name}" — please try again.`, err);
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
    // Bump the shared sequence counter so any in-flight navigateToFolder
    // call is invalidated -- otherwise its slower response could still
    // land and repaint the center pane after we've already jumped to root.
    folderNavSeqRef.current += 1;
    setCurrentFolder(ROOT_FOLDER);
    setCenterEntries(rootEntries);
    setSelectedFileId(null);
  }

  async function handleIngestFile(entry: FolderTreeEntry): Promise<void> {
    if (!userId || !entry.downloadUrl || ingestingId || ingestingRef.current) return;
    ingestingRef.current = true;
    setIngestingId(entry.id);
    // Re-ingest = the file was already in the KB but had no stored vectors.
    const reingest = isIngested(entry);
    try {
      const relativePath = currentFolder.path ? `${currentFolder.path}/${entry.name}` : entry.name;
      // A re-ingest of an already-ingested file keeps its current mode (the
      // user's switch this session, else the stored one) rather than silently
      // resetting an always-include doc to similarity retrieval.
      const retrievalMode = isAlwaysInclude(entry) ? 'always_include' : undefined;
      const result = await ingestFolderItem(entry.name, entry.id, entry.downloadUrl, relativePath, userId, retrievalMode);
      setIngestOverrides((prev) => ({
        ...prev,
        [entry.id]: {
          ingested: true,
          docId: result.ingestedDocumentId,
          chunkCount: result.chunksInStore ?? null,
        },
      }));
      if (reingest) {
        if (result.chunksInStore === 0) {
          showToast(
            `Re-ingested "${entry.name}", but no text could be stored. The file may be empty or scanned images; try a text-based version.`,
            'warning',
          );
        } else {
          showToast(`Re-ingested "${entry.name}".`, 'success');
        }
      } else {
        showToast(`Added "${entry.name}" to the knowledge base.`, 'success');
      }
    } catch (err) {
      showErrorToast(`Failed to ${reingest ? 're-ingest' : 'add'} "${entry.name}" — please try again.`, err);
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
    } catch (err) {
      showErrorToast('Failed to remove the document. Please try again.', err);
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
      useConnectionStatusStore.getState().record('sharePoint', status);
      // The folder was not readable before (that is why the token was replaced), so the explorer is empty or showing a stale
      // error. Browse it again now rather than leaving that until the user presses Browse, and put them back where they were.
      setBrowseError(null);
      const url = sourceUrl ?? browseUrl;
      if (url) {
        const previousFolder = currentFolder;
        const browsed = await handleBrowse(url);
        if (browsed && previousFolder.id && previousFolder.driveId) {
          await navigateToFolder(previousFolder.id, previousFolder.driveId, previousFolder.path, previousFolder.name);
        }
      }
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
      <KbSourceBar
        sourceUrl={sourceUrl}
        draftUrl={browseUrl}
        onDraftUrlChange={setBrowseUrl}
        status={sharePointStatus}
        browsing={browsing}
        canBrowse={!!userId}
        lastBrowsedAt={lastBrowsedAt}
        onBrowse={() => void handleBrowse()}
        onRefresh={() => void handleBrowse(sourceUrl ?? browseUrl)}
        onReconnect={openReconnect}
      />
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
              chunkCountOf={chunkCountOf}
              ingestingId={ingestingId}
              onIngest={handleIngestFile}
              onRequestRemove={handleRequestRemove}
            />
            <div className="min-h-0 overflow-y-auto">
              <KbFileDetailPane
                entry={selectedFile}
                ingested={selectedFile ? isIngested(selectedFile) : false}
                chunkCount={selectedFile ? chunkCountOf(selectedFile) : null}
                isIngesting={selectedFile ? ingestingId === selectedFile.id : false}
                alwaysInclude={selectedFile ? isAlwaysInclude(selectedFile) : false}
                isUpdatingMode={selectedFile ? modeUpdatingId === selectedFile.id : false}
                onToggleAlwaysInclude={(value) => selectedFile && handleToggleAlwaysInclude(selectedFile, value)}
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
      <RubricPanel />
    </div>
  );
}
