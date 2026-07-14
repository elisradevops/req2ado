import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeBase } from './KnowledgeBase';
import { ToastProvider } from '../components/ToastProvider';
import * as kbApi from '../api/kb';

vi.mock('../api/kb');

function renderPage(): void {
  render(
    <ToastProvider>
      <KnowledgeBase />
    </ToastProvider>,
  );
}

describe('KnowledgeBase', () => {
  it('lists ingested documents on mount', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([
      { id: 'doc-1', areaPath: 'Project\\Area1', driveItemId: 'drive-1', name: 'spec.docx', sizeBytes: 2048, mimeType: null, docType: 'spec', ingestedAt: '2026-07-12T00:00:00Z' },
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
    await userEvent.type(screen.getByLabelText(/^area path$/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(kbApi.ingestUrl).toHaveBeenCalledWith('https://share.example/spec.docx', 'Project\\Area1', undefined));
    await waitFor(() => expect(screen.getByText(/ingested "spec\.docx" — 3 chunk\(s\) stored/i)).toBeInTheDocument());
  });

  it('shows an error toast when ingest fails', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    vi.spyOn(kbApi, 'ingestUrl').mockRejectedValue(new Error('bad request'));
    renderPage();

    await userEvent.type(screen.getByLabelText(/sharing url/i), 'https://share.example/spec.docx');
    await userEvent.type(screen.getByLabelText(/^area path$/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /ingest/i }));

    await waitFor(() => expect(screen.getByText(/ingest failed — check the sharing link and try again/i)).toBeInTheDocument());
  });

  it('does not render a bearer-token / password field', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(kbApi.listIngestedDocuments).toHaveBeenCalled());
    expect(screen.queryByLabelText(/token/i)).toBeNull();
  });
});
