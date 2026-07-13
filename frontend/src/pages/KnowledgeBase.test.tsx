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
  it('lists existing sources with their area path and last-synced time', async () => {
    vi.spyOn(kbApi, 'listKbSources').mockResolvedValue([
      { id: 'kb-1', areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs', lastSyncedAt: null, createdAt: '2026-07-12T00:00:00Z' },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Docs')).toBeInTheDocument());
    expect(screen.getByText(/Project\\Area1/)).toBeInTheDocument();
  });

  it('creates a new source when the Add Source form is submitted', async () => {
    vi.spyOn(kbApi, 'listKbSources').mockResolvedValue([]);
    const created = { id: 'kb-2', areaPath: 'Project\\Area2', siteUrl: 'https://s2', library: 'Lib2', folder: 'Folder2', displayName: 'New Docs', lastSyncedAt: null, createdAt: '2026-07-12T00:00:00Z' };
    vi.spyOn(kbApi, 'createKbSource').mockResolvedValue(created);
    renderPage();

    await userEvent.type(screen.getByLabelText(/display name/i), 'New Docs');
    await userEvent.type(screen.getByLabelText(/site url/i), 'https://s2');
    await userEvent.type(screen.getByLabelText(/^library$/i), 'Lib2');
    await userEvent.type(screen.getByLabelText(/^folder$/i), 'Folder2');
    await userEvent.type(screen.getByLabelText(/^area path$/i), 'Project\\Area2');
    await userEvent.click(screen.getByRole('button', { name: /add source/i }));

    await waitFor(() => expect(kbApi.createKbSource).toHaveBeenCalledWith({
      displayName: 'New Docs', siteUrl: 'https://s2', library: 'Lib2', folder: 'Folder2', areaPath: 'Project\\Area2',
    }));
    await waitFor(() => expect(screen.getByText('New Docs')).toBeInTheDocument());
  });

  it('shows a success toast summarizing the sync result', async () => {
    vi.spyOn(kbApi, 'listKbSources').mockResolvedValue([
      { id: 'kb-1', areaPath: 'Project\\Area1', siteUrl: 'https://s', library: 'Lib', folder: 'Folder', displayName: 'Docs', lastSyncedAt: null, createdAt: '2026-07-12T00:00:00Z' },
    ]);
    vi.spyOn(kbApi, 'syncKbSource').mockResolvedValue({ filesProcessed: 2, filesSkipped: 1, filesFailed: [], chunksStored: 7 });
    renderPage();
    await waitFor(() => expect(screen.getByText('Docs')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/bearer token/i), 'tok-1');
    await userEvent.click(screen.getByRole('button', { name: /^sync$/i }));

    await waitFor(() => expect(screen.getByText(/2 file\(s\) processed, 1 skipped, 7 chunk\(s\) stored/i)).toBeInTheDocument());
  });

  it('shows an error toast when the initial source list fails to load', async () => {
    vi.spyOn(kbApi, 'listKbSources').mockRejectedValue(new Error('network error'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/failed to load knowledge base sources/i)).toBeInTheDocument());
  });

  it('shows an error toast when adding a source fails', async () => {
    vi.spyOn(kbApi, 'listKbSources').mockResolvedValue([]);
    vi.spyOn(kbApi, 'createKbSource').mockRejectedValue(new Error('duplicate source'));
    renderPage();

    await userEvent.type(screen.getByLabelText(/display name/i), 'New Docs');
    await userEvent.type(screen.getByLabelText(/site url/i), 'https://s2');
    await userEvent.type(screen.getByLabelText(/^library$/i), 'Lib2');
    await userEvent.type(screen.getByLabelText(/^folder$/i), 'Folder2');
    await userEvent.type(screen.getByLabelText(/^area path$/i), 'Project\\Area2');
    await userEvent.click(screen.getByRole('button', { name: /add source/i }));

    await waitFor(() => expect(screen.getByText(/failed to add source/i)).toBeInTheDocument());
  });
});
