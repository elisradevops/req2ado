import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
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

// Every way of adding a file now opens the "Add to knowledge base" dialog first. Picks how jobs use the file (null = keep what the
// dialog preselected, as for a file already in the knowledge base) and confirms.
async function chooseAndConfirm(choice: 'search' | 'reference' | null, confirm: RegExp = /^add to knowledge base$/i): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  if (choice) await userEvent.click(within(dialog).getByRole('radio', { name: choice === 'search' ? /^search/i : /^reference/i }));
  await userEvent.click(within(dialog).getByRole('button', { name: confirm }));
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
    // The saved source is shown in the source bar; the URL form only appears under Change.
    expect(screen.queryByLabelText(/sharing url/i)).toBeNull();
    expect(screen.getByText('https://share.example/remembered')).toBeInTheDocument();
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
    await chooseAndConfirm('search');

    await waitFor(() =>
      expect(kbApi.ingestFolderItem).toHaveBeenCalledWith(
        'spec.docx', 'f1', 'https://graph.example/download/f1', 'spec.docx', 'user-descriptor-1', undefined,
      ),
    );
    await waitFor(() => expect(screen.getByText(/added "spec\.docx" to the knowledge base/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /remove spec\.docx from the knowledge base/i })).toBeInTheDocument();
  });

  async function browseWith(entries: Partial<FolderTreeEntry>[]): Promise<void> {
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue(
      entries.map((e, i) => ({
        id: `f${i + 1}`, name: `file${i + 1}.pdf`, mimeType: null, sizeBytes: 1024, isFolder: false, driveId: null,
        alreadyIngested: true, ingestedDocumentId: `doc-${i + 1}`, downloadUrl: 'https://graph.example/d', ...e,
      })) as FolderTreeEntry[],
    );
    renderPage();
    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
    await waitFor(() => expect(screen.getByText('file1.pdf')).toBeInTheDocument());
  }

  it('flags an ingested file that has no stored vectors and offers re-ingest', async () => {
    await browseWith([{ chunkCount: 0 }]);
    expect(screen.getByText('No vectors')).toBeInTheDocument();
    expect(screen.queryByText('In knowledge base')).toBeNull();
    expect(screen.getByRole('button', { name: /re-ingest file1\.pdf/i })).toBeInTheDocument();
  });

  it('shows the stored chunk count for an ingested file with vectors', async () => {
    await browseWith([{ chunkCount: 32 }]);
    expect(screen.getByText('In knowledge base · 32 chunks')).toBeInTheDocument();
    expect(screen.queryByText('No vectors')).toBeNull();
  });

  it('keeps the plain status when the chunk count is unknown', async () => {
    await browseWith([{ chunkCount: null }]);
    expect(screen.getByText('In knowledge base')).toBeInTheDocument();
  });

  it('re-ingesting a no-vectors file clears the warning', async () => {
    vi.spyOn(kbApi, 'ingestFolderItem').mockResolvedValue({
      documentName: 'file1.pdf', driveitemId: 'f1', mimeType: null, sizeBytes: 1024,
      chunksStored: 12, chunksInStore: 12, skippedUnchanged: false, ingestedDocumentId: 'doc-1',
    });
    await browseWith([{ chunkCount: 0 }]);

    await userEvent.click(screen.getByRole('button', { name: /re-ingest file1\.pdf/i }));
    await chooseAndConfirm(null, /^re-ingest$/i);

    await waitFor(() => expect(screen.getByText('In knowledge base · 12 chunks')).toBeInTheDocument());
    expect(screen.queryByText('No vectors')).toBeNull();
    expect(screen.getByText(/re-ingested "file1\.pdf"\./i)).toBeInTheDocument();
  });

  it('keeps "No vectors" when a re-ingest stores nothing (still zero chunks in the store)', async () => {
    vi.spyOn(kbApi, 'ingestFolderItem').mockResolvedValue({
      documentName: 'file1.pdf', driveitemId: 'f1', mimeType: null, sizeBytes: 1024,
      chunksStored: 0, chunksInStore: 0, skippedUnchanged: false, ingestedDocumentId: 'doc-1',
    });
    await browseWith([{ chunkCount: 0 }]);

    await userEvent.click(screen.getByRole('button', { name: /re-ingest file1\.pdf/i }));
    await chooseAndConfirm(null, /^re-ingest$/i);

    await waitFor(() => expect(kbApi.ingestFolderItem).toHaveBeenCalled());
    expect(await screen.findByText('No vectors')).toBeInTheDocument();
    expect(await screen.findByText(/re-ingested "file1\.pdf", but no text could be stored/i)).toBeInTheDocument();
    expect(screen.queryByText(/added "file1\.pdf"/i)).toBeNull();
  });

  it('shows the stored count after a skipped-unchanged re-ingest', async () => {
    vi.spyOn(kbApi, 'ingestFolderItem').mockResolvedValue({
      documentName: 'file1.pdf', driveitemId: 'f1', mimeType: null, sizeBytes: 1024,
      chunksStored: 0, chunksInStore: 7, skippedUnchanged: true, ingestedDocumentId: 'doc-1',
    });
    await browseWith([{ chunkCount: 0 }]);

    await userEvent.click(screen.getByRole('button', { name: /re-ingest file1\.pdf/i }));
    await chooseAndConfirm(null, /^re-ingest$/i);

    expect(await screen.findByText('In knowledge base · 7 chunks')).toBeInTheDocument();
  });

  it('re-ingest preserves an always-include retrieval mode', async () => {
    vi.spyOn(kbApi, 'ingestFolderItem').mockResolvedValue({
      documentName: 'file1.pdf', driveitemId: 'f1', mimeType: null, sizeBytes: 1024,
      chunksStored: 3, chunksInStore: 3, skippedUnchanged: false, ingestedDocumentId: 'doc-1',
    });
    await browseWith([{ chunkCount: 0, retrievalMode: 'always_include' }]);

    await userEvent.click(screen.getByRole('button', { name: /re-ingest file1\.pdf/i }));
    await chooseAndConfirm(null, /^re-ingest$/i);

    await waitFor(() =>
      expect(kbApi.ingestFolderItem).toHaveBeenCalledWith(
        'file1.pdf', 'f1', 'https://graph.example/d', 'file1.pdf', 'user-descriptor-1', 'always_include',
      ),
    );
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
      await chooseAndConfirm('search');

      await waitFor(() => expect(screen.getByRole('button', { name: /remove from knowledge base/i })).toBeInTheDocument());
    });

    it('ingests with retrievalMode="always_include" when Reference is chosen in the add dialog', async () => {
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
      await userEvent.click(screen.getByRole('button', { name: /^add to knowledge base$/i }));
      await chooseAndConfirm('reference');

      await waitFor(() =>
        expect(kbApi.ingestFolderItem).toHaveBeenCalledWith(
          'standards.docx', 'f1', 'https://graph.example/download/f1', 'standards.docx', 'user-descriptor-1', 'always_include',
        ),
      );
    });

    describe('re-ingesting a file that already has stored vectors', () => {
      async function openIngestedFile(retrievalMode: string | null) {
        vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
          { id: 'f1', name: 'guide.pptx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: true, ingestedDocumentId: 'doc-1', downloadUrl: 'https://graph.example/download/f1', chunkCount: 11, retrievalMode },
        ]);
        renderPage();
        await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
        await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
        await waitFor(() => expect(screen.getByText('guide.pptx')).toBeInTheDocument());
        await userEvent.click(screen.getByText('guide.pptx').closest('tr')!);
      }

      it('offers "Re-ingest file" in the detail pane so a parser fix can reach it', async () => {
        await openIngestedFile(null);

        expect(await screen.findByRole('button', { name: /^re-ingest file$/i })).toBeInTheDocument();
      });

      it('keeps an always-include file in always-include mode when re-ingesting it', async () => {
        vi.spyOn(kbApi, 'ingestFolderItem').mockResolvedValue({
          documentName: 'guide.pptx', driveitemId: 'f1', mimeType: null, sizeBytes: 2048, chunksStored: 12, chunksInStore: 12, skippedUnchanged: false, ingestedDocumentId: 'doc-1',
        });
        await openIngestedFile('always_include');

        await userEvent.click(await screen.findByRole('button', { name: /^re-ingest file$/i }));
        await chooseAndConfirm(null, /^re-ingest$/i);

        await waitFor(() =>
          expect(kbApi.ingestFolderItem).toHaveBeenCalledWith(
            'guide.pptx', 'f1', 'https://graph.example/download/f1', 'guide.pptx', 'user-descriptor-1', 'always_include',
          ),
        );
      });
    });

    describe('switching the retrieval mode of an already-ingested file', () => {
      async function openIngestedFile(retrievalMode: string | null) {
        vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([
          { id: 'f1', name: 'guide.pptx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: true, ingestedDocumentId: 'doc-1', downloadUrl: 'https://graph.example/download/f1', retrievalMode },
        ]);
        renderPage();
        await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
        await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));
        await waitFor(() => expect(screen.getByText('guide.pptx')).toBeInTheDocument());
        await userEvent.click(screen.getByText('guide.pptx').closest('tr')!);
        return screen.findByRole('switch', { name: /reference \(always include\)/i });
      }

      it('shows the stored mode and switches it on without re-ingesting', async () => {
        vi.spyOn(kbApi, 'setRetrievalMode').mockResolvedValue(undefined);
        vi.spyOn(kbApi, 'ingestFolderItem');
        const checkbox = await openIngestedFile(null);
        expect(checkbox).not.toBeChecked();

        await userEvent.click(checkbox);

        await waitFor(() => expect(kbApi.setRetrievalMode).toHaveBeenCalledWith('doc-1', 'always_include'));
        await waitFor(() => expect(checkbox).toBeChecked());
        expect(kbApi.ingestFolderItem).not.toHaveBeenCalled();
      });

      it('switches an always-include file back to retrieve', async () => {
        vi.spyOn(kbApi, 'setRetrievalMode').mockResolvedValue(undefined);
        const checkbox = await openIngestedFile('always_include');
        expect(checkbox).toBeChecked();

        await userEvent.click(checkbox);

        await waitFor(() => expect(kbApi.setRetrievalMode).toHaveBeenCalledWith('doc-1', 'retrieve'));
        await waitFor(() => expect(checkbox).not.toBeChecked());
      });

      it('leaves the checkbox unchanged when the update fails', async () => {
        vi.spyOn(kbApi, 'setRetrievalMode').mockRejectedValue(new Error('boom'));
        const checkbox = await openIngestedFile(null);

        await userEvent.click(checkbox);

        await waitFor(() => expect(kbApi.setRetrievalMode).toHaveBeenCalled());
        expect(checkbox).not.toBeChecked();
      });
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

      // The browse succeeded, so the URL form has collapsed into the source bar, whose Refresh is available again.
      await waitFor(() => expect(screen.getByRole('button', { name: /^refresh$/i })).not.toBeDisabled());
      expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(1);
    });

    it('handleIngestFile: a rapid second click on the dialog\'s Add button before ingest resolves does not fire a second request', async () => {
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

      await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('radio', { name: /^search/i }));
      const addButton = within(dialog).getByRole('button', { name: /^add to knowledge base$/i });
      // Both clicks inside ONE outer act() -- see handleBrowse's own test
      // above for why this is what actually forces the re-entry race.
      act(() => {
        fireEvent.click(addButton);
        fireEvent.click(addButton);
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

describe('KnowledgeBase source bar and reconnect', () => {
  const SAVED = 'https://share.example/remembered';
  const FILE: FolderTreeEntry = {
    id: 'f1', name: 'guide.docx', mimeType: null, sizeBytes: 1024, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: 'https://dl/f1',
  };
  const FOLDER: FolderTreeEntry = {
    id: 'd1', name: 'Subfolder', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null,
  };

  function tokenExpired(): AxiosError {
    const error = new AxiosError('Request failed', '424');
    error.response = { status: 424, data: {}, statusText: '', headers: {}, config: {} as never };
    return error;
  }

  async function reconnectWith(token: string): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: /^reconnect$/i }));
    await userEvent.type(screen.getByLabelText(/sharepoint access token/i), token);
    await userEvent.click(screen.getAllByRole('button', { name: /^reconnect$/i }).at(-1)!);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(kbApi, 'getRubric').mockResolvedValue({ version: 'v1', source: 'kb', builtAt: null, removed: [], categories: [] });
    localStorage.clear();
  });

  it('shows the saved source in a bar, not the URL form', async () => {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([FILE]);
    renderPage();

    expect(await screen.findByText('guide.docx')).toBeInTheDocument();

    expect(screen.queryByLabelText(/sharing url/i)).toBeNull();
    expect(screen.getByText(SAVED)).toBeInTheDocument();
    for (const name of [/^refresh$/i, /^change$/i, /^reconnect$/i]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows the URL form, with Reconnect beside it, when no source is saved', async () => {
    renderPage();

    expect(await screen.findByLabelText(/sharing url/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reconnect$/i })).toBeInTheDocument();
  });

  it('Change opens an inline form and Cancel keeps the current source', async () => {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([FILE]);
    renderPage();
    await screen.findByText('guide.docx');

    await userEvent.click(screen.getByRole('button', { name: /^change$/i }));
    expect(screen.getByLabelText(/sharing url/i)).toHaveValue(SAVED);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByLabelText(/sharing url/i)).toBeNull();
    expect(screen.getByText(SAVED)).toBeInTheDocument();
    expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(1);
  });

  it('Change then Browse switches to the new source and remembers it', async () => {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([FILE]);
    renderPage();
    await screen.findByText('guide.docx');

    await userEvent.click(screen.getByRole('button', { name: /^change$/i }));
    await userEvent.clear(screen.getByLabelText(/sharing url/i));
    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/other');
    await userEvent.click(screen.getByRole('button', { name: /^browse$/i }));

    await waitFor(() => expect(kbApi.browseSharedFolder).toHaveBeenLastCalledWith('https://share.example/other', 'user-descriptor-1'));
    await waitFor(() => expect(screen.queryByLabelText(/sharing url/i)).toBeNull());
    expect(screen.getByText('https://share.example/other')).toBeInTheDocument();
    expect(localStorage.getItem('req2ado-kb-browse-url')).toBe('https://share.example/other');
  });

  it('Refresh browses the saved source again', async () => {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([FILE]);
    renderPage();
    await screen.findByText('guide.docx');

    await userEvent.click(screen.getByRole('button', { name: /^refresh$/i }));

    await waitFor(() => expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(2));
  });

  it('after a successful reconnect, browses the saved source again and clears the stale error', async () => {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
    vi.spyOn(kbApi, 'browseSharedFolder').mockRejectedValueOnce(tokenExpired()).mockResolvedValue([FILE]);
    vi.spyOn(kbApi, 'reconnectSharePoint').mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 });
    renderPage();
    expect(await screen.findByText(/sharepoint access token has expired or is invalid/i)).toBeInTheDocument();

    await reconnectWith('fresh-token');

    expect(await screen.findByText('guide.docx')).toBeInTheDocument();
    expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/sharepoint access token has expired or is invalid/i)).toBeNull();
  });

  it('does not browse again when the reconnect token is rejected', async () => {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockRejectedValue(tokenExpired());
    vi.spyOn(kbApi, 'reconnectSharePoint').mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
    renderPage();
    await screen.findByText(/sharepoint access token has expired or is invalid/i);

    await reconnectWith('bad-token');

    expect(await screen.findByText(/sharepoint rejected that token/i)).toBeInTheDocument();
    expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(1);
  });

  it('reopens the folder that was open before the reconnect', async () => {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([FOLDER]);
    vi.spyOn(kbApi, 'browseSubfolder').mockResolvedValue([{ ...FILE, id: 'f2', name: 'nested.docx' }]);
    vi.spyOn(kbApi, 'reconnectSharePoint').mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 });
    renderPage();
    await screen.findAllByText('Subfolder');
    await userEvent.click(screen.getAllByText('Subfolder').map((el) => el.closest('tr')).find(Boolean)!);
    await screen.findByText('nested.docx');

    await reconnectWith('fresh-token');

    await waitFor(() => expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(kbApi.browseSubfolder).toHaveBeenCalledTimes(2));
    expect(kbApi.browseSubfolder).toHaveBeenLastCalledWith('drive-1', 'd1', 'user-descriptor-1', 'Subfolder');
    expect(await screen.findByText('nested.docx')).toBeInTheDocument();
  });

  it('disables Refresh and Browse while the token is invalid, and says why', async () => {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([FILE]);
    renderPage();
    await screen.findByText('guide.docx');

    expect(await screen.findByText(/reconnect sharepoint first/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^refresh$/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /^change$/i }));
    expect(screen.getByRole('button', { name: /^browse$/i })).toBeDisabled();
  });

  describe('control hierarchy and icons', () => {
    const hasIcon = (el: HTMLElement): boolean => el.querySelector('svg') !== null;
    const emphasised = (el: HTMLElement): boolean => /\bbg-action\b/.test(el.className);

    async function openSavedSource(status: 'valid' | 'invalid'): Promise<void> {
      localStorage.setItem('req2ado-kb-browse-url', SAVED);
      vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status, expiresInSeconds: status === 'valid' ? 2820 : null });
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([FILE]);
      renderPage();
      await screen.findByText('guide.docx');
      await screen.findByText(status === 'valid' ? /^connected/i : /token invalid/i);
    }

    it('gives every action in the source bar an icon', async () => {
      await openSavedSource('valid');

      for (const name of [/^refresh$/i, /^change$/i, /^reconnect$/i]) {
        expect(hasIcon(screen.getByRole('button', { name }))).toBe(true);
      }
    });

    it('keeps the source bar calm while the token is healthy: no action is emphasised', async () => {
      await openSavedSource('valid');

      for (const name of [/^refresh$/i, /^change$/i, /^reconnect$/i]) {
        expect(emphasised(screen.getByRole('button', { name }))).toBe(false);
      }
    });

    it('makes Reconnect the one emphasised action when the token needs attention', async () => {
      await openSavedSource('invalid');

      expect(emphasised(screen.getByRole('button', { name: /^reconnect$/i }))).toBe(true);
      expect(emphasised(screen.getByRole('button', { name: /^change$/i }))).toBe(false);
      expect(emphasised(screen.getByRole('button', { name: /^refresh$/i }))).toBe(false);
    });

    it('marks the status with an icon as well as words', async () => {
      await openSavedSource('valid');

      expect(screen.getByText(/^connected/i).closest('[data-status]')).toHaveAttribute('data-status', 'valid');
      expect(screen.getByText(/^connected/i).closest('[data-status]')!.querySelector('svg')).not.toBeNull();
    });

    it('in the form, Browse is the one emphasised action and each action has an icon', async () => {
      renderPage();
      const url = await screen.findByLabelText(/sharing url/i);
      await userEvent.type(url, 'https://share.example/folder');

      const browse = screen.getByRole('button', { name: /^browse$/i });
      expect(emphasised(browse)).toBe(true);
      expect(hasIcon(browse)).toBe(true);
      const reconnect = screen.getByRole('button', { name: /^reconnect$/i });
      expect(hasIcon(reconnect)).toBe(true);
      expect(emphasised(reconnect)).toBe(false);
    });

    it('in the form, Reconnect takes over as the emphasised action when the token needs attention', async () => {
      vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
      renderPage();
      await screen.findByText(/token invalid/i);

      expect(emphasised(screen.getByRole('button', { name: /^reconnect$/i }))).toBe(true);
    });

    it('gives Cancel an icon while changing the source', async () => {
      localStorage.setItem('req2ado-kb-browse-url', SAVED);
      vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([FILE]);
      renderPage();
      await screen.findByText('guide.docx');
      await userEvent.click(screen.getByRole('button', { name: /^change$/i }));

      expect(hasIcon(screen.getByRole('button', { name: /^cancel$/i }))).toBe(true);
    });
  });
});

describe('KnowledgeBase "Add to knowledge base" dialog', () => {
  const SAVED = 'https://share.example/remembered';
  const NEW_FILE: FolderTreeEntry = {
    id: 'f1', name: 'spec.docx', mimeType: null, sizeBytes: 2048, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: 'https://dl/f1',
  };
  const OTHER_FILE: FolderTreeEntry = { ...NEW_FILE, id: 'f2', name: 'other.docx', downloadUrl: 'https://dl/f2' };
  const INGESTED: FolderTreeEntry = {
    ...NEW_FILE, id: 'f3', name: 'guide.pptx', alreadyIngested: true, ingestedDocumentId: 'doc-3', downloadUrl: 'https://dl/f3', chunkCount: 11, retrievalMode: null,
  };

  function ingestResult(entry: FolderTreeEntry, skippedUnchanged = false) {
    return { documentName: entry.name, driveitemId: entry.id, mimeType: null, sizeBytes: entry.sizeBytes, chunksStored: 3, chunksInStore: 3, skippedUnchanged, ingestedDocumentId: `doc-${entry.id}` };
  }

  async function open(entries: FolderTreeEntry[]): Promise<void> {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue(entries);
    renderPage();
    await screen.findByText(entries[0].name);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(kbApi, 'getRubric').mockResolvedValue({ version: 'v1', source: 'kb', builtAt: null, removed: [], categories: [] });
    vi.spyOn(kbApi, 'ingestFolderItem').mockImplementation(async (name, id) => ingestResult({ ...NEW_FILE, id, name }));
    localStorage.clear();
  });

  it('opens from the row action and sends nothing until the user confirms', async () => {
    await open([NEW_FILE]);

    await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));

    expect(await screen.findByRole('dialog', { name: /add "\s*spec\.docx\s*" to the knowledge base/i })).toBeInTheDocument();
    expect(kbApi.ingestFolderItem).not.toHaveBeenCalled();
  });

  it('opens from the detail pane too', async () => {
    await open([NEW_FILE]);
    await userEvent.click(screen.getByText('spec.docx').closest('tr')!);

    await userEvent.click(await screen.findByRole('button', { name: /^add to knowledge base$/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(kbApi.ingestFolderItem).not.toHaveBeenCalled();
  });

  it('Cancel adds nothing', async () => {
    await open([NEW_FILE]);
    await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));

    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(kbApi.ingestFolderItem).not.toHaveBeenCalled();
  });

  it('no longer offers the always-include checkbox before a file is added', async () => {
    await open([NEW_FILE]);
    await userEvent.click(screen.getByText('spec.docx').closest('tr')!);

    await screen.findByRole('button', { name: /^add to knowledge base$/i });

    expect(screen.queryByRole('checkbox', { name: /always include/i })).toBeNull();
    expect(screen.queryByRole('switch', { name: /reference \(always include\)/i })).toBeNull();
  });

  it('sends Search as the default mode and Reference as always_include', async () => {
    await open([NEW_FILE, OTHER_FILE]);

    await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));
    await chooseAndConfirm('search');
    await waitFor(() => expect(kbApi.ingestFolderItem).toHaveBeenCalledWith('spec.docx', 'f1', 'https://dl/f1', 'spec.docx', 'user-descriptor-1', undefined));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: /add other\.docx to the knowledge base/i }));
    await chooseAndConfirm('reference');
    await waitFor(() => expect(kbApi.ingestFolderItem).toHaveBeenCalledWith('other.docx', 'f2', 'https://dl/f2', 'other.docx', 'user-descriptor-1', 'always_include'));
  });

  it('shows the new file as Reference afterwards, on the switch in the detail pane', async () => {
    await open([NEW_FILE]);
    await userEvent.click(screen.getByText('spec.docx').closest('tr')!);
    await userEvent.click(await screen.findByRole('button', { name: /^add to knowledge base$/i }));
    await chooseAndConfirm('reference');

    expect(await screen.findByRole('switch', { name: /reference \(always include\)/i })).toBeChecked();
  });

  it('remembers a choice for the folder, and offers it the next time', async () => {
    await open([NEW_FILE, OTHER_FILE]);
    await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));
    const first = await screen.findByRole('dialog');
    await userEvent.click(within(first).getByRole('radio', { name: /^reference/i }));
    await userEvent.click(within(first).getByRole('checkbox', { name: /remember my choice for this folder/i }));
    await userEvent.click(within(first).getByRole('button', { name: /^add to knowledge base$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: /add other\.docx to the knowledge base/i }));

    const second = await screen.findByRole('dialog');
    expect(within(second).getByRole('radio', { name: /^reference/i })).toHaveAttribute('aria-checked', 'true');
    expect(within(second).getByText(/your earlier choice for this folder/i)).toBeInTheDocument();
  });

  it('does not remember a choice unless asked', async () => {
    await open([NEW_FILE, OTHER_FILE]);
    await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));
    await chooseAndConfirm('reference');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: /add other\.docx to the knowledge base/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /^reference/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('re-ingesting a file applies a changed mode to its stored chunks first, then re-ingests', async () => {
    vi.spyOn(kbApi, 'setRetrievalMode').mockResolvedValue(undefined);
    await open([INGESTED]);
    await userEvent.click(screen.getByText('guide.pptx').closest('tr')!);
    await userEvent.click(await screen.findByRole('button', { name: /^re-ingest file$/i }));

    await chooseAndConfirm('reference', /^re-ingest$/i);

    await waitFor(() => expect(kbApi.setRetrievalMode).toHaveBeenCalledWith('doc-3', 'always_include'));
    await waitFor(() => expect(kbApi.ingestFolderItem).toHaveBeenCalledWith('guide.pptx', 'f3', 'https://dl/f3', 'guide.pptx', 'user-descriptor-1', 'always_include'));
  });

  it('re-ingesting a file in the same mode does not retag it', async () => {
    vi.spyOn(kbApi, 'setRetrievalMode').mockResolvedValue(undefined);
    await open([INGESTED]);
    await userEvent.click(screen.getByText('guide.pptx').closest('tr')!);
    await userEvent.click(await screen.findByRole('button', { name: /^re-ingest file$/i }));

    await chooseAndConfirm(null, /^re-ingest$/i);

    await waitFor(() => expect(kbApi.ingestFolderItem).toHaveBeenCalled());
    expect(kbApi.setRetrievalMode).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and shows an error when adding fails', async () => {
    vi.spyOn(kbApi, 'ingestFolderItem').mockRejectedValue(new Error('boom'));
    await open([NEW_FILE]);
    await userEvent.click(screen.getByRole('button', { name: /add spec\.docx to the knowledge base/i }));

    await chooseAndConfirm('search');

    expect(await screen.findByText(/failed to add "spec\.docx"/i)).toBeInTheDocument();
    // Still open, with the choice kept, so a retry is one click.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /^search/i })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('button', { name: /^add to knowledge base$/i })).toBeEnabled();
  });
});

describe('KnowledgeBase batch add', () => {
  const SAVED = 'https://share.example/remembered';
  const base = { mimeType: null, isFolder: false, driveId: null, parentDriveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null } as const;
  const A: FolderTreeEntry = { ...base, id: 'a', name: 'a.docx', sizeBytes: 1000, downloadUrl: 'https://dl/a' };
  const B: FolderTreeEntry = { ...base, id: 'b', name: 'b.docx', sizeBytes: 2000, downloadUrl: 'https://dl/b' };
  const C: FolderTreeEntry = { ...base, id: 'c', name: 'c.docx', sizeBytes: 3000, downloadUrl: 'https://dl/c', alreadyIngested: true, ingestedDocumentId: 'doc-c', chunkCount: 4 };

  const item = (entry: FolderTreeEntry, state: kbApi.KbIngestItemState, overrides: Partial<kbApi.KbIngestItem> = {}): kbApi.KbIngestItem => ({
    id: `i-${entry.id}`, ordinal: 0, itemId: entry.id, name: entry.name, relativePath: entry.name, sizeBytes: entry.sizeBytes, retrievalMode: 'retrieve', state, attempts: 0,
    errorKind: null, reason: null, chunksStored: null, chunksInStore: null, ingestedDocumentId: null, startedAt: null, finishedAt: null, ...overrides,
  });

  function batchView(status: kbApi.KbIngestBatchStatus, items: kbApi.KbIngestItem[], overrides: Partial<kbApi.KbIngestBatch> = {}): kbApi.KbIngestBatch {
    const count = (s: kbApi.KbIngestItemState) => items.filter((i) => i.state === s).length;
    return {
      id: 'batch-1', status, pauseReason: null, cancelRequested: false, driveId: 'drive-1', folderItemId: null, folderPath: '', docType: null, version: 1,
      createdAt: '2026-11-12T09:00:00Z', startedAt: null, finishedAt: ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status) ? '2026-11-12T09:05:00Z' : null,
      counts: { total: items.length, queued: count('queued'), running: count('running'), added: count('added'), unchanged: count('unchanged'), failed: count('failed'), skipped: count('skipped'), cancelled: count('cancelled') },
      items, ...overrides,
    };
  }

  async function open(entries: FolderTreeEntry[]): Promise<void> {
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue(entries);
    renderPage();
    // The batch panel lists the same files, so a name can appear more than once.
    await screen.findAllByText(entries[0].name);
  }

  const tick = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
    vi.spyOn(kbApi, 'getRubric').mockResolvedValue({ version: 'v1', source: 'kb', builtAt: null, removed: [], categories: [] });
    vi.spyOn(kbApi, 'listKbIngestBatches').mockResolvedValue([]);
    localStorage.clear();
  });

  it('adds the selected files as one batch, in the background', async () => {
    vi.spyOn(kbApi, 'createKbIngestBatch').mockResolvedValue(batchView('queued', [item(A, 'queued'), item(B, 'queued')]));
    await open([A, B, C]);

    await userEvent.click(tick('a.docx'));
    await userEvent.click(tick('b.docx'));
    await userEvent.click(screen.getByRole('button', { name: /^add 2 to knowledge base/i }));
    const dialog = await screen.findByRole('dialog', { name: /add 2 files to the knowledge base/i });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^search/i }));
    await userEvent.click(within(dialog).getByRole('switch', { name: 'Reference: b.docx' }));
    await userEvent.click(within(dialog).getByRole('button', { name: /^add 2 to knowledge base$/i }));

    await waitFor(() =>
      expect(kbApi.createKbIngestBatch).toHaveBeenCalledWith({
        driveId: 'drive-1',
        folderItemId: null,
        folderPath: '',
        docType: null,
        items: [
          { itemId: 'a', name: 'a.docx', relativePath: 'a.docx', sizeBytes: 1000, retrievalMode: 'retrieve' },
          { itemId: 'b', name: 'b.docx', relativePath: 'b.docx', sizeBytes: 2000, retrievalMode: 'always_include' },
        ],
      }),
    );
    expect(await screen.findByRole('heading', { name: /adding 1 of 2 files/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('2 selected')).toBeNull(); // the selection is spent
  });

  it('says so in a toast, and leaves the page free to use', async () => {
    vi.spyOn(kbApi, 'createKbIngestBatch').mockResolvedValue(batchView('queued', [item(A, 'queued')]));
    await open([A]);
    await userEvent.click(tick('a.docx'));
    await userEvent.click(screen.getByRole('button', { name: /^add 1 to knowledge base/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^search/i }));
    await userEvent.click(within(dialog).getByRole('button', { name: /^add 1 to knowledge base$/i }));

    expect(await screen.findByText(/adding 1 file in the background/i)).toBeInTheDocument();
  });

  it('puts the folder\'s path on the batch and on each file when a subfolder is open', async () => {
    const folder: FolderTreeEntry = { id: 'd1', name: 'Standards', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-9', parentDriveId: 'drive-9', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null };
    const nested: FolderTreeEntry = { ...A, id: 'n1', name: 'nested.docx', parentDriveId: 'drive-9', downloadUrl: 'https://dl/n1' };
    localStorage.setItem('req2ado-kb-browse-url', SAVED);
    vi.spyOn(kbApi, 'browseSharedFolder').mockResolvedValue([folder]);
    vi.spyOn(kbApi, 'browseSubfolder').mockResolvedValue([nested]);
    vi.spyOn(kbApi, 'createKbIngestBatch').mockResolvedValue(batchView('queued', [item(nested, 'queued')]));
    renderPage();
    await userEvent.click((await screen.findAllByText('Standards')).map((el) => el.closest('tr')).find(Boolean)!);
    await screen.findByText('nested.docx');

    await userEvent.click(tick('nested.docx'));
    await userEvent.click(screen.getByRole('button', { name: /^add 1 to knowledge base/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^search/i }));
    await userEvent.click(within(dialog).getByRole('button', { name: /^add 1 to knowledge base$/i }));

    await waitFor(() =>
      expect(kbApi.createKbIngestBatch).toHaveBeenCalledWith(
        expect.objectContaining({ driveId: 'drive-9', folderItemId: 'd1', folderPath: 'Standards', items: [expect.objectContaining({ itemId: 'n1', relativePath: 'Standards/nested.docx' })] }),
      ),
    );
  });

  it('selects the files not yet in the knowledge base with one click', async () => {
    await open([A, B, C]);

    await userEvent.click(screen.getByRole('button', { name: /select new \(2\)/i }));

    expect(tick('a.docx')).toBeChecked();
    expect(tick('b.docx')).toBeChecked();
    expect(tick('c.docx')).not.toBeChecked();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('keeps the dialog open and says why when the server refuses the batch', async () => {
    vi.spyOn(kbApi, 'createKbIngestBatch').mockRejectedValue(new Error('conflict'));
    await open([A]);
    await userEvent.click(tick('a.docx'));
    await userEvent.click(screen.getByRole('button', { name: /^add 1 to knowledge base/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^search/i }));

    await userEvent.click(within(dialog).getByRole('button', { name: /^add 1 to knowledge base$/i }));

    expect(await screen.findByText(/failed to start the batch/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(kbApi.createKbIngestBatch).toHaveBeenCalledTimes(1);
  });

  it('refuses to guess the drive when the backend did not say which one', async () => {
    vi.spyOn(kbApi, 'createKbIngestBatch').mockResolvedValue(batchView('queued', []));
    await open([{ ...A, parentDriveId: null }]);
    await userEvent.click(tick('a.docx'));
    await userEvent.click(screen.getByRole('button', { name: /^add 1 to knowledge base/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^search/i }));

    await userEvent.click(within(dialog).getByRole('button', { name: /^add 1 to knowledge base$/i }));

    expect(await screen.findByText(/could not tell which sharepoint drive/i)).toBeInTheDocument();
    expect(kbApi.createKbIngestBatch).not.toHaveBeenCalled();
  });

  it('remembers a choice for the folder in the batch dialog too', async () => {
    vi.spyOn(kbApi, 'createKbIngestBatch').mockResolvedValue(batchView('completed', [item(A, 'added')]));
    await open([A, B]);
    await userEvent.click(tick('a.docx'));
    await userEvent.click(screen.getByRole('button', { name: /^add 1 to knowledge base/i }));
    const first = await screen.findByRole('dialog');
    await userEvent.click(within(first).getByRole('radio', { name: /^reference/i }));
    await userEvent.click(within(first).getByRole('checkbox', { name: /remember my choice for this folder/i }));
    await userEvent.click(within(first).getByRole('button', { name: /^add 1 to knowledge base$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(within(screen.getByRole('region', { name: /knowledge base batch/i })).getByRole('button', { name: /^dismiss$/i }));

    await userEvent.click(tick('b.docx'));
    await userEvent.click(screen.getByRole('button', { name: /^add 1 to knowledge base/i }));

    const second = await screen.findByRole('dialog');
    expect(within(second).getByRole('radio', { name: /^reference/i })).toHaveAttribute('aria-checked', 'true');
  });

  describe('the batch on show', () => {
    it('is found again after a reload', async () => {
      vi.spyOn(kbApi, 'listKbIngestBatches').mockResolvedValue([batchView('running', [item(A, 'running'), item(B, 'queued')])]);
      vi.spyOn(kbApi, 'getKbIngestBatch').mockResolvedValue(batchView('running', [item(A, 'running'), item(B, 'queued')]));
      await open([A, B]);

      expect(await screen.findByRole('heading', { name: /adding 1 of 2 files/i })).toBeInTheDocument();
      expect(screen.getByRole('list', { name: /files in this batch/i })).toBeInTheDocument();
    });

    it('shows nothing when there is no batch', async () => {
      await open([A]);

      expect(screen.queryByRole('list', { name: /files in this batch/i })).toBeNull();
    });

    it('cancels from the panel', async () => {
      const running = batchView('running', [item(A, 'running'), item(B, 'queued')]);
      vi.spyOn(kbApi, 'listKbIngestBatches').mockResolvedValue([running]);
      vi.spyOn(kbApi, 'getKbIngestBatch').mockResolvedValue(running);
      vi.spyOn(kbApi, 'cancelKbIngestBatch').mockResolvedValue({ ...running, cancelRequested: true });
      await open([A, B]);

      await userEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));

      expect(kbApi.cancelKbIngestBatch).toHaveBeenCalledWith('batch-1');
      expect(await screen.findByRole('heading', { name: /finishing the current file/i })).toBeInTheDocument();
    });

    it('retries only the failed files from the panel', async () => {
      const done = batchView('completed_with_errors', [item(A, 'added'), item(B, 'failed', { reason: 'unsupported' })]);
      vi.spyOn(kbApi, 'listKbIngestBatches').mockResolvedValue([done]);
      vi.spyOn(kbApi, 'getKbIngestBatch').mockResolvedValue(done);
      vi.spyOn(kbApi, 'retryFailedKbIngestBatch').mockResolvedValue(batchView('queued', [item(A, 'added'), item(B, 'queued')]));
      await open([A, B]);

      await userEvent.click(await screen.findByRole('button', { name: /retry 1 failed/i }));

      expect(kbApi.retryFailedKbIngestBatch).toHaveBeenCalledWith('batch-1');
    });

    it('resumes a paused batch from the panel', async () => {
      const paused = batchView('paused', [item(A, 'queued')], { pauseReason: 'sharepoint_token' });
      vi.spyOn(kbApi, 'listKbIngestBatches').mockResolvedValue([paused]);
      vi.spyOn(kbApi, 'getKbIngestBatch').mockResolvedValue(paused);
      vi.spyOn(kbApi, 'resumeKbIngestBatch').mockResolvedValue(batchView('queued', [item(A, 'queued')]));
      await open([A]);

      await userEvent.click(await screen.findByRole('button', { name: /^resume$/i }));

      expect(kbApi.resumeKbIngestBatch).toHaveBeenCalledWith('batch-1');
    });

    it('dismisses a finished batch', async () => {
      const done = batchView('completed', [item(A, 'added', { chunksInStore: 3 })]);
      vi.spyOn(kbApi, 'listKbIngestBatches').mockResolvedValue([done]);
      vi.spyOn(kbApi, 'getKbIngestBatch').mockResolvedValue(done);
      await open([A]);

      await userEvent.click(within(await screen.findByRole('region', { name: /knowledge base batch/i })).getByRole('button', { name: /^dismiss$/i }));

      expect(screen.queryByRole('list', { name: /files in this batch/i })).toBeNull();
    });

    it('lists the folder again when a running batch finishes, so the rows show what got in', async () => {
      const running = batchView('running', [item(A, 'running')]);
      vi.spyOn(kbApi, 'listKbIngestBatches').mockResolvedValue([running]);
      vi.spyOn(kbApi, 'getKbIngestBatch').mockResolvedValueOnce(running).mockResolvedValue(batchView('completed', [item(A, 'added', { chunksInStore: 3 })]));
      await open([A]);
      expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(1);

      await waitFor(() => expect(kbApi.browseSharedFolder).toHaveBeenCalledTimes(2), { timeout: 8000 });
    }, 15000);
  });
});
