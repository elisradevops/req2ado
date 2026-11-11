import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbFileList } from './KbFileList';
import type { FolderTreeEntry } from '../api/kb';

function file(id: string, overrides: Partial<FolderTreeEntry> = {}): FolderTreeEntry {
  return {
    id, name: `${id}.pdf`, mimeType: null, sizeBytes: 1024, isFolder: false, driveId: null, alreadyIngested: false, ingestedDocumentId: null, downloadUrl: `https://dl/${id}`, ...overrides,
  };
}

const FOLDER: FolderTreeEntry = { id: 'd1', name: 'Subfolder', mimeType: null, sizeBytes: 0, isFolder: true, driveId: 'drive-1', alreadyIngested: false, ingestedDocumentId: null, downloadUrl: null };

function renderList(entries: FolderTreeEntry[], props: Partial<React.ComponentProps<typeof KbFileList>> = {}) {
  const handlers = {
    onSelectFile: vi.fn(), onNavigateFolder: vi.fn(), onIngest: vi.fn(), onToggleChecked: vi.fn(), onSetChecked: vi.fn(), onAddChecked: vi.fn(), onClearChecked: vi.fn(),
  };
  render(
    <KbFileList
      entries={entries}
      loading={false}
      breadcrumb={[]}
      onNavigateRoot={vi.fn()}
      onRequestRemove={vi.fn()}
      selectedFileId={null}
      isIngested={(entry) => entry.alreadyIngested}
      chunkCountOf={() => null}
      ingestingId={null}
      checkedIds={new Set()}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('KbFileList selection', () => {
  it('gives each file that can be added a checkbox, and folders and files with no download link none', () => {
    renderList([file('a'), file('b', { downloadUrl: null }), FOLDER]);

    expect(screen.getByRole('checkbox', { name: /select a\.pdf/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /select b\.pdf/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /select subfolder/i })).toBeNull();
  });

  it('shows which files are selected', () => {
    renderList([file('a'), file('b')], { checkedIds: new Set(['b']) });

    expect(screen.getByRole('checkbox', { name: /select a\.pdf/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /select b\.pdf/i })).toBeChecked();
  });

  it('ticking a file toggles it without also opening its details', async () => {
    const { onToggleChecked, onSelectFile } = renderList([file('a')]);

    await userEvent.click(screen.getByRole('checkbox', { name: /select a\.pdf/i }));

    expect(onToggleChecked).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  describe('select all', () => {
    it('selects every file that can be added in the folder', async () => {
      const { onSetChecked } = renderList([file('a'), file('b'), file('c', { downloadUrl: null }), FOLDER]);

      await userEvent.click(screen.getByRole('checkbox', { name: /select all files/i }));

      expect(onSetChecked).toHaveBeenCalledWith(['a', 'b'], true);
    });

    it('clears them when they are all selected already', async () => {
      const { onSetChecked } = renderList([file('a'), file('b')], { checkedIds: new Set(['a', 'b']) });

      const all = screen.getByRole('checkbox', { name: /select all files/i });
      expect(all).toBeChecked();
      await userEvent.click(all);

      expect(onSetChecked).toHaveBeenCalledWith(['a', 'b'], false);
    });

    it('reads as partly selected when only some are', () => {
      renderList([file('a'), file('b')], { checkedIds: new Set(['a']) });

      expect(screen.getByRole('checkbox', { name: /select all files/i })).toHaveAttribute('aria-checked', 'mixed');
    });

    it('covers only the files the search leaves showing', async () => {
      const { onSetChecked } = renderList([file('apple'), file('banana')]);
      await userEvent.type(screen.getByPlaceholderText(/search this folder/i), 'app');

      await userEvent.click(screen.getByRole('checkbox', { name: /select all files/i }));

      expect(onSetChecked).toHaveBeenCalledWith(['apple'], true);
    });

    it('is not offered when no file can be added', () => {
      renderList([FOLDER, file('b', { downloadUrl: null })]);

      expect(screen.queryByRole('checkbox', { name: /select all files/i })).toBeNull();
    });
  });

  describe('the selection bar', () => {
    it('is hidden until something is selected', () => {
      renderList([file('a')]);

      expect(screen.queryByText(/selected/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /^add \d+ to knowledge base/i })).toBeNull();
    });

    it('counts the selection and adds it', async () => {
      const { onAddChecked } = renderList([file('a'), file('b'), file('c')], { checkedIds: new Set(['a', 'c']) });

      expect(screen.getByText('2 selected')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /^add 2 to knowledge base/i }));

      expect(onAddChecked).toHaveBeenCalled();
    });

    it('says "Add 1" for one file', () => {
      renderList([file('a')], { checkedIds: new Set(['a']) });

      expect(screen.getByRole('button', { name: /^add 1 to knowledge base/i })).toBeInTheDocument();
    });

    it('clears the selection', async () => {
      const { onClearChecked } = renderList([file('a')], { checkedIds: new Set(['a']) });

      await userEvent.click(screen.getByRole('button', { name: /^clear selection$/i }));

      expect(onClearChecked).toHaveBeenCalled();
    });

    it('offers to select the files not yet in the knowledge base, with their number', async () => {
      const { onSetChecked } = renderList([file('a'), file('b', { alreadyIngested: true }), file('c')]);

      await userEvent.click(screen.getByRole('button', { name: /select new \(2\)/i }));

      expect(onSetChecked).toHaveBeenCalledWith(['a', 'c'], true);
    });

    it('does not offer it when every file is in already', () => {
      renderList([file('a', { alreadyIngested: true })]);

      expect(screen.queryByRole('button', { name: /select new/i })).toBeNull();
    });

    it('is not shown at all when the page offers no selection', () => {
      renderList([file('a')], { checkedIds: undefined, onToggleChecked: undefined, onSetChecked: undefined });

      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByRole('button', { name: /select new/i })).toBeNull();
    });
  });

  it('keeps the row actions working beside the checkbox', async () => {
    const { onIngest } = renderList([file('a')]);

    await userEvent.click(within(screen.getByText('a.pdf').closest('tr')!).getByRole('button', { name: /add a\.pdf to the knowledge base/i }));

    expect(onIngest).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});
