import { useState } from 'react';
import { Folder, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { formatSize, extensionOf } from './SharePointFolderTree';
import type { FolderTreeEntry } from '../api/kb';
import { FileTypeIcon } from './FileTypeIcon';
import { Spinner } from '../ui/Spinner';
import { Skeleton } from '../ui/Skeleton';
import { Tooltip } from '../ui/Tooltip';
import { TextField } from '../ui/TextField';
import { Chip } from '../ui/Chip';
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
  ingestingId,
  onIngest,
  onRequestRemove,
}: {
  entries: FolderTreeEntry[] | null;
  loading: boolean;
  breadcrumb: string[];
  onNavigateRoot: () => void;
  onNavigateFolder: (entry: FolderTreeEntry) => void;
  selectedFileId: string | null;
  onSelectFile: (entry: FolderTreeEntry) => void;
  isIngested: (entry: FolderTreeEntry) => boolean;
  ingestingId: string | null;
  onIngest: (entry: FolderTreeEntry) => void;
  onRequestRemove: (entry: FolderTreeEntry) => void;
}): React.ReactElement {
  const [search, setSearch] = useState('');

  const query = search.trim().toLowerCase();
  const visible = (entries ?? []).filter((entry) => !query || entry.name.toLowerCase().includes(query));

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
                <th className="sticky top-0 z-10 bg-surface-sunken px-3.5 py-2 text-left text-micro font-semibold uppercase tracking-wide text-ink-3">Name</th>
                <th className="sticky top-0 z-10 bg-surface-sunken px-3.5 py-2 text-left text-micro font-semibold uppercase tracking-wide text-ink-3">Type</th>
                <th className="sticky top-0 z-10 bg-surface-sunken px-3.5 py-2 text-left text-micro font-semibold uppercase tracking-wide text-ink-3">Size</th>
                <th className="sticky top-0 z-10 bg-surface-sunken px-3.5 py-2 text-left text-micro font-semibold uppercase tracking-wide text-ink-3">Status</th>
                <th className="sticky top-0 z-10 bg-surface-sunken px-3.5 py-2 text-right text-micro font-semibold uppercase tracking-wide text-ink-3">
                  <span className="sr-only">Actions</span>
                </th>
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
                    <td className="px-3.5 py-2">
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
                    <td className="px-3.5 py-2 text-ink-3">{entry.isFolder ? 'Folder' : extensionOf(entry.name).toUpperCase()}</td>
                    <td className="px-3.5 py-2 font-mono text-xs tabular-nums text-ink-3">{entry.isFolder ? '—' : formatSize(entry.sizeBytes)}</td>
                    <td className="px-3.5 py-2">
                      {!entry.isFolder && (
                        <Chip
                          bg={ingested ? 'var(--color-ok-soft)' : 'var(--color-surface-alt)'}
                          color={ingested ? 'var(--color-ok-ink)' : 'var(--color-ink-3)'}
                          className="text-xs font-normal"
                        >
                          {ingested ? 'In knowledge base' : 'Not ingested'}
                        </Chip>
                      )}
                    </td>
                    <td className="px-3.5 py-2 text-right">
                      {!entry.isFolder && (
                        <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                          {ingested ? (
                            <Tooltip content="Remove from your knowledge base">
                              <button
                                type="button"
                                aria-label={`Remove ${entry.name} from the knowledge base`}
                                onClick={() => onRequestRemove(entry)}
                                className="grid h-6 w-6 cursor-pointer place-items-center rounded-sm text-ok transition-colors duration-instant hover:bg-danger-soft hover:text-danger"
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
