import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, Plus, Trash2 } from 'lucide-react';
import { browseSubfolder, ingestFolderItem, type FolderTreeEntry } from '../api/kb';
import { FileTypeIcon } from './FileTypeIcon';
import { Spinner } from '../ui/Spinner';
import { Skeleton } from '../ui/Skeleton';
import { Tooltip } from '../ui/Tooltip';
import { useToast } from './ToastProvider';
import { cn } from '../lib/cn';
import { formatFileSize } from '../utils/fileSize';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

// One row, recursively rendering its own children once expanded --
// children are fetched lazily (only when the user actually expands a
// folder), never eagerly walked, so opening the tree on a folder with many
// nested subfolders doesn't pay to list all of them up front. `path` is
// this node's own relative path (used both to fetch its children's
// cross-reference and to build each child's path in turn).
function FolderTreeNode({
  entry,
  path,
  userId,
  depth,
  onRequestRemove,
  foldersOnly,
  selectedFolderId,
  onSelectFolder,
}: {
  entry: FolderTreeEntry;
  path: string;
  userId: string;
  depth: number;
  // Removal is destructive (deletes stored KB chunks, cannot be undone) --
  // delegated up to KnowledgeBase.tsx's own ConfirmDialog rather than
  // confirming inline here, so there's exactly one remove-confirmation
  // pattern in the app instead of two.
  onRequestRemove: (documentId: string, name: string) => void;
  // Explorer left-pane mode (KnowledgeBase.tsx's three-pane layout) --
  // hides file rows and their ingest/remove affordances entirely, since
  // this pane is pure folder navigation; the selected folder's own files
  // render in the center pane instead.
  foldersOnly?: boolean;
  selectedFolderId?: string | null;
  onSelectFolder?: (entry: FolderTreeEntry, path: string) => void;
}): React.ReactElement {
  const { showToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FolderTreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Own copy of the ingested state -- flipped optimistically the moment
  // this row's own ingest call succeeds, so a reviewer sees the change
  // immediately without re-browsing (which would collapse every expanded
  // folder to re-fetch from scratch).
  const [ingested, setIngested] = useState(entry.alreadyIngested);
  const [ingestedDocId, setIngestedDocId] = useState(entry.ingestedDocumentId);
  const [isIngesting, setIsIngesting] = useState(false);

  async function toggle(): Promise<void> {
    if (!entry.isFolder) return;
    onSelectFolder?.(entry, path);
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children !== null || !entry.driveId) return;
    setLoading(true);
    setError(false);
    try {
      setChildren(await browseSubfolder(entry.driveId, entry.id, userId, path));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleIngest(event: React.MouseEvent): Promise<void> {
    event.stopPropagation();
    if (isIngesting || !entry.downloadUrl) return;
    setIsIngesting(true);
    try {
      const result = await ingestFolderItem(entry.name, entry.id, entry.downloadUrl, path, userId);
      setIngested(true);
      setIngestedDocId(result.ingestedDocumentId);
      showToast(`Added "${entry.name}" to the knowledge base.`, 'success');
    } catch {
      showToast(`Failed to add "${entry.name}" — please try again.`, 'error');
    } finally {
      setIsIngesting(false);
    }
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={entry.isFolder ? 0 : -1}
        onClick={toggle}
        onKeyDown={(e) => {
          if (entry.isFolder && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            void toggle();
          }
        }}
        className={cn(
          // DESIGN.md §3: accent-soft is reserved for "selected," never
          // "hovered" -- was hover:bg-accent-soft, making a merely-hovered
          // row pixel-identical to the actually selected one below. Same
          // fix JobsList.tsx already has (§18 ledger).
          'flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-sm transition-colors duration-instant hover:bg-surface-alt',
          !entry.isFolder && 'cursor-default',
          entry.isFolder && selectedFolderId === entry.id && 'bg-accent-soft font-medium text-accent-ink',
        )}
        style={{ paddingLeft: `${depth * 18 + 4}px` }}
      >
        {entry.isFolder ? (
          expanded ? <ChevronDown className="h-3.5 w-3.5 flex-none text-ink-3" /> : <ChevronRight className="h-3.5 w-3.5 flex-none text-ink-3" />
        ) : (
          <span className="w-3.5 flex-none" />
        )}
        {entry.isFolder ? (
          <Folder className="h-3.5 w-3.5 flex-none text-ink-3" />
        ) : (
          <FileTypeIcon extension={extensionOf(entry.name)} className="h-4 w-4 rounded-sm" />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {!foldersOnly && !entry.isFolder && <span className="flex-none font-mono text-xs text-ink-3">{formatFileSize(entry.sizeBytes)}</span>}
        {!foldersOnly && !entry.isFolder && (
          <span onClick={(e) => e.stopPropagation()} className="flex-none">
            {ingested ? (
              <Tooltip content="Remove from your knowledge base">
                <button
                  type="button"
                  aria-label={`Remove ${entry.name} from the knowledge base`}
                  onClick={() => ingestedDocId && onRequestRemove(ingestedDocId, entry.name)}
                  className="grid h-6 w-6 place-items-center rounded-sm text-ok transition-colors hover:bg-[#FBE9EA] hover:text-danger"
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
                  onClick={handleIngest}
                  className="grid h-6 w-6 place-items-center rounded-sm text-ink-3 transition-colors hover:bg-[#EEF3FC] hover:text-accent disabled:opacity-50"
                >
                  {isIngesting ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
                </button>
              </Tooltip>
            ) : null}
          </span>
        )}
      </div>
      {expanded && (
        <div>
          {loading && (
            // DESIGN.md §7 Row category: loading is a Skeleton row of
            // identical height, not spinner/text prose -- matches this
            // same tree's own row height (py-1 text-sm) at the child
            // indent depth, same treatment JobsList.tsx already uses.
            <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 18 + 4}px` }}>
              <Skeleton className="h-4 w-32" />
            </div>
          )}
          {error && (
            <p className="py-1 text-xs text-danger" style={{ paddingLeft: `${(depth + 1) * 18 + 4}px` }}>
              Failed to load this folder.
            </p>
          )}
          {children?.length === 0 && (
            <p className="py-1 text-xs text-ink-3" style={{ paddingLeft: `${(depth + 1) * 18 + 4}px` }}>
              Empty folder.
            </p>
          )}
          {children
            ?.filter((child) => !foldersOnly || child.isFolder)
            .map((child) => (
              <FolderTreeNode
                key={child.id}
                entry={child}
                path={path ? `${path}/${child.name}` : child.name}
                userId={userId}
                depth={depth + 1}
                onRequestRemove={onRequestRemove}
                foldersOnly={foldersOnly}
                selectedFolderId={selectedFolderId}
                onSelectFolder={onSelectFolder}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export function SharePointFolderTree({
  entries,
  userId,
  onRequestRemove,
  foldersOnly,
  selectedFolderId,
  onSelectFolder,
}: {
  entries: FolderTreeEntry[];
  userId: string;
  onRequestRemove: (documentId: string, name: string) => void;
  // Explorer left-pane mode (KnowledgeBase.tsx's three-pane layout) -- see
  // FolderTreeNode's own doc comment on these three.
  foldersOnly?: boolean;
  selectedFolderId?: string | null;
  onSelectFolder?: (entry: FolderTreeEntry, path: string) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col">
      {entries
        .filter((entry) => !foldersOnly || entry.isFolder)
        .map((entry) => (
          <FolderTreeNode
            key={entry.id}
            entry={entry}
            path={entry.name}
            userId={userId}
            depth={0}
            onRequestRemove={onRequestRemove}
            foldersOnly={foldersOnly}
            selectedFolderId={selectedFolderId}
            onSelectFolder={onSelectFolder}
          />
        ))}
    </div>
  );
}
