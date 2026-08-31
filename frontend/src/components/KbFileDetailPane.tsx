import { FileText } from 'lucide-react';
import { extensionOf } from './SharePointFolderTree';
import { FileTypeIcon, fileTypeLabel } from './FileTypeIcon';
import { formatFileSize } from '../utils/fileSize';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Chip } from '../ui/Chip';
import { InfoTip } from '../ui/Tooltip';
import type { FolderTreeEntry } from '../api/kb';

// The right pane of the three-pane Knowledge Base explorer (DESIGN.md
// Track B, phase B10) -- metadata and the ingest/remove action for
// whichever file is currently selected in the center pane. Folders have no
// detail of their own to show here (selecting one navigates the center
// pane instead of setting this), so `entry` is always a file when non-null.
export function KbFileDetailPane({
  entry,
  ingested,
  isIngesting,
  alwaysInclude,
  onToggleAlwaysInclude,
  onIngest,
  onRequestRemove,
}: {
  entry: FolderTreeEntry | null;
  ingested: boolean;
  isIngesting: boolean;
  // Only meaningful before ingest -- a small, static reference doc (e.g. a
  // CMMI/requirements-writing-standards file) can be tagged "always
  // include" so its full text grounds every SURVEY prompt unconditionally
  // instead of being similarity-gated like a regular customer-content
  // upload (Open WebUI's own Knowledge feature offers exactly this same
  // choice -- Focused Retrieval vs Full Context -- per file).
  alwaysInclude: boolean;
  onToggleAlwaysInclude: (value: boolean) => void;
  onIngest: () => void;
  onRequestRemove: () => void;
}): React.ReactElement {
  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState icon={FileText} title="No file selected" description="Select a file from the list to see its details." />
      </div>
    );
  }

  const extension = extensionOf(entry.name);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-2.5">
        <FileTypeIcon extension={extension} className="h-9 w-9 flex-none" />
        <p className="min-w-0 break-words text-sm font-semibold text-ink-1">{entry.name}</p>
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-3">Type</dt>
          <dd className="font-mono text-xs text-ink-2">{fileTypeLabel(extension)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-3">Size</dt>
          <dd className="font-mono text-xs tabular-nums text-ink-2">{formatFileSize(entry.sizeBytes)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-3">Knowledge base</dt>
          <dd>
            <Chip
              bg={ingested ? 'var(--color-ok-soft)' : 'var(--color-surface-alt)'}
              color={ingested ? 'var(--color-ok-ink)' : 'var(--color-ink-3)'}
              className="text-xs font-normal"
            >
              {ingested ? 'In knowledge base' : 'Not ingested'}
            </Chip>
          </dd>
        </div>
      </dl>
      {ingested ? (
        <Button variant="danger" size="sm" onClick={onRequestRemove}>
          Remove from knowledge base
        </Button>
      ) : entry.downloadUrl ? (
        <>
          <label className="flex items-center gap-1.5 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={alwaysInclude}
              onChange={(e) => onToggleAlwaysInclude(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Always include (Full Context)
            <InfoTip content="Injects this file's full text into every SURVEY prompt unconditionally, no similarity gate -- for small, static reference material (e.g. a CMMI/requirements-writing-standards doc) whose relevance is definitional, not topical. Leave unchecked for a regular customer-content document, which is instead retrieved only when similar enough to what's being processed." />
          </label>
          <Button size="sm" loading={isIngesting} onClick={onIngest}>
            Add to knowledge base
          </Button>
        </>
      ) : null}
    </div>
  );
}
