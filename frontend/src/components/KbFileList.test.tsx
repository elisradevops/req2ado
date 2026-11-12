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
    onIncludeSubfoldersChange: vi.fn(), onSetFolderChecked: vi.fn(), onCancelScan: vi.fn(),
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

  it('keeps the actions row occupied when every file is already in, so selecting one does not move the list down', () => {
    renderList([{ ...file('a'), alreadyIngested: true }, FOLDER], { includeSubfolders: false });

    expect(screen.queryByRole('button', { name: /select new/i })).toBeNull();
    expect(screen.getByText(/select files to add them, or to change how they are used/i)).toBeInTheDocument();
  });

  it('does not add that hint once files are selected, or when a "Select new" button already fills the row', () => {
    renderList([{ ...file('a'), alreadyIngested: true }, FOLDER], { includeSubfolders: false, checkedIds: new Set(['a']) });
    expect(screen.queryByText(/select files to add them/i)).toBeNull();
  });

  it('on a narrow screen drops the Type and Size columns (the icon shows the type) and keeps a width for the name', () => {
    renderList([file('a')]);

    for (const heading of ['Type', 'Size']) {
      expect(screen.getByRole('columnheader', { name: heading })).toHaveClass('hidden', 'md:table-cell');
    }
    const cells = within(screen.getByText('a.pdf').closest('tr')!).getAllByRole('cell');
    const nameCell = cells.find((cell) => cell.textContent === 'a.pdf')!;
    expect(nameCell.className).toMatch(/min-w-/);
    expect(cells.filter((cell) => /hidden/.test(cell.className) && /md:table-cell/.test(cell.className))).toHaveLength(2);
  });

  describe('subfolders', () => {
    const SECOND_FOLDER: FolderTreeEntry = { ...FOLDER, id: 'd2', name: 'Archive' };

    it('says folders are left out, and how many, while "include subfolders" is off', () => {
      renderList([file('a'), FOLDER, SECOND_FOLDER], { includeSubfolders: false });

      expect(screen.getByText(/only files in this folder are selected\. 2 subfolders are not included/i)).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: /include subfolders/i })).not.toBeChecked();
    });

    it('says "1 subfolder is" for one', () => {
      renderList([file('a'), FOLDER], { includeSubfolders: false });

      expect(screen.getByText(/1 subfolder is not included/i)).toBeInTheDocument();
    });

    it('offers nothing about subfolders when the folder has none', () => {
      renderList([file('a'), file('b')], { includeSubfolders: false });

      expect(screen.queryByRole('switch', { name: /include subfolders/i })).toBeNull();
      expect(screen.queryByText(/not included/i)).toBeNull();
    });

    it('turns the option on and off', async () => {
      const { onIncludeSubfoldersChange } = renderList([file('a'), FOLDER], { includeSubfolders: false });

      await userEvent.click(screen.getByRole('switch', { name: /include subfolders/i }));

      expect(onIncludeSubfoldersChange).toHaveBeenCalledWith(true);
    });

    it('while on, gives each folder a checkbox and replaces the hint', () => {
      renderList([file('a'), FOLDER], { includeSubfolders: true });

      expect(screen.getByRole('checkbox', { name: /select folder subfolder/i })).toBeInTheDocument();
      expect(screen.queryByText(/not included/i)).toBeNull();
    });

    it('while off, folders have no checkbox', () => {
      renderList([file('a'), FOLDER], { includeSubfolders: false });

      expect(screen.queryByRole('checkbox', { name: /select folder/i })).toBeNull();
    });

    it('ticking a folder selects everything below it, without opening it', async () => {
      const { onSetFolderChecked, onNavigateFolder } = renderList([file('a'), FOLDER], { includeSubfolders: true });

      await userEvent.click(screen.getByRole('checkbox', { name: /select folder subfolder/i }));

      expect(onSetFolderChecked).toHaveBeenCalledWith([expect.objectContaining({ id: 'd1' })], true);
      expect(onNavigateFolder).not.toHaveBeenCalled();
    });

    it('shows a folder as selected, and unticking removes what was selected below it', async () => {
      const { onSetFolderChecked } = renderList([FOLDER], { includeSubfolders: true, checkedFolderIds: new Set(['d1']) });

      const box = screen.getByRole('checkbox', { name: /select folder subfolder/i });
      expect(box).toBeChecked();
      await userEvent.click(box);

      expect(onSetFolderChecked).toHaveBeenCalledWith([expect.objectContaining({ id: 'd1' })], false);
    });

    it('"Select all" also covers the visible folders while the option is on', async () => {
      const { onSetChecked, onSetFolderChecked } = renderList([file('a'), FOLDER, SECOND_FOLDER], { includeSubfolders: true });

      await userEvent.click(screen.getByRole('checkbox', { name: /select all files/i }));

      expect(onSetChecked).toHaveBeenCalledWith(['a'], true);
      expect(onSetFolderChecked).toHaveBeenCalledWith([expect.objectContaining({ id: 'd1' }), expect.objectContaining({ id: 'd2' })], true);
    });

    it('"Select all" leaves folders alone while the option is off', async () => {
      const { onSetFolderChecked } = renderList([file('a'), FOLDER], { includeSubfolders: false });

      await userEvent.click(screen.getByRole('checkbox', { name: /select all files/i }));

      expect(onSetFolderChecked).not.toHaveBeenCalled();
    });

    it('"Select new" asks the folders for their new files only', async () => {
      const { onSetChecked, onSetFolderChecked } = renderList([file('a'), file('b', { alreadyIngested: true }), FOLDER], { includeSubfolders: true });

      await userEvent.click(screen.getByRole('button', { name: /^select new$/i }));

      expect(onSetChecked).toHaveBeenCalledWith(['a'], true);
      expect(onSetFolderChecked).toHaveBeenCalledWith([expect.objectContaining({ id: 'd1' })], true, { onlyNew: true });
    });

    it('offers "Select new" for a folder with only subfolders to scan', () => {
      renderList([file('b', { alreadyIngested: true }), FOLDER], { includeSubfolders: true });

      expect(screen.getByRole('button', { name: /select new/i })).toBeInTheDocument();
    });
  });

  describe('while scanning', () => {
    it('says how far the scan is, in words, but announces only that it is scanning, not every count', () => {
      renderList([file('a'), FOLDER], { includeSubfolders: true, scan: { folders: 3, files: 41 } });

      // the counts change many times a second: they are shown, but kept out of the live region
      expect(screen.getByRole('status')).toHaveTextContent(/^scanning subfolders…$/i);
      expect(screen.getByText(/3 folders, 41 files/i)).toHaveAttribute('aria-hidden', 'true');
    });

    it('can be cancelled', async () => {
      const { onCancelScan } = renderList([file('a'), FOLDER], { includeSubfolders: true, scan: { folders: 1, files: 0 } });

      await userEvent.click(screen.getByRole('button', { name: /cancel scan/i }));

      expect(onCancelScan).toHaveBeenCalled();
    });

    it('does not offer to add the selection until the scan is done', () => {
      renderList([file('a'), FOLDER], { includeSubfolders: true, checkedIds: new Set(['a']), scan: { folders: 1, files: 0 } });

      expect(screen.getByRole('button', { name: /^add 1 to knowledge base/i })).toBeDisabled();
    });

    it('has no status region when nothing is being scanned', () => {
      renderList([file('a'), FOLDER], { includeSubfolders: true, scan: null });

      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  it('names the header checkbox for what it selects: folders too, while subfolders are included', () => {
    renderList([file('a'), FOLDER], { includeSubfolders: true });
    expect(screen.getByRole('checkbox', { name: /select all files and folders/i })).toBeInTheDocument();
  });

  it('keeps calling it "Select all files" while subfolders are left out', () => {
    renderList([file('a'), FOLDER], { includeSubfolders: false });
    expect(screen.getByRole('checkbox', { name: /^select all files$/i })).toBeInTheDocument();
  });
});
