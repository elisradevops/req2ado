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

  it('does not count a file whose chunk count is unknown as ready, and says what to do about it', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', null), doc('b.pdf', null), doc('c.pdf', 5)]);
    renderStrip();
    expect(await screen.findByText('1 file · 5 chunks')).toBeInTheDocument();
    expect(
      screen.getByText(/2 files have no stored chunk count, so they may not ground this run.*Re-ingest them in Knowledge Base/),
    ).toBeInTheDocument();
  });

  it('says the chunk count is unknown, not that nothing is ready, when every file is an older ingest', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', null), doc('b.pdf', null)]);
    renderStrip();
    expect(await screen.findByText('2 files · chunk count unknown')).toBeInTheDocument();
    expect(screen.queryByText(/ready/)).toBeNull();
    expect(screen.queryByText(/ chunks?$/)).toBeNull();
  });

  it('says 0 files ready only when the files are known to hold no vectors', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 0)]);
    renderStrip();
    expect(await screen.findByText('0 files ready')).toBeInTheDocument();
  });

  it('warns that an empty knowledge base means the run will not be grounded, and offers to add files without losing the draft', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([]);
    renderStrip();
    expect(await screen.findByText(/knowledge base is empty/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix in Knowledge Base' })).toHaveAttribute('href', '/knowledge-base');
    expect(screen.getByText('Your draft is kept.')).toBeInTheDocument();
  });

  it('says it for one file and says it once when both kinds of problem apply', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 0), doc('b.pdf', null)]);
    renderStrip();
    expect(await screen.findByText(/1 file has no vectors and cannot ground this run\.$/)).toBeInTheDocument();
    expect(screen.getByText(/1 file has no stored chunk count.*Re-ingest them in Knowledge Base/)).toBeInTheDocument();
    expect(screen.getAllByText(/Re-ingest/)).toHaveLength(1);
  });

  it('says "it" when exactly one file needs re-ingesting', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 5), doc('b.pdf', 0)]);
    renderStrip();
    expect(await screen.findByText(/1 file has no vectors.*Re-ingest it in Knowledge Base/)).toBeInTheDocument();
  });

  it('offers no link when everything is healthy, since there is nothing to fix there', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 32)]);
    renderStrip();
    await screen.findByText('1 file · 32 chunks');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says to reconnect SharePoint in the Knowledge Base when its token expired', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 5)]);
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
    renderStrip();
    expect(await screen.findByText(/Reconnect SharePoint in Knowledge Base/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /fix in knowledge base/i })).toBeInTheDocument();
  });

  it('warns about ingested files that have no vectors', async () => {
    vi.spyOn(kbApi, 'listIngestedDocuments').mockResolvedValue([doc('a.pdf', 32), doc('b.pdf', 0), doc('c.pdf', 0)]);
    renderStrip();
    expect(await screen.findByText(/2 files have no vectors and cannot ground this run.*Re-ingest them in Knowledge Base/)).toBeInTheDocument();
    expect(screen.getByText('1 file · 32 chunks')).toBeInTheDocument();
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
