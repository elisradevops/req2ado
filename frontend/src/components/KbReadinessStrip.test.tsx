import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KbReadinessStrip } from './KbReadinessStrip';
import * as kbApi from '../api/kb';
import { useAuthStore } from '../store/authStore';

vi.mock('../api/kb');

function doc(name: string, chunkCount: number | null) {
  return { id: name, userId: 'u', driveItemId: name, name, sizeBytes: 1, mimeType: null, docType: null, retrievalMode: null, ingestedAt: '2026-11-02T00:00:00Z', chunkCount };
}

function renderStrip(): void {
  useAuthStore.getState().login('https://ado.example', 'Jane', 'user-1');
  render(
    <MemoryRouter>
      <KbReadinessStrip />
    </MemoryRouter>,
  );
}

describe('KbReadinessStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 });
  });

  it('shows file and chunk counts and the SharePoint state', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 32), doc('b.pdf', 26), doc('c.pdf', 10)]);
    renderStrip();
    expect(await screen.findByText('3 files · 68 chunks')).toBeInTheDocument();
    expect(screen.getByText('SharePoint connected')).toBeInTheDocument();
    expect(kbApi.listIngestedDocuments).toHaveBeenCalledWith('user-1');
    expect(screen.queryByText(/no vectors/i)).toBeNull();
  });

  it('never shows 0 chunks for legacy rows whose count is unknown', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', null), doc('b.pdf', 5)]);
    renderStrip();
    expect(await screen.findByText('2 files')).toBeInTheDocument();
    expect(screen.queryByText(/chunk/)).toBeNull();
  });

  it('warns that an empty knowledge base means the run will not be grounded', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    renderStrip();
    expect(await screen.findByText(/knowledge base is empty/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage knowledge base/i })).toHaveAttribute('href', '/knowledge-base');
  });

  it('warns about ingested files that have no vectors', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 32), doc('b.pdf', 0), doc('c.pdf', 0)]);
    renderStrip();
    expect(await screen.findByText('2 files have no vectors and cannot ground this run — re-ingest them')).toBeInTheDocument();
    expect(screen.getByText('3 files · 32 chunks')).toBeInTheDocument();
  });

  it('explains an unreachable SharePoint without blocking', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 5)]);
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'unreachable', expiresInSeconds: null });
    renderStrip();
    expect(await screen.findByText("Can't reach SharePoint (adding files will fail)")).toBeInTheDocument();
    expect(screen.getByText('1 file · 5 chunks')).toBeInTheDocument();
  });

  it('says the status could not be checked when the KB listing fails', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockRejectedValue(new Error('boom'));
    renderStrip();
    await waitFor(() => expect(screen.getByText(/couldn't check your knowledge base/i)).toBeInTheDocument());
  });
});
