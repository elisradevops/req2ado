import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError } from 'axios';
import { KnowledgeBase } from './KnowledgeBase';
import { ToastProvider } from '../components/ToastProvider';
import * as kbApi from '../api/kb';
import { useAuthStore } from '../store/authStore';

// Mirrors ingestion/app/main.py's kb_ingest_url/kb_ingest_folder_url status
// mapping (see graph_client.py's _error_for_status) -- a real axios error
// carrying just a status code, no response body, matching what the backend
// actually returns.
function axiosErrorWithStatus(status: number): AxiosError {
  const error = new AxiosError('Request failed', String(status));
  error.response = { status, data: {}, statusText: '', headers: {}, config: {} as never };
  return error;
}

vi.mock('../api/kb');

function renderPage(): void {
  useAuthStore.getState().login('https://ado.example', 'pat-1', 'Jane', 'user-descriptor-1');
  render(
    <ToastProvider>
      <KnowledgeBase />
    </ToastProvider>,
  );
}

describe('KnowledgeBase', () => {
  it('lists ingested documents on mount', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([
      { id: 'doc-1', userId: 'Project\\Area1', driveItemId: 'drive-1', name: 'spec.docx', sizeBytes: 2048, mimeType: null, docType: 'spec', ingestedAt: '2026-07-12T00:00:00Z' },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('spec.docx')).toBeInTheDocument());
  });

  it('ingests a url and shows a success toast', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestUrl').mockResolvedValue({
      documentName: 'spec.docx',
      driveitemId: 'drive-1',
      mimeType: null,
      sizeBytes: 2048,
      chunksStored: 3,
      skippedUnchanged: false,
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/spec.docx');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(kbApi.ingestUrl).toHaveBeenCalledWith('https://share.example/spec.docx', 'user-descriptor-1', undefined));
    await waitFor(() => expect(screen.getByText(/ingested "spec\.docx" — 3 chunk\(s\) stored/i)).toBeInTheDocument());
  });

  it('shows an error toast when ingest fails', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestUrl').mockRejectedValue(new Error('bad request'));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/spec.docx');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(screen.getByText(/ingest failed — check the sharing link and try again/i)).toBeInTheDocument());
  });

  it('shows an actionable message when the SharePoint token has expired (401)', async () => {
    // The single most common real-world failure -- must NOT be collapsed
    // into the generic "check the sharing link" message, since the link
    // itself is fine and telling the user to re-check it is misleading.
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestUrl').mockRejectedValue(axiosErrorWithStatus(401));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/spec.docx');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(screen.getByText(/sharepoint access token has expired or is invalid/i)).toBeInTheDocument());
  });

  it('shows an actionable message when no SharePoint token is configured (400)', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestUrl').mockRejectedValue(axiosErrorWithStatus(400));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/spec.docx');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(screen.getByText(/sharepoint access isn.t configured on the server/i)).toBeInTheDocument());
  });

  it('shows an actionable message when the token lacks permission (403)', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestUrl').mockRejectedValue(axiosErrorWithStatus(403));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/spec.docx');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(screen.getByText(/doesn.t have permission to read this link/i)).toBeInTheDocument());
  });

  it('shows an actionable message when the link is not found (404)', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestUrl').mockRejectedValue(axiosErrorWithStatus(404));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/spec.docx');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(screen.getByText(/not found at this sharing link/i)).toBeInTheDocument());
  });

  it('shows an actionable message when Microsoft Graph is unreachable (502)', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestUrl').mockRejectedValue(axiosErrorWithStatus(502));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/spec.docx');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(screen.getByText(/could not reach microsoft graph/i)).toBeInTheDocument());
  });

  it('includes each failed file\'s reason in the folder-ingest summary toast', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestFolderUrl').mockResolvedValue({
      files: [
        { file: 'a.docx', status: 'ingested', chunksStored: 2, driveitemId: 'd1', mimeType: null, sizeBytes: 100, reason: null },
        {
          file: 'b.pdf',
          status: 'failed',
          chunksStored: 0,
          driveitemId: null,
          mimeType: null,
          sizeBytes: null,
          reason: 'token expired or invalid',
        },
      ],
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByLabelText(/this is a folder/i));
    await userEvent.click(screen.getByRole('button', { name: /ingest folder/i }));

    await waitFor(() => expect(screen.getByText(/b\.pdf: token expired or invalid/i)).toBeInTheDocument());
  });

  it('ingests a folder when "This is a folder" is checked, shows a summary toast', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestFolderUrl').mockResolvedValue({
      files: [
        { file: 'a.docx', status: 'ingested', chunksStored: 2, driveitemId: 'd1', mimeType: null, sizeBytes: 100, reason: null },
        { file: 'b.pdf', status: 'skipped_unchanged', chunksStored: 0, driveitemId: 'd2', mimeType: null, sizeBytes: 200, reason: null },
      ],
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByLabelText(/this is a folder/i));
    await userEvent.click(screen.getByRole('button', { name: /ingest folder/i }));

    await waitFor(() => expect(kbApi.ingestFolderUrl).toHaveBeenCalledWith('https://share.example/folder', 'user-descriptor-1', undefined, false));
    await waitFor(() => expect(screen.getByText(/folder ingest: 1 ingested, 1 skipped/i)).toBeInTheDocument());
  });

  it('shows "Include subfolders" only when "This is a folder" is checked, and forwards recursive', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestFolderUrl').mockResolvedValue({ files: [] });
    renderPage();

    expect(screen.queryByLabelText(/include subfolders/i)).toBeNull();

    await userEvent.click(screen.getByLabelText(/this is a folder/i));
    expect(screen.getByLabelText(/include subfolders/i)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/include subfolders/i));
    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/folder');
    await userEvent.click(screen.getByRole('button', { name: /ingest folder/i }));

    await waitFor(() =>
      expect(kbApi.ingestFolderUrl).toHaveBeenCalledWith('https://share.example/folder', 'user-descriptor-1', undefined, true),
    );
  });

  it('shows a distinct empty-state message for a folder with no ingestable files', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestFolderUrl').mockResolvedValue({ files: [] });
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/empty-folder');
    await userEvent.click(screen.getByLabelText(/this is a folder/i));
    await userEvent.click(screen.getByRole('button', { name: /ingest folder/i }));

    await waitFor(() => expect(kbApi.ingestFolderUrl).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/folder is empty — no files were found to ingest/i)).toBeInTheDocument());
  });

  it('does not render a bearer-token / password field', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(kbApi.listIngestedDocuments).toHaveBeenCalled());
    expect(screen.queryByLabelText(/token/i)).toBeNull();
  });
});
