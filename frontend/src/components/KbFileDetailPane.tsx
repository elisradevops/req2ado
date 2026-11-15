import { FileText } from 'lucide-react';
import { extensionOf } from '../utils/extension';
import { FileTypeIcon, fileTypeLabel } from './FileTypeIcon';
import { formatFileSize } from '../utils/fileSize';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { KbIngestStatusChip } from './KbIngestStatusChip';
import { InfoTip } from '../ui/Tooltip';
import { Switch } from '../ui/Switch';
import type { FolderTreeEntry } from '../api/kb';

// The right pane of the three-pane Knowledge Base explorer (DESIGN.md
// Track B, phase B10) -- metadata and the ingest/remove action for
// whichever file is currently selected in the center pane. Folders have no
// detail of their own to show here (selecting one navigates the center
// pane instead of setting this), so `entry` is always a file when non-null.
export function KbFileDetailPane({
  entry,
  ingested,
  chunkCount,
  isIngesting,
  alwaysInclude,
  isUpdatingMode,
  onToggleAlwaysInclude,
  onIngest,
  onRequestRemove,
}: {
  entry: FolderTreeEntry | null;
  ingested: boolean;
  // Stored chunk count for this file; null = unknown (see KbIngestStatusChip).
  chunkCount: number | null;
  isIngesting: boolean;
  // Whether an INGESTED file is "Reference" (its full text grounds every SURVEY job) rather than "Search" (used only when
  // similar). The choice for a new file is made in the add dialog before it is ingested; this switch changes it afterwards
  // (which retags the stored chunks, no re-ingest).
  alwaysInclude: boolean;
  // True while switching an ingested file's mode is in flight.
  isUpdatingMode: boolean;
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

  const alwaysIncludeControl = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm text-ink-2">
          Reference (always include)
          <InfoTip content="Reference files are sent in full with every survey job: right for short, stable guides such as writing standards, style guides and templates. Search files are used only when a section of your document is similar to them: right for large or customer-specific documents." />
        </span>
        <Switch checked={alwaysInclude} onCheckedChange={onToggleAlwaysInclude} ariaLabel="Reference (always include)" disabled={isUpdatingMode} />
      </div>
      <p className="text-xs text-ink-3">{alwaysInclude ? 'The full text is added to every survey job.' : 'Used only when a section of your document is similar to it.'}</p>
    </div>
  );

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
            <KbIngestStatusChip ingested={ingested} chunkCount={chunkCount} />
          </dd>
        </div>
      </dl>
      {ingested ? (
        <>
          {alwaysIncludeControl}
          {/* Offered for every ingested file, not only one with no vectors: an unchanged file is
              otherwise never read again, so this is how an improved parser reaches it. */}
          {entry.downloadUrl && (
            <Button size="sm" loading={isIngesting} onClick={onIngest}>
              Re-ingest file
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={onRequestRemove}>
            Remove from knowledge base
          </Button>
        </>
      ) : entry.downloadUrl ? (
        <Button size="sm" loading={isIngesting} onClick={onIngest}>
          Add to knowledge base
        </Button>
      ) : null}
    </div>
  );
}
