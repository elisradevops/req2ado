import { useState } from 'react';
import { Folder, ChevronRight, Plus, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Switch } from '../ui/Switch';
import { extensionOf } from '../utils/extension';
import type { FolderTreeEntry } from '../api/kb';
import { formatFileSize } from '../utils/fileSize';
import { FileTypeIcon, fileTypeLabel } from './FileTypeIcon';
import { Spinner } from '../ui/Spinner';
import { Skeleton } from '../ui/Skeleton';
import { Tooltip } from '../ui/Tooltip';
import { TextField } from '../ui/TextField';
import { KbIngestStatusChip, hasNoVectors } from './KbIngestStatusChip';
import { TableHeaderCell } from '../ui/TableHeaderCell';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../lib/cn';

// The center pane of the three-pane Knowledge Base explorer (DESIGN.md
// Track B, phase B10) -- a FLAT, non-recursive listing of the currently
// selected folder's own direct children (both files and subfolders,
// Explorer-style). Deliberately NOT SharePointFolderTree reused here: that
// component's whole job is recursive expand-in-place, which is the LEFT
// pane's job now (rendered foldersOnly); this pane only ever shows one
// folder's contents at a time, driven by KnowledgeBase.tsx's own
// navigation state.
//
// Column note: the reference explorer mockup shows Name/Modified/Size --
// the SharePoint browse API (FolderTreeEntry) exposes no modified
// timestamp at all, so that column is replaced with Type + Status rather
// than fabricating a date.
export function KbFileList({
  entries,
  loading,
  breadcrumb,
  onNavigateRoot,
  onNavigateFolder,
  selectedFileId,
  onSelectFile,
  isIngested,
  chunkCountOf,
  ingestingId,
  onIngest,
  onRequestRemove,
  checkedIds,
  onToggleChecked,
  onSetChecked,
  onAddChecked,
  onClearChecked,
  includeSubfolders,
  onIncludeSubfoldersChange,
  checkedFolderIds,
  onSetFolderChecked,
  scan,
  onCancelScan,
}: {
  entries: FolderTreeEntry[] | null;
  loading: boolean;
  breadcrumb: string[];
  onNavigateRoot: () => void;
  onNavigateFolder: (entry: FolderTreeEntry) => void;
  selectedFileId: string | null;
  onSelectFile: (entry: FolderTreeEntry) => void;
  isIngested: (entry: FolderTreeEntry) => boolean;
  chunkCountOf: (entry: FolderTreeEntry) => number | null;
  ingestingId: string | null;
  onIngest: (entry: FolderTreeEntry) => void;
  onRequestRemove: (entry: FolderTreeEntry) => void;
  // Selecting several files to add at once. All optional together: without them the list has no checkboxes and no selection bar.
  checkedIds?: Set<string>;
  onToggleChecked?: (entry: FolderTreeEntry) => void;
  onSetChecked?: (ids: string[], checked: boolean) => void;
  onAddChecked?: () => void;
  onClearChecked?: () => void;
  // "Include subfolders": the selection reaches into the folders below this one. Absent = the list offers no such option.
  includeSubfolders?: boolean;
  onIncludeSubfoldersChange?: (include: boolean) => void;
  // The folders whose contents are selected, and the way to select or unselect everything below some folders (`onlyNew`: only
  // the files not yet in the knowledge base).
  checkedFolderIds?: Set<string>;
  onSetFolderChecked?: (folders: FolderTreeEntry[], checked: boolean, options?: { onlyNew: boolean }) => void;
  // Set while the folders below are being read: how far it is.
  scan?: { folders: number; files: number } | null;
  onCancelScan?: () => void;
}): React.ReactElement {
  const [search, setSearch] = useState('');

  const query = search.trim().toLowerCase();
  const visible = (entries ?? []).filter((entry) => !query || entry.name.toLowerCase().includes(query));

  // A file can be added when it has a download link; a folder never. The selection covers what the search leaves showing.
  const selectable = checkedIds !== undefined && onToggleChecked !== undefined && onSetChecked !== undefined;
  const eligible = visible.filter((entry) => !entry.isFolder && entry.downloadUrl);
  const eligibleIds = eligible.map((entry) => entry.id);
  const checkedCount = eligibleIds.filter((id) => checkedIds?.has(id)).length;
  const allChecked = eligibleIds.length > 0 && checkedCount === eligibleIds.length;
  const newIds = eligible.filter((entry) => !isIngested(entry)).map((entry) => entry.id);
  const totalChecked = checkedIds?.size ?? 0;
  const visibleFolders = visible.filter((entry) => entry.isFolder);
  const offersSubfolders = onIncludeSubfoldersChange !== undefined && visibleFolders.length > 0;
  const reachIntoFolders = selectable && !!includeSubfolders && onSetFolderChecked !== undefined && visibleFolders.length > 0;
  const scanning = !!scan;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-3">
        <nav aria-label="Folder" className="flex min-w-0 flex-1 items-center gap-1 truncate text-sm">
          <button type="button" onClick={onNavigateRoot} className="cursor-pointer font-medium text-ink-3 transition-colors duration-instant hover:text-ink-1">
            Root
          </button>
          {breadcrumb.map((segment, index) => (
            <span key={`${segment}-${index}`} className="flex items-center gap-1">
              <span className="text-ink-3" aria-hidden="true">
                /
              </span>
              <span className={cn('truncate', index === breadcrumb.length - 1 ? 'font-semibold text-ink-1' : 'text-ink-3')}>{segment}</span>
            </span>
          ))}
        </nav>
        <TextField
          placeholder="Search this folder…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-[200px]"
        />
      </div>
      {selectable && (totalChecked > 0 || newIds.length > 0 || offersSubfolders || eligible.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface-alt px-3 py-2">
          {totalChecked > 0 ? (
            <>
              <span className="text-sm font-medium text-ink-2">{totalChecked} selected</span>
              <Button size="sm" onClick={onAddChecked} disabled={scanning}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add {totalChecked} to knowledge base…
              </Button>
              <Button size="sm" variant="ghost" onClick={onClearChecked}>
                Clear selection
              </Button>
            </>
          ) : (
            newIds.length > 0 || reachIntoFolders ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onSetChecked(newIds, true);
                  if (reachIntoFolders) onSetFolderChecked(visibleFolders, true, { onlyNew: true });
                }}
                disabled={scanning}
              >
                {reachIntoFolders ? 'Select new' : `Select new (${newIds.length})`}
              </Button>
            ) : eligible.length > 0 ? (
              // Keeps this row filled, so choosing a file does not push the list down by a row.
              <span className="inline-flex min-h-6 items-center text-sm text-ink-3">Select files to add them, or to change how they are used.</span>
            ) : null
          )}
          {/* On its own row, so the bar is as tall with files selected (the actions are wider) as without. */}
          {offersSubfolders && (
            <div className="flex w-full items-center justify-end gap-2 text-sm text-ink-2">
              {!includeSubfolders && (
                <span>
                  Only files in this folder are selected. {visibleFolders.length} {visibleFolders.length === 1 ? 'subfolder is' : 'subfolders are'} not included.
                </span>
              )}
              <label className="flex cursor-pointer items-center gap-2">
                <Switch checked={!!includeSubfolders} onCheckedChange={onIncludeSubfoldersChange} ariaLabel="Include subfolders" disabled={scanning} />
                Include subfolders
              </label>
            </div>
          )}
          {scan && (
            <div className="flex w-full items-center gap-2 text-sm text-ink-2">
              {/* Only the fact that it is scanning is announced: the counts change many times a second. */}
              <span className="flex items-center gap-2">
                <Spinner />
                <span role="status">Scanning subfolders…</span>
                <span aria-hidden="true">
                  {scan.folders} {scan.folders === 1 ? 'folder' : 'folders'}, {scan.files} {scan.files === 1 ? 'file' : 'files'}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={onCancelScan}>
                Cancel scan
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          // DESIGN.md §7 Row category: loading is a Skeleton row of
          // identical height, not spinner/text prose -- matches
          // JobsList.tsx's own already-correct treatment for the same
          // "list is fetching" event.
          <div className="flex flex-col gap-2 p-3.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Folder}
              title={query ? 'No matches in this folder' : 'This folder is empty'}
              description={query ? 'Try a different search term.' : undefined}
            />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                {selectable && (
                  <TableHeaderCell sticky className="w-9 pr-0">
                    {(eligibleIds.length > 0 || reachIntoFolders) && (
                      <Checkbox
                        checked={allChecked ? true : checkedCount > 0 ? 'indeterminate' : false}
                        onCheckedChange={(value) => {
                          onSetChecked(eligibleIds, value);
                          if (reachIntoFolders) onSetFolderChecked(visibleFolders, value);
                        }}
                        ariaLabel={reachIntoFolders ? 'Select all files and folders' : 'Select all files'}
                      />
                    )}
                  </TableHeaderCell>
                )}
                <TableHeaderCell sticky>Name</TableHeaderCell>
                {/* Type and Size give way on a narrow screen, so the name keeps room (the icon already shows the type). */}
                <TableHeaderCell sticky className="hidden md:table-cell">Type</TableHeaderCell>
                <TableHeaderCell sticky className="hidden md:table-cell">Size</TableHeaderCell>
                <TableHeaderCell sticky>Status</TableHeaderCell>
                <TableHeaderCell sticky align="right">
                  <span className="sr-only">Actions</span>
                </TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const ingested = isIngested(entry);
                const isIngesting = ingestingId === entry.id;
                const selected = !entry.isFolder && selectedFileId === entry.id;
                return (
                  <tr
                    key={entry.id}
                    onClick={() => (entry.isFolder ? onNavigateFolder(entry) : onSelectFile(entry))}
                    className={cn(
                      // DESIGN.md §3: accent-soft is reserved for "selected,"
                      // never "hovered" -- was hover:bg-accent-soft, making a
                      // merely-hovered row pixel-identical to the actually
                      // selected one below. Same fix JobsList.tsx already
                      // has (§18 ledger).
                      'cursor-pointer border-t border-hairline transition-colors duration-instant hover:bg-surface-alt',
                      selected && 'bg-accent-soft',
                    )}
                  >
                    {selectable && (
                      <td className="w-9 py-2 pl-3.5 pr-0" onClick={(e) => e.stopPropagation()}>
                        {!entry.isFolder && entry.downloadUrl && (
                          <Checkbox checked={checkedIds.has(entry.id)} onCheckedChange={() => onToggleChecked(entry)} ariaLabel={`Select ${entry.name}`} />
                        )}
                        {entry.isFolder && reachIntoFolders && (
                          <Checkbox
                            checked={!!checkedFolderIds?.has(entry.id)}
                            onCheckedChange={(value) => onSetFolderChecked([entry], value)}
                            ariaLabel={`Select folder ${entry.name}`}
                            disabled={scanning}
                          />
                        )}
                      </td>
                    )}
                    <td className="w-full min-w-32 max-w-0 px-3.5 py-2">
                      <span className="flex items-center gap-1.5">
                        {entry.isFolder ? (
                          <Folder className="h-3.5 w-3.5 flex-none text-ink-3" />
                        ) : (
                          <FileTypeIcon extension={extensionOf(entry.name)} className="h-4 w-4 rounded-sm" />
                        )}
                        <span className="min-w-0 truncate">{entry.name}</span>
                        {entry.isFolder && <ChevronRight className="h-3.5 w-3.5 flex-none text-ink-3" />}
                      </span>
                    </td>
                    <td className="hidden px-3.5 py-2 text-ink-3 md:table-cell">{entry.isFolder ? 'Folder' : fileTypeLabel(extensionOf(entry.name))}</td>
                    <td className="hidden px-3.5 py-2 font-mono text-xs tabular-nums text-ink-3 md:table-cell">{entry.isFolder ? '—' : formatFileSize(entry.sizeBytes)}</td>
                    <td className="px-3.5 py-2">
                      {!entry.isFolder && (
                        <KbIngestStatusChip ingested={ingested} chunkCount={chunkCountOf(entry)} />
                      )}
                    </td>
                    <td className="px-3.5 py-2 text-right">
                      {!entry.isFolder && (
                        <span onClick={(e) => e.stopPropagation()} className="inline-flex gap-1">
                          {hasNoVectors(ingested, chunkCountOf(entry)) && entry.downloadUrl && (
                            <Tooltip content="No vectors are stored for this file -- re-ingest it so grounding can use it">
                              <button
                                type="button"
                                aria-label={`Re-ingest ${entry.name}`}
                                disabled={isIngesting}
                                onClick={() => onIngest(entry)}
                                className="grid h-6 w-6 cursor-pointer place-items-center rounded-sm text-warning transition-colors duration-instant hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {isIngesting ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
                              </button>
                            </Tooltip>
                          )}
                          {ingested ? (
                            <Tooltip content="Remove from your knowledge base">
                              <button
                                type="button"
                                aria-label={`Remove ${entry.name} from the knowledge base`}
                                onClick={() => onRequestRemove(entry)}
                                className="grid h-6 w-6 cursor-pointer place-items-center rounded-sm text-ink-3 transition-colors duration-instant hover:bg-danger-soft hover:text-danger"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </Tooltip>
                          ) : entry.downloadUrl ? (
                            <Tooltip content="Add this file to your knowledge base">
                              <button
                                type="button"
                                aria-label={`Add ${entry.name} to the knowledge base`}
                                disabled={isIngesting}
                                onClick={() => onIngest(entry)}
                                className="grid h-6 w-6 cursor-pointer place-items-center rounded-sm text-ink-3 transition-colors duration-instant hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {isIngesting ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
                              </button>
                            </Tooltip>
                          ) : null}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
