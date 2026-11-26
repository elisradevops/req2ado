import { reconnectFailureMessage } from '../utils/sharePointReconnect';
import { SharePointTokenHelp, SHAREPOINT_TOKEN_DIALOG_DESCRIPTION } from '../components/SharePointTokenHelp';
import { readKbBrowseUrl, removeLegacyKbBrowseUrl, writeKbBrowseUrl } from '../utils/kbBrowseUrl';
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
  switchKbSource,
  type FolderTreeEntry,
  type KbRetrievalMode,
  type SharePointStatus,
} from '../api/kb';
import { SharePointFolderTree } from '../components/SharePointFolderTree';
import { KbSourceBar } from '../components/KbSourceBar';
import { KbAddDialog } from '../components/KbAddDialog';
import { KbAddBatchDialog } from '../components/KbAddBatchDialog';
import { KbSwitchLibraryDialog } from '../components/KbSwitchLibraryDialog';
import { KbIngestQueue } from '../components/KbIngestQueue';
import { KbFileList } from '../components/KbFileList';
import { KbIngestedList } from '../components/KbIngestedList';
import { KbFileDetailPane } from '../components/KbFileDetailPane';
import { RubricDialog } from '../components/RubricDialog';
import { KbHealthSummary } from '../components/KbHealthSummary';
import { KbIngestReport } from '../components/KbIngestReport';
import { useKbProfile } from '../hooks/useKbProfile';
import { useToast } from '../components/ToastProvider';
import { useUserId } from '../store/authStore';
import { useConnectionStatusStore } from '../store/connectionStatusStore';
import { isBatchStatusFinished, useKbIngestStore } from '../store/kbIngestStore';
import { driveMismatchOf, type DriveMismatch } from '../utils/kbDriveMismatch';
import { walkFolders, type WalkedFile } from '../utils/kbFolderWalk';
import { usePageTitle } from '../hooks/usePageTitle';
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

// Why a library switch did not go through, in words. The server's own sentence is kept for a refusal (a batch still running).
function describeSwitchError(error: unknown): string {
  if (isAxiosError(error) && error.response?.status === 409) {
    const message = (error.response.data as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Could not remove the old files. Try again.';
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

const SHAREPOINT_UNREACHABLE: SharePointStatus = { status: 'unreachable', expiresInSeconds: null };

export function KnowledgeBase(): React.ReactElement {
  usePageTitle('Knowledge base');
  const { showToast, showErrorToast } = useToast();
  const userId = useUserId();
  // What is typed in the URL field.
  const [browseUrl, setBrowseUrl] = useState('');
  // The folder URL actually being shown: restored on load, or set by a successful browse. The source bar shows it.
  const [sourceUrl, setSourceUrl] = useState<string | null>(() => readKbBrowseUrl(userId));
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
  // Bumped after a file is added or removed so the list at the top reads the knowledge base again.
  const [kbListVersion, setKbListVersion] = useState(0);
  const [ingestingId, setIngestingId] = useState<string | null>(null);
  const ingestingRef = useRef(false);
  // Per-file "always include" (Full Context mode) choice, made in the
  // detail pane before ingest -- keyed by entry.id so switching the
  // selected file never leaks one file's choice onto another's checkbox.
  const [alwaysIncludeSelection, setAlwaysIncludeSelection] = useState<Record<string, boolean>>({});
  // Entry id whose retrieval-mode switch (on an already-ingested file) is in flight.
  const [modeUpdatingId, setModeUpdatingId] = useState<string | null>(null);
  // The file the "Add to knowledge base" dialog is open for, with the choice remembered for its folder (read once, when it opens).
  const [addTarget, setAddTarget] = useState<{ entry: FolderTreeEntry; remembered: KbRetrievalMode | null } | null>(null);
  // Files ticked in the list to add together, and the dialog that asks how to add them (with the choice remembered for the folder).
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [batchDialog, setBatchDialog] = useState<{ remembered: KbRetrievalMode | null } | null>(null);
  // "Include subfolders": ticking a folder (or "Select all") also takes the files below it. What a scan found is kept per ticked folder
  // until the selection is cleared or another folder is opened; `scan` is how far a running scan is.
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [folderSelections, setFolderSelections] = useState<Map<string, { files: WalkedFile[]; notices: string[] }>>(new Map());
  const [scan, setScan] = useState<{ folders: number; files: number } | null>(null);
  const scanController = useRef<AbortController | null>(null);
  // Bumped whenever the selection is dropped, so a scan that finishes afterwards is recognised and ignored.
  const scanSeq = useRef(0);
  // The root listing as last fetched, for putting the root back on show after a refresh that kept the folder.
  const lastRootEntries = useRef<FolderTreeEntry[] | null>(null);
  // The ingestion report and the grading rubric open as dialogs, from the batch panel and the health summary.
  const [reportOpen, setReportOpen] = useState(false);
  const [rubricOpen, setRubricOpen] = useState(false);
  // Set when the files being added are from a different SharePoint library than the ones already in the knowledge base: the user
  // is asked before the old files are removed, and `retry` repeats what they were doing once they have been.
  const [driveSwitch, setDriveSwitch] = useState<(DriveMismatch & { driveId: string; retry: () => Promise<unknown> }) | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // The batch being added in the background (kept by the server, so it is found again after a reload).
  const ingestBatch = useKbIngestStore((s) => s.batch);
  const ingestError = useKbIngestStore((s) => s.error);
  // The rubric is rebuilt after a batch that added files; a rubric built before the batch finished does not include them yet.
  const rebuildSince = ingestBatch && isBatchStatusFinished(ingestBatch.status) && ingestBatch.counts.added > 0 ? ingestBatch.finishedAt : null;
  const rubric = useKbProfile({ enabled: !!userId, since: rebuildSince });
  const ingestBusy = useKbIngestStore((s) => s.busy);

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

  // The mode of a file already in the knowledge base; null for one that is not.
  function currentModeOf(entry: FolderTreeEntry): KbRetrievalMode | null {
    if (!isIngested(entry)) return null;
    return isAlwaysInclude(entry) ? 'always_include' : 'retrieve';
  }

  // "Remember my choice for this folder": per user and folder, so a folder of guides stays one click once decided. Browser
  // storage can be unavailable or full; the dialog then simply starts with nothing chosen.
  function folderModeKey(): string | null {
    return userId ? `req2ado-kb-folder-mode:${userId}:${currentFolder.driveId ?? 'root'}:${currentFolder.id ?? 'root'}` : null;
  }

  function readRememberedMode(): KbRetrievalMode | null {
    const key = folderModeKey();
    if (!key) return null;
    try {
      const value = localStorage.getItem(key);
      return value === 'retrieve' || value === 'always_include' ? value : null;
    } catch {
      return null;
    }
  }

  function rememberMode(mode: KbRetrievalMode): void {
    const key = folderModeKey();
    if (!key) return;
    try {
      localStorage.setItem(key, mode);
    } catch {
      // Not remembered: the choice itself is not affected.
    }
  }

  // Every way of adding a file (row action, detail pane) comes here first: the file is not ingested until the user has chosen
  // how jobs use it.
  function requestAdd(entry: FolderTreeEntry): void {
    if (!entry.downloadUrl) return;
    setAddTarget({ entry, remembered: readRememberedMode() });
  }

  async function handleConfirmAdd(entry: FolderTreeEntry, mode: KbRetrievalMode, remember: boolean): Promise<void> {
    if (remember) rememberMode(mode);
    // The dialog closes once the file is in; after a failure it stays open (the error is toasted) so the user can try again
    // without choosing again.
    if (await handleIngestFile(entry, mode)) setAddTarget(null);
  }

  // Before ingest the choice is only recorded (applied at ingest). On an
  // ingested file it is applied immediately by retagging the stored chunks,
  // and recorded only once that succeeded so the checkbox never claims a mode
  // the index doesn't have.
  async function handleToggleAlwaysInclude(entry: FolderTreeEntry, value: boolean): Promise<void> {
    const docId = isIngested(entry) ? ingestedDocIdOf(entry) : null;
    // Only an ingested file has a switch; the choice for a new file is made in the add dialog.
    if (!docId || modeUpdatingId) return;
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
  // `keepFolder`: a refresh of the same tree (for example when a batch finishes) that leaves the user where they are, instead of
  // starting over at the root; the caller puts the folder on show back.
  async function handleBrowse(urlOverride?: string, options?: { keepFolder?: boolean }): Promise<boolean> {
    const url = urlOverride ?? browseUrl;
    if (!url || !userId || browsingRef.current) return false;
    browsingRef.current = true;
    setBrowsing(true);
    setBrowseError(null);
    if (!options?.keepFolder) setRootEntries(null);
    try {
      const entries = await browseSharedFolder(url, userId);
      setRootEntries(entries);
      lastRootEntries.current = entries;
      if (options?.keepFolder) {
        setIngestOverrides({});
        setLastBrowsedAt(Date.now());
        return true;
      }
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
      writeKbBrowseUrl(userId, url);
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

  // Restores the last-browsed folder on mount (page refresh, or navigating back to this page). It waits for the first SharePoint status
  // check: a token already known to be invalid or missing cannot read the folder, so browsing would only fail (a 424 and an error
  // banner repeating what the source bar already says). The saved source is still shown; once the status says the token works, the
  // browse happens, so a reconnect from elsewhere (the status popover) picks the page up too.
  const restoredRef = useRef(false);
  useEffect(() => {
    removeLegacyKbBrowseUrl();
  }, []);
  const tokenChecked = sharePointEntry.checkedAt !== null;
  const tokenBlocked = sharePointStatus?.status === 'invalid' || sharePointStatus?.status === 'not_configured';
  useEffect(() => {
    if (!userId || !tokenChecked || restoredRef.current) return;
    const saved = readKbBrowseUrl(userId);
    if (!saved) return;
    setBrowseUrl(saved);
    setSourceUrl(saved);
    if (tokenBlocked) return;
    restoredRef.current = true;
    void handleBrowse(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once, not on every browseUrl/handleBrowse change
  }, [userId, tokenChecked, tokenBlocked]);

  // Finds the batch this user already has going (after a reload, or coming back to the page), and stops following it on the way out:
  // the batch itself carries on on the server.
  useEffect(() => {
    if (!userId) return;
    void useKbIngestStore.getState().attach(userId);
    return () => useKbIngestStore.getState().stop();
  }, [userId]);

  // A running batch that finishes has changed what is in the knowledge base: list the folder again so the rows show it.
  const lastBatchStatus = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    const previous = lastBatchStatus.current;
    lastBatchStatus.current = ingestBatch ? { id: ingestBatch.id, status: ingestBatch.status } : null;
    if (ingestBatch && previous && previous.id === ingestBatch.id && !isBatchStatusFinished(previous.status as never) && isBatchStatusFinished(ingestBatch.status)) {
      void reloadKeepingFolder();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of the batch's status matters here
  }, [ingestBatch?.id, ingestBatch?.status]);

  // A selection belongs to the folder it was made in, in the tree it was made in. A refresh of the same tree keeps it.
  useEffect(() => {
    resetSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetSelection only calls setters and refs
  }, [currentFolder.id, currentFolder.driveId, sourceUrl]);
  useEffect(() => () => scanController.current?.abort(), []);

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

  // Resolves true when the file was added (or re-ingested), false when it was not.
  async function handleIngestFile(entry: FolderTreeEntry, mode: KbRetrievalMode): Promise<boolean> {
    if (!userId || !entry.downloadUrl || ingestingId || ingestingRef.current) return false;
    // The library comes with the listing (as for a batch); the server needs it to keep one library per knowledge base.
    const driveId = entry.parentDriveId ?? currentFolder.driveId;
    if (!driveId) {
      showToast('Could not tell which SharePoint drive this file is in. Refresh the folder and try again.', 'error');
      return false;
    }
    ingestingRef.current = true;
    setIngestingId(entry.id);
    // Re-ingest = the file was already in the KB but had no stored vectors.
    const reingest = isIngested(entry);
    try {
      const relativePath = currentFolder.path ? `${currentFolder.path}/${entry.name}` : entry.name;
      // An unchanged file is skipped by the ingest and would keep its old mode, so a changed mode is applied to its stored
      // chunks first.
      const docId = reingest ? ingestedDocIdOf(entry) : null;
      if (docId && currentModeOf(entry) !== mode) await setRetrievalMode(docId, mode);
      const result = await ingestFolderItem(entry.name, entry.id, entry.downloadUrl, relativePath, userId, mode === 'always_include' ? 'always_include' : undefined, driveId);
      setAlwaysIncludeSelection((prev) => ({ ...prev, [entry.id]: mode === 'always_include' }));
      setKbListVersion((v) => v + 1);
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
      return true;
    } catch (err) {
      const mismatch = driveMismatchOf(err);
      if (mismatch) {
        // Not a failure: ask first, then do the same again.
        setAddTarget(null);
        askToSwitch(driveId, mismatch, () => handleIngestFile(entry, mode));
        return false;
      }
      showErrorToast(`Failed to ${reingest ? 're-ingest' : 'add'} "${entry.name}" — please try again.`, err);
      return false;
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
      await deleteIngestedDocument(documentPendingRemoval.documentId);
      showToast(`Removed "${documentPendingRemoval.name}" from the knowledge base.`, 'success');
      setKbListVersion((v) => v + 1);
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

  // Lists the source again and reopens the folder the user was in (a re-browse resets to the root).
  async function reloadKeepingFolder(): Promise<void> {
    const url = sourceUrl ?? browseUrl;
    if (!url) return;
    const previousFolder = currentFolder;
    // If the user opens another folder while this runs, theirs wins: only put the old one back when nothing moved meanwhile.
    const navigation = folderNavSeqRef.current;
    const browsed = await handleBrowse(url, { keepFolder: true });
    if (!browsed || navigation !== folderNavSeqRef.current) return;
    if (previousFolder.id && previousFolder.driveId) {
      await navigateToFolder(previousFolder.id, previousFolder.driveId, previousFolder.path, previousFolder.name);
    } else {
      setCenterEntries(lastRootEntries.current);
    }
  }

  function toggleChecked(entry: FolderTreeEntry): void {
    setCheckedIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(entry.id)) next.add(entry.id);
      return next;
    });
  }

  function setChecked(ids: string[], checked: boolean): void {
    setCheckedIds((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  // Turning the option off takes back what was selected below the folders (and stops a scan for it): files the list no longer
  // shows a way to unselect must not stay selected, or be sent.
  function handleIncludeSubfolders(include: boolean): void {
    setIncludeSubfolders(include);
    if (include) return;
    scanSeq.current += 1;
    scanController.current?.abort();
    scanController.current = null;
    setScan(null);
    setFolderSelections(new Map());
  }

  // Drops everything selected, and any scan still running for it.
  function resetSelection(): void {
    scanSeq.current += 1;
    scanController.current?.abort();
    scanController.current = null;
    setScan(null);
    setCheckedIds(new Set());
    setFolderSelections(new Map());
  }

  // Selects (or unselects) everything below some folders. The folders are read one after another, with progress and a cancel; a folder
  // cancelled halfway adds nothing, and one that cannot be read in full says what is missing instead of failing the rest.
  async function setFolderChecked(folders: FolderTreeEntry[], checked: boolean, options?: { onlyNew: boolean }): Promise<void> {
    if (!checked) {
      setFolderSelections((previous) => {
        const next = new Map(previous);
        for (const folder of folders) next.delete(folder.id);
        return next;
      });
      return;
    }
    const todo = folders.filter((folder) => !folderSelections.has(folder.id));
    if (!userId || todo.length === 0 || scanController.current) return;
    const controller = new AbortController();
    scanController.current = controller;
    const mine = scanSeq.current;
    const found = new Map<string, { files: WalkedFile[]; notices: string[] }>();
    let foldersDone = 0;
    let filesDone = 0;
    setScan({ folders: 0, files: 0 });
    try {
      for (const folder of todo) {
        let last = { folders: 0, files: 0 };
        const result = await walkFolders([{ entry: folder, subpath: folder.name }], userId, {
          pathPrefix: currentFolder.path,
          signal: controller.signal,
          onProgress: (progress) => {
            last = progress;
            if (mine === scanSeq.current) setScan({ folders: foldersDone + progress.folders, files: filesDone + progress.files });
          },
        });
        if (mine !== scanSeq.current || result.cancelled) break;
        foldersDone += last.folders;
        const files = options?.onlyNew ? result.files.filter((walked) => !isIngested(walked.entry)) : result.files;
        filesDone += files.length;
        found.set(folder.id, { files, notices: result.partial });
        if (result.expired) {
          showToast('SharePoint access expired during the scan. Reconnect SharePoint, then select again.', 'warning');
          break;
        }
      }
    } finally {
      if (mine === scanSeq.current) {
        scanController.current = null;
        setScan(null);
      }
    }
    if (mine === scanSeq.current && found.size > 0) setFolderSelections((previous) => new Map([...previous, ...found]));
  }

  // What is selected: the files ticked in the folder on show (a folder change clears the ticks, so these are all in it), then the
  // files found below the ticked folders, each with the folder it is in.
  const directlyChecked = (centerEntries ?? []).filter((entry) => checkedIds.has(entry.id) && !entry.isFolder && entry.downloadUrl);
  const selectedFiles = [
    ...directlyChecked.map((entry) => ({ entry, folder: '' })),
    ...[...folderSelections.values()].flatMap((selection) => selection.files.map((walked) => ({ entry: walked.entry, folder: walked.subpath }))),
  ];
  const everyCheckedId = new Set(selectedFiles.map((selected) => selected.entry.id));
  const scanNotices = [...new Set([...folderSelections.values()].flatMap((selection) => selection.notices))];

  async function handleConfirmBatch(choices: { id: string; mode: KbRetrievalMode }[], remember: boolean): Promise<void> {
    if (!userId) return;
    const byId = new Map(selectedFiles.map((selected) => [selected.entry.id, selected]));
    // The drive a file lives in comes with the listing. A knowledge base holds one library, so files from two are not sent.
    const drives = new Set(selectedFiles.map((selected) => selected.entry.parentDriveId).filter(Boolean));
    if (drives.size > 1) {
      showToast('These files are in more than one SharePoint library. A knowledge base holds one library, so add the files of one library at a time.', 'error');
      return;
    }
    // An older backend does not send the drive with each file.
    const driveId = [...drives][0] ?? currentFolder.driveId;
    if (!driveId) {
      showToast('Could not tell which SharePoint drive these files are in. Refresh the folder and try again.', 'error');
      return;
    }
    const items = choices.flatMap(({ id, mode }) => {
      const selected = byId.get(id);
      if (!selected) return [];
      const { entry, folder } = selected;
      const relativePath = [currentFolder.path, folder, entry.name].filter(Boolean).join('/');
      return [{ itemId: entry.id, name: entry.name, relativePath, sizeBytes: entry.sizeBytes, retrievalMode: mode }];
    });
    try {
      await useKbIngestStore.getState().submit(userId, { driveId, folderItemId: currentFolder.id, folderPath: currentFolder.path, docType: null, items });
    } catch (err) {
      const mismatch = driveMismatchOf(err);
      if (mismatch) {
        setBatchDialog(null);
        askToSwitch(driveId, mismatch, () => handleConfirmBatch(choices, remember));
        return;
      }
      showErrorToast('Failed to start the batch — please try again.', err);
      return;
    }
    // Remember the choice most files got (the usual case is one choice for all).
    const reference = choices.filter((c) => c.mode === 'always_include').length;
    if (remember) rememberMode(reference * 2 >= choices.length ? 'always_include' : 'retrieve');
    setBatchDialog(null);
    resetSelection();
    showToast(`Adding ${items.length} ${items.length === 1 ? 'file' : 'files'} in the background. You can leave this page.`, 'success');
  }

  function askToSwitch(driveId: string, mismatch: DriveMismatch, retry: () => Promise<unknown>): void {
    setSwitchError(null);
    setDriveSwitch({ ...mismatch, driveId, retry });
  }

  async function confirmSwitch(): Promise<void> {
    const pending = driveSwitch;
    if (!pending || switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      const result = await switchKbSource(pending.driveId);
      if (result.failed.length > 0) {
        const names = result.failed.map((file) => file.name).join(', ');
        setSwitchError(`Could not remove ${result.failed.length} ${result.failed.length === 1 ? 'file' : 'files'} (${names}). Try again.`);
        return;
      }
    } catch (err) {
      setSwitchError(describeSwitchError(err));
      return;
    } finally {
      setSwitching(false);
    }
    setDriveSwitch(null);
    // Do what the user was doing, then list the folder again so no row still claims a file that was removed.
    await pending.retry();
    await reloadKeepingFolder();
  }

  async function handleReconnect(): Promise<void> {
    if (isReconnectingRef.current) return;
    isReconnectingRef.current = true;
    setIsReconnecting(true);
    setReconnectError(null);
    try {
      const status = await reconnectSharePoint(reconnectToken);
      if (status.status !== 'valid') {
        setReconnectError(reconnectFailureMessage(status.status));
        return;
      }
      showToast('SharePoint reconnected.', 'success');
      setReconnectOpen(false);
      useConnectionStatusStore.getState().record('sharePoint', status);
      // The folder was not readable before (that is why the token was replaced), so the explorer is empty or showing a stale
      // error. Browse it again now rather than leaving that until the user presses Browse, and put them back where they were.
      setBrowseError(null);
      await reloadKeepingFolder();
    } catch {
      setReconnectError(reconnectFailureMessage('error'));
    } finally {
      isReconnectingRef.current = false;
      setIsReconnecting(false);
    }
  }

  const selectedFile = centerEntries?.find((entry) => entry.id === selectedFileId) ?? null;
  const breadcrumbSegments = currentFolder.path ? currentFolder.path.split('/') : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Knowledge base" description="Your reference documents. With AI review jobs you start use them for context. Other users do not see them." />
      <KbIngestedList
        refreshKey={kbListVersion}
        onRemoved={({ removed, failed }) => {
          if (removed > 0) showToast(removed === 1 ? 'Removed 1 file from the knowledge base.' : `Removed ${removed} files from the knowledge base.`, 'success');
          if (failed.length > 0) showToast(`Could not remove ${failed.length === 1 ? `"${failed[0]}"` : `${failed.length} files`}. Try again in a moment.`, 'error');
          // The folder tree marks what is in the knowledge base: read the open folder again so a removed file no longer shows as added.
          setIngestOverrides({});
          void reloadKeepingFolder();
        }}
      />
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
      {ingestBatch && (
        <KbIngestQueue
          batch={ingestBatch}
          error={ingestError}
          busy={ingestBusy}
          onCancel={() => void useKbIngestStore.getState().cancel()}
          onRetryFailed={() => void useKbIngestStore.getState().retryFailed()}
          onResume={() => void useKbIngestStore.getState().resume()}
          onDismiss={() => useKbIngestStore.getState().dismiss()}
          onOpenReport={() => setReportOpen(true)}
        />
      )}
      {browsing || (sourceUrl !== null && !tokenChecked && !rootEntries && !browseError) ? (
        // Loading, or a saved folder waiting for the first status check: never the "nothing browsed" empty state (§12).
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
          {/* Three panes from lg up. Below it they stack: the folder tree is left out (the breadcrumb and the folder rows navigate), the
              list takes the full width, and the details open under it once a file is chosen. */}
          <div className="flex flex-col lg:grid lg:h-[560px] lg:grid-cols-[220px_minmax(0,1fr)_280px] lg:divide-x lg:divide-hairline">
            <div data-testid="kb-folder-tree-pane" className="hidden min-h-0 overflow-y-auto p-2 lg:block">
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
            <div className="flex max-h-[70dvh] min-h-0 flex-col lg:max-h-none">
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
              onIngest={requestAdd}
              onRequestRemove={handleRequestRemove}
              checkedIds={everyCheckedId}
              onToggleChecked={toggleChecked}
              onSetChecked={setChecked}
              onAddChecked={() => setBatchDialog({ remembered: readRememberedMode() })}
              onClearChecked={resetSelection}
              includeSubfolders={includeSubfolders}
              onIncludeSubfoldersChange={handleIncludeSubfolders}
              checkedFolderIds={new Set(folderSelections.keys())}
              onSetFolderChecked={(folders, checked, options) => void setFolderChecked(folders, checked, options)}
              scan={scan}
              onCancelScan={() => scanController.current?.abort()}
            />
            </div>
            <div data-testid="kb-detail-pane" className={`min-h-0 overflow-y-auto border-t border-hairline lg:block lg:border-t-0 ${selectedFile ? '' : 'hidden'}`}>
              <KbFileDetailPane
                entry={selectedFile}
                ingested={selectedFile ? isIngested(selectedFile) : false}
                chunkCount={selectedFile ? chunkCountOf(selectedFile) : null}
                isIngesting={selectedFile ? ingestingId === selectedFile.id : false}
                alwaysInclude={selectedFile ? isAlwaysInclude(selectedFile) : false}
                isUpdatingMode={selectedFile ? modeUpdatingId === selectedFile.id : false}
                onToggleAlwaysInclude={(value) => selectedFile && handleToggleAlwaysInclude(selectedFile, value)}
                onIngest={() => selectedFile && requestAdd(selectedFile)}
                onRequestRemove={() => selectedFile && handleRequestRemove(selectedFile)}
              />
            </div>
          </div>
        </Card>
      ) : (
        <EmptyState
          icon={FolderTree}
          title="No folder browsed yet"
          description="Paste a SharePoint or OneDrive folder link above to see its contents — add or remove any file directly from the tree."
        />
      )}
      {driveSwitch && (
        <KbSwitchLibraryDialog
          open
          onOpenChange={(open) => !open && !switching && setDriveSwitch(null)}
          otherDrive={driveSwitch.otherDrive}
          unknownDrive={driveSwitch.unknownDrive}
          isWorking={switching}
          errorMessage={switchError}
          onConfirm={() => void confirmSwitch()}
        />
      )}
      {batchDialog && (
        <KbAddBatchDialog
          open
          onOpenChange={(open) => !open && !ingestBusy && setBatchDialog(null)}
          files={selectedFiles.map(({ entry, folder }) => ({ id: entry.id, name: entry.name, sizeBytes: entry.sizeBytes, currentMode: currentModeOf(entry), folder }))}
          scanNotices={scanNotices}
          rememberedMode={batchDialog.remembered}
          isSubmitting={ingestBusy}
          onConfirm={(choices, remember) => void handleConfirmBatch(choices, remember)}
        />
      )}
      {addTarget && (
        <KbAddDialog
          open
          onOpenChange={(open) => {
            // Closing while the request is being sent would hide its outcome; it closes itself when done.
            if (!open && ingestingId !== addTarget.entry.id) setAddTarget(null);
          }}
          file={{ name: addTarget.entry.name, sizeBytes: addTarget.entry.sizeBytes }}
          currentMode={currentModeOf(addTarget.entry)}
          rememberedMode={addTarget.remembered}
          isSubmitting={ingestingId === addTarget.entry.id}
          onConfirm={(mode, remember) => void handleConfirmAdd(addTarget.entry, mode, remember)}
        />
      )}
      <Dialog
        open={reconnectOpen}
        onOpenChange={setReconnectOpen}
        title="Reconnect SharePoint"
        description={SHAREPOINT_TOKEN_DIALOG_DESCRIPTION}
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
        <SharePointTokenHelp />
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
            <strong>
              <bdi dir="auto">{documentPendingRemoval?.name}</bdi>
            </strong>{' '}
            will no longer be judged against or cited by With AI review jobs. This deletes its
            stored content and cannot be undone — add it again from the tree if you need it back.
          </>
        }
        confirmLabel="Remove document"
        onConfirm={handleRemoveDocument}
        isConfirming={isRemoving}
        variant="destructive"
      />
      <KbHealthSummary rubric={rubric} hasReport={!!ingestBatch && isBatchStatusFinished(ingestBatch.status)} onViewReport={() => setReportOpen(true)} onCustomizeRubric={() => setRubricOpen(true)} />
      {ingestBatch && isBatchStatusFinished(ingestBatch.status) && (
        <KbIngestReport open={reportOpen} onOpenChange={setReportOpen} batch={ingestBatch} rubric={rubric} onCustomizeRubric={() => setRubricOpen(true)} />
      )}
      <RubricDialog open={rubricOpen} onOpenChange={setRubricOpen} />
    </div>
  );
}
