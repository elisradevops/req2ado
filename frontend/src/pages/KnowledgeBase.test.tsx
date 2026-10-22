import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError } from 'axios';
import { KnowledgeBase } from './KnowledgeBase';
import { ToastProvider } from '../components/ToastProvider';
import * as kbApi from '../api/kb';
import type { FolderTreeEntry } from '../api/kb';
import { useAuthStore } from '../store/authStore';

vi.mock('../api/kb');

function renderPage(): void {
  useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
  render(
    <ToastProvider>
      <KnowledgeBase />
    </ToastProvider>,
  );
}

describe('KnowledgeBase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(kbApi, 'getRubric').mockResolvedValue({
      version: 'v1', source: 'kb', builtAt: null, removed: [],
      categories: [{ name: 'Testable', passCondition: 'Can be verified', guidance: null, pinned: false, origin: 'kb', sources: ['A.pptx'], mergedFrom: ['Testable'] }],
    });
    localStorage.clear();
  });

  it('shows the quality rubric the user\'s jobs are graded against, next to the documents it comes from', async () => {
    renderPage();
    expect(await screen.findByText('Quality rubric')).toBeInTheDocument();
    expect(await screen.findByLabelText('Pass condition of Testable')).toHaveValue('Can be verified');
    expect(kbApi.getRubric).toHaveBeenCalledTimes(1);
  });

  it('does not render a bearer-token / password field on initial load', async () => {
    renderPage();
    await waitFor(() => expect(kbApi.getSharePointStatus).toHaveBeenCalled());
    expect(screen.queryByLabelText(/token/i)).toBeNull();
  });

  it('shows an empty-state prompt before anything has been browsed', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/no folder browsed yet/i)).toBeInTheDocument());
  });

  it('browses a shared folder, showing files and subfolders in a tree', async () => {
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
      { id: 'f1', name: 'spec.docx', mimeType: 'application/vnd.openxmlformats', sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: true, ingestedDocumentId: 'doc-1', downloadUrl: null },
      { id: 'd1', name: 'Subfolder', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
    ]);
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));

    await waitFor(() => expect(kbApi.browseSharedFolder).toHaveBeenCalledWith('https://share.example/folder', 'user-descriptor-1'));
    await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());
    // "Subfolder" now legitimately appears twice -- once as a left-pane
    // navigation row, once as a center-pane row inside its parent folder
    // (the three-pane explorer, DESIGN.md Track B phase B10).
    expect(screen.getAllByText('Subfolder').length).toBeGreaterThan(0);
  });

  it('restores and re-browses the last folder URL on mount, instead of showing an empty tree', async () => {
    // Regression: the browse tree used to be 100% in-memory state -- leaving
    // the page or refreshing always required re-pasting the URL and
    // clicking Browse again, which read as "the tree cleared / did the
    // ingest even work?" even though the underlying documents were fine.
    localStorage.setItem('req2ado-kb-browse-url', 'https://share.example/remembered');
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
      { id: 'f1', name: 'remembered.docx', mimeType: 'application/vnd.openxmlformats', sizeBytes: 1024, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
    ]);

    renderPage();

    await waitFor(() => expect(kbApi.browseSharedFolder).toHaveBeenCalledWith('https://share.example/remembered', 'user-descriptor-1'));
    await waitFor(() => expect(screen.getByText('remembered.docx')).toBeInTheDocument());
    expect(screen.getByLabelText(/sharing url/i)).toHaveValue('https://share.example/remembered');
  });

  it('does not auto-browse on mount when no folder URL was previously saved', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/no folder browsed yet/i)).toBeInTheDocument());
    expect(kbApi.browseSharedFolder).not.toHaveBeenCalled();
  });

  it('shows a browse error without a stale tree', async () => {
    vi.spyOn(kbApi, 'browseSharedFolder').mockRejectedValue(new Error('boom'));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));

    await waitFor(() => expect(screen.getByText(/ingest failed — check the sharing link and try again/i)).toBeInTheDocument());
  });

  it('shows a clear "SharePoint token expired" message for a 424 -- not a generic error, and not a session logout', async () => {
    // Regression guard for a confirmed real bug (user-reported: "why am I
    // getting logged out when I try to access the Knowledge Base page?"):
    // a real, expected SharePoint-token expiry (~1h TTL) used to reach the
    // frontend as a bare 401, which httpClient.ts's global interceptor
    // treats as "your orchestrator session died" -- logging the user out
    // of the WHOLE APP over an unrelated downstream token expiry. The
    // orchestrator now remaps that specific case to 424 (Failed
    // Dependency, see kb.controller.ts's mapIngestionErrorStatus); this
    // page must render the real, actionable copy for it instead of the
    // generic fallback.
    const error = new AxiosError('Request failed', '424');
    error.response = { status: 424, data: {}, statusText: '', headers: {}, config: {} as never };
    vi.spyOn(kbApi, 'browseSharedFolder').mockRejectedValue(error);
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));

    await waitFor(() => expect(screen.getByText(/sharepoint access token has expired or is invalid/i)).toBeInTheDocument());
  });

  it('shows a distinct message for an empty folder', async () => {
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([]);
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/empty');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));

    await waitFor(() => expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument());
  });

  it('adds a not-yet-ingested file straight from the tree', async () => {
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
      { id: 'f1', name: 'spec.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: 'https://graph.example/download/f1' },
    ]);
    vi.spyOn(kbApi, 'ingestFolderItem').mockResolvedValue({
      documentName: 'spec.docx',
      driveitemId: 'f1',
      mimeType: null,
      sizeBytes: 2048,
      chunksStored: 3,
      skippedUnchanged: false,
      ingestedDocumentId: 'doc-1',
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
    await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));

    await waitFor(() =>
      expect(kbApi.ingestFolderItem).toHaveBeenCalledWith(
        'spec.docx', 'f1', 'https://graph.example/download/f1', 'spec.docx', 'user-descriptor-1', undefined,
      ),
    );
    await waitFor(() => expect(screen.getByText(/added "spec\.docx" to the knowledge base/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /remove spec\.docx from the knowledge base/i })).toBeInTheDocument();
  });

  it('removes an already-ingested file from the tree after confirming', async () => {
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
      { id: 'f1', name: 'spec.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: true, ingestedDocumentId: 'doc-1', downloadUrl: null },
    ]);
    vi.spyOn(kbApi, 'deleteIngestedDocument').mockResolvedValue(undefined);
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
    await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /remove spec\.docx from the knowledge base/i }));
    await userEvent.click(screen.getByRole('button', { name: /remove document/i }));

    await waitFor(() => expect(kbApi.deleteIngestedDocument).toHaveBeenCalledWith('doc-1', 'user-descriptor-1'));
    await waitFor(() => expect(screen.getByText(/removed "spec\.docx"/i)).toBeInTheDocument());
  });

  it('shows an error toast and keeps the confirm dialog open when removal fails', async () => {
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
      { id: 'f1', name: 'spec.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: true, ingestedDocumentId: 'doc-1', downloadUrl: null },
    ]);
    vi.spyOn(kbApi, 'deleteIngestedDocument').mockRejectedValue(new Error('boom'));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
    await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /remove spec\.docx from the knowledge base/i }));
    await userEvent.click(screen.getByRole('button', { name: /remove document/i }));

    await waitFor(() => expect(screen.getByText(/failed to remove the document/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /remove document/i })).toBeInTheDocument();
  });

  it('shows the SharePoint status strip and reconnects with a new token', async () => {
    vi.mocked(kbApi.getSharePointStatus).mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
    vi.spyOn(kbApi, 'reconnectSharePoint').mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 });
    renderPage();

    await waitFor(() => expect(screen.getByText(/token invalid/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    await userEvent.type(screen.getByLabelText(/sharepoint access token/i), 'new-token');
    await userEvent.click(screen.getAllByRole('button', { name: /^reconnect$/i }).at(-1)!);

    await waitFor(() => expect(kbApi.reconnectSharePoint).toHaveBeenCalledWith('new-token'));
    await waitFor(() => expect(screen.getByText(/sharepoint reconnected/i)).toBeInTheDocument());
  });

  it('shows an inline error when reconnect rejects the token', async () => {
    vi.spyOn(kbApi, 'reconnectSharePoint').mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
    renderPage();

    await waitFor(() => expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    await userEvent.type(screen.getByLabelText(/sharepoint access token/i), 'bad-token');
    await userEvent.click(screen.getAllByRole('button', { name: /^reconnect$/i }).at(-1)!);

    await waitFor(() => expect(screen.getByText(/sharepoint rejected that token/i)).toBeInTheDocument());
  });

  describe('three-pane explorer (DESIGN.md Track B, phase B10)', () => {
    it('navigates into a subfolder from the center pane and shows its own children there', async () => {
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'd1', name: 'Subfolder', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
      ]);
      vi.spyOn(kbApi, 'browseSubfolder').mockResolvedValue([
        { id: 'f2', name: 'nested.pdf', mimeType: null, sizeBytes: 4096, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: 'https://graph.example/download/f2' },
      ]);
      renderPage();

      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getAllByText('Subfolder').length).toBeGreaterThan(0));

      // Click the CENTER-pane row (not the left-tree nav row) -- both render
      // "Subfolder" text. The left tree's row is a <div role="button">, so
      // only the center pane's match resolves a real ancestor <tr>.
      const centerRow = screen.getAllByText('Subfolder').map((el) => el.closest('tr')).find(Boolean);
      await userEvent.click(centerRow!);

      await waitFor(() => expect(kbApi.browseSubfolder).toHaveBeenCalledWith('drive-1', 'd1', 'user-descriptor-1', 'Subfolder'));
      await waitFor(() => expect(screen.getByText('nested.pdf')).toBeInTheDocument());
    });

    it('selects a file and shows its metadata in the right-hand detail pane', async () => {
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'f1', name: 'spec.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: 'https://graph.example/download/f1' },
      ]);
      renderPage();

      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());

      expect(screen.getByText(/no file selected/i)).toBeInTheDocument();

      await userEvent.click(screen.getByText('spec.docx').closest('tr')!);

      await waitFor(() => expect(screen.queryByText(/no file selected/i)).not.toBeInTheDocument());
      // "2.0 KB" now appears twice -- the center-pane row's own Size column,
      // plus the detail pane's own Size field.
      expect(screen.getAllByText('2.0 KB').length).toBeGreaterThan(1);
      expect(screen.getByRole('button', { name: /add to knowledge base/i })).toBeInTheDocument();
    });

    it('keeps the detail pane in sync after ingesting a file from the center-pane row action', async () => {
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'f1', name: 'spec.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: 'https://graph.example/download/f1' },
      ]);
      vi.spyOn(kbApi, 'ingestFolderItem').mockResolvedValue({
        documentName: 'spec.docx', driveitemId: 'f1', mimeType: null, sizeBytes: 2048, chunksStored: 3, skippedUnchanged: false, ingestedDocumentId: 'doc-1',
      });
      renderPage();

      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());

      await userEvent.click(screen.getByText('spec.docx').closest('tr')!);
      await waitFor(() => expect(screen.getByRole('button', { name: /add to knowledge base/i })).toBeInTheDocument());

      // The row action (not the detail pane's own button) is what ingests here.
      await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /remove from knowledge base/i })).toBeInTheDocument());
    });

    it('ingests with retrievalMode="always_include" when the detail pane checkbox is checked', async () => {
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'f1', name: 'standards.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: 'https://graph.example/download/f1' },
      ]);
      vi.spyOn(kbApi, 'ingestFolderItem').mockResolvedValue({
        documentName: 'standards.docx', driveitemId: 'f1', mimeType: null, sizeBytes: 2048, chunksStored: 3, skippedUnchanged: false, ingestedDocumentId: 'doc-1',
      });
      renderPage();

      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getByText('standards.docx')).toBeInTheDocument());

      await userEvent.click(screen.getByText('standards.docx').closest('tr')!);
      await userEvent.click(screen.getByRole('checkbox', { name: /always include \(full context\)/i }));
      await userEvent.click(screen.getByRole('button', { name: /^add to knowledge base$/i }));

      await waitFor(() =>
        expect(kbApi.ingestFolderItem).toHaveBeenCalledWith(
          'standards.docx', 'f1', 'https://graph.example/download/f1', 'standards.docx', 'user-descriptor-1', 'always_include',
        ),
      );
    });

    it('returns to the root folder via the center pane\'s "Root" breadcrumb', async () => {
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'd1', name: 'Subfolder', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
      ]);
      vi.spyOn(kbApi, 'browseSubfolder').mockResolvedValue([
        { id: 'f2', name: 'nested.pdf', mimeType: null, sizeBytes: 4096, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
      ]);
      renderPage();

      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getAllByText('Subfolder').length).toBeGreaterThan(0));
      const centerRow = screen.getAllByText('Subfolder').map((el) => el.closest('tr')).find(Boolean);
      await userEvent.click(centerRow!);
      await waitFor(() => expect(screen.getByText('nested.pdf')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: /^root$/i }));

      await waitFor(() => expect(screen.queryByText('nested.pdf')).not.toBeInTheDocument());
      expect(screen.getAllByText('Subfolder').length).toBeGreaterThan(0);
    });
  });

  // Regression guards for SWEEP.md: 4 backend-mutation handlers had no
  // synchronous re-entry guard (only a `disabled` prop, which doesn't
  // commit to the DOM until React's next render -- a truly rapid second
  // click/action can still slip through before that commit), plus a
  // stale-response race in navigateToFolder.
  describe('re-entry guards and stale-response guard (SWEEP.md)', () => {
    it('handleBrowse: a rapid second click before the first browse resolves does not fire a second request', async () => {
      let resolveBrowse!: (entries: FolderTreeEntry[]) => void;
      const deferred = new Promise<FolderTreeEntry[]>((resolve) => {
        resolveBrowse = resolve;
      });
      vi.spyOn(kbApi, 'browseSharedFolder').mockReturnValue(deferred);
      renderPage();

      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      const browseButton = screen.getByRole('button', { name: /^browse$/i });

      // Both clicks inside ONE outer act() -- React defers the resulting
      // DOM commit (the `disabled` attribute from setBrowsing(true)) until
      // this whole act() callback returns, so the second click still lands
      // on a not-yet-disabled button, same as two clicks in the same tick
      // in a real browser. Only the new browsingRef guard (not the disabled
      // prop, which hasn't committed yet) can catch this.
      act(() => {
        fireEvent.click(browseButton);
        fireEvent.click(browseButton);
      });

      await act(async () => {
        resolveBrowse([]);
        await Promise.resolve();
      });

      await waitFor(() => expect(browseButton).not.toBeDisabled());
      expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(1);
    });

    it('handleIngestFile: a rapid second click on the same row before ingest resolves does not fire a second request', async () => {
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'f1', name: 'spec.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: 'https://graph.example/download/f1' },
      ]);
      let resolveIngest!: (result: Awaited<ReturnType<typeof kbApi.ingestFolderItem>>) => void;
      const deferred = new Promise<Awaited<ReturnType<typeof kbApi.ingestFolderItem>>>((resolve) => {
        resolveIngest = resolve;
      });
      vi.spyOn(kbApi, 'ingestFolderItem').mockReturnValue(deferred);
      renderPage();

      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());

      const ingestButton = screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i });
      // Both clicks inside ONE outer act() -- see handleBrowse's own test
      // above for why this is what actually forces the re-entry race.
      act(() => {
        fireEvent.click(ingestButton);
        fireEvent.click(ingestButton);
      });

      await act(async () => {
        resolveIngest({
          documentName: 'spec.docx',
          driveitemId: 'f1',
          mimeType: null,
          sizeBytes: 2048,
          chunksStored: 3,
          skippedUnchanged: false,
          ingestedDocumentId: 'doc-1',
        });
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getByRole('button', { name: /remove spec\.docx from the knowledge base/i })).toBeInTheDocument());
      expect(kbApi.ingestFolderItem).toHaveBeenCalledTimes(1);
    });

    it('handleRemoveDocument: a rapid second confirm click before removal resolves does not fire a second request', async () => {
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'f1', name: 'spec.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: true, ingestedDocumentId: 'doc-1', downloadUrl: null },
      ]);
      let resolveRemove!: () => void;
      const deferred = new Promise<void>((resolve) => {
        resolveRemove = resolve;
      });
      vi.spyOn(kbApi, 'deleteIngestedDocument').mockReturnValue(deferred);
      renderPage();

      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: /remove spec\.docx from the knowledge base/i }));
      const confirmButton = screen.getByRole('button', { name: /remove document/i });
      // Both clicks inside ONE outer act() -- see handleBrowse's own test
      // above for why this is what actually forces the re-entry race.
      act(() => {
        fireEvent.click(confirmButton);
        fireEvent.click(confirmButton);
      });

      await act(async () => {
        resolveRemove();
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getByText(/removed "spec\.docx"/i)).toBeInTheDocument());
      expect(kbApi.deleteIngestedDocument).toHaveBeenCalledTimes(1);
    });

    it('handleReconnect: a rapid second click before reconnect resolves does not fire a second request', async () => {
      let resolveReconnect!: (status: Awaited<ReturnType<typeof kbApi.reconnectSharePoint>>) => void;
      const deferred = new Promise<Awaited<ReturnType<typeof kbApi.reconnectSharePoint>>>((resolve) => {
        resolveReconnect = resolve;
      });
      vi.spyOn(kbApi, 'reconnectSharePoint').mockReturnValue(deferred);
      renderPage();

      await waitFor(() => expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
      await userEvent.type(screen.getByLabelText(/sharepoint access token/i), 'new-token');
      const confirmButton = screen.getAllByRole('button', { name: /^reconnect$/i }).at(-1)!;
      // Both clicks inside ONE outer act() -- see handleBrowse's own test
      // above for why this is what actually forces the re-entry race.
      act(() => {
        fireEvent.click(confirmButton);
        fireEvent.click(confirmButton);
      });

      await act(async () => {
        resolveReconnect({ status: 'valid', expiresInSeconds: 3600 });
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getByText(/sharepoint reconnected/i)).toBeInTheDocument());
      expect(kbApi.reconnectSharePoint).toHaveBeenCalledTimes(1);
    });

    it("navigateToFolder: a slower response for an earlier click cannot overwrite a faster later click's already-shown contents", async () => {
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'a1', name: 'FolderA', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-a', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
        { id: 'b1', name: 'FolderB', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-b', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
      ]);

      let resolveA!: (entries: FolderTreeEntry[]) => void;
      const aPromise = new Promise<FolderTreeEntry[]>((resolve) => {
        resolveA = resolve;
      });
      const bEntries: FolderTreeEntry[] = [
        { id: 'b-nested', name: 'b-nested.pdf', mimeType: null, sizeBytes: 100, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
      ];
      vi.spyOn(kbApi, 'browseSubfolder').mockImplementation((_driveId, itemId) => (itemId === 'a1' ? aPromise : Promise.resolve(bEntries)));

      renderPage();
      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getAllByText('FolderA').length).toBeGreaterThan(0));

      // Click FolderA's CENTER-pane row first -- fires the slower, still-
      // pending browseSubfolder('drive-a', 'a1', ...) request.
      const folderARow = screen.getAllByText('FolderA').map((el) => el.closest('tr')).find(Boolean);
      await userEvent.click(folderARow!);

      // Before A resolves, click FolderB from the LEFT tree (its row
      // survives the center pane switching to its loading skeleton, unlike
      // FolderB's own center-pane <tr>) -- fires a second, faster request
      // that resolves and paints B's contents first.
      const folderBTreeRow = screen.getByText('FolderB').closest('[role="button"]');
      await userEvent.click(folderBTreeRow!);

      await waitFor(() => expect(screen.getByText('b-nested.pdf')).toBeInTheDocument());
      const folderNav = screen.getByRole('navigation', { name: /folder/i });
      expect(folderNav).toHaveTextContent('FolderB');

      // Now let A's slower response resolve LAST -- it must not repaint the
      // center pane, or its breadcrumb, out from under B's already-shown state.
      await act(async () => {
        resolveA([
          { id: 'a-nested', name: 'a-nested.pdf', mimeType: null, sizeBytes: 100, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
        ]);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByText('a-nested.pdf')).toBeNull();
      expect(screen.getByText('b-nested.pdf')).toBeInTheDocument();
      expect(folderNav).toHaveTextContent('FolderB');
    });

    it('handleNavigateRoot: a slower in-flight subfolder response cannot overwrite the Root breadcrumb after navigating back to Root', async () => {
      // Same race as the navigateToFolder test above, but the second writer
      // is handleNavigateRoot (the "Root" breadcrumb) rather than a second
      // navigateToFolder call -- both writers share folderNavSeqRef, so
      // navigating to Root must invalidate the still-pending subfolder
      // request the same way a second folder click already does.
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
        { id: 'd1', name: 'Subfolder', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
      ]);

      let resolveSubfolder!: (entries: FolderTreeEntry[]) => void;
      const subfolderPromise = new Promise<FolderTreeEntry[]>((resolve) => {
        resolveSubfolder = resolve;
      });
      vi.spyOn(kbApi, 'browseSubfolder').mockReturnValue(subfolderPromise);

      renderPage();
      await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
      await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
      await waitFor(() => expect(screen.getAllByText('Subfolder').length).toBeGreaterThan(0));

      // Click into the subfolder -- fires the slow, still-pending request.
      const centerRow = screen.getAllByText('Subfolder').map((el) => el.closest('tr')).find(Boolean);
      await userEvent.click(centerRow!);

      // Before the subfolder response resolves, click "Root".
      await userEvent.click(screen.getByRole('button', { name: /^root$/i }));

      const folderNav = screen.getByRole('navigation', { name: /folder/i });
      expect(folderNav).toHaveTextContent(/root/i);
      expect(screen.getAllByText('Subfolder').length).toBeGreaterThan(0);

      // Now let the subfolder's slow response resolve LAST -- it must not
      // repaint the center pane or its breadcrumb out from under Root's
      // already-shown state.
      await act(async () => {
        resolveSubfolder([
          { id: 'nested', name: 'nested.pdf', mimeType: null, sizeBytes: 100, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null },
        ]);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByText('nested.pdf')).toBeNull();
      expect(folderNav).toHaveTextContent(/root/i);
      expect(screen.getAllByText('Subfolder').length).toBeGreaterThan(0);
    });
  });
});
