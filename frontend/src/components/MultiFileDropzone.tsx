import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { FileTypeIcon } from './FileTypeIcon';
import { Button } from '../ui/Button';
import { formatFileSize } from '../utils/fileSize';

// Same accepted-format set as FileDropzone.tsx's single-file wizard --
// kept as a separate literal (not imported) since the two components are
// otherwise fully independent and there is no shared constants module for
// this today.
const ACCEPTED_EXTENSIONS = '.txt,.md,.docx,.pdf,.xlsx';
const SUPPORTED_TYPES = ['docx', 'pdf', 'xlsx', 'txt', 'md'];

function extensionOf(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
}

function isSupported(filename: string): boolean {
  return ACCEPTED_EXTENSIONS.split(',').includes(extensionOf(filename));
}

// One level of a dropped directory, no recursion -- lets "drag the
// Customer Requirements folder onto this" work for the common flat-folder
// case without a server-side folder connector. `webkitGetAsEntry` is
// widely supported (Chrome/Edge/Firefox/Safari) but not standardized --
// absence (or a browser that doesn't implement it) just means dropped
// files are read the plain way below, same as before this existed.
async function readDroppedEntries(items: DataTransferItemList): Promise<File[]> {
  const files: File[] = [];
  const entries = Array.from(items)
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) {
    // No entries API available -- fall back to the plain file list.
    return files;
  }

  await Promise.all(
    entries.map(
      (entry) =>
        new Promise<void>((resolve) => {
          if (entry.isFile) {
            (entry as FileSystemFileEntry).file(
              (file) => {
                files.push(file);
                resolve();
              },
              () => resolve(),
            );
          } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            reader.readEntries((children) => {
              const fileChildren = children.filter((child): child is FileSystemFileEntry => child.isFile);
              Promise.all(
                fileChildren.map(
                  (child) =>
                    new Promise<void>((resolveChild) => {
                      child.file(
                        (file) => {
                          files.push(file);
                          resolveChild();
                        },
                        () => resolveChild(),
                      );
                    }),
                ),
              ).then(() => resolve());
            }, () => resolve());
          } else {
            resolve();
          }
        }),
    ),
  );
  return files;
}

export function MultiFileDropzone({
  files,
  onFilesAdded,
  onFileRemoved,
  disabled,
}: {
  files: File[];
  onFilesAdded: (files: File[]) => void;
  onFileRemoved: (index: number) => void;
  disabled?: boolean;
}): React.ReactElement {
  const [isDragging, setIsDragging] = useState(false);
  const [skippedCount, setSkippedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  function acceptFiles(candidates: File[]): void {
    const supported = candidates.filter((f) => isSupported(f.name));
    setSkippedCount(candidates.length - supported.length);
    if (supported.length > 0) onFilesAdded(supported);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Choose requirements documents"
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={async (event) => {
          event.preventDefault();
          setIsDragging(false);
          if (disabled) return;
          const fromEntries = await readDroppedEntries(event.dataTransfer.items);
          acceptFiles(fromEntries.length > 0 ? fromEntries : Array.from(event.dataTransfer.files));
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-1.5 rounded-md border-[1.5px] border-dashed bg-surface p-8 text-center transition-colors duration-fast ease-out',
          isDragging && 'border-accent bg-accent-soft',
          !isDragging && !disabled && 'liftable border-hairline-strong hover:border-accent-soft-border',
          disabled && 'cursor-not-allowed border-hairline-strong opacity-60',
        )}
      >
        <Upload className="h-6 w-6 text-ink-3" />
        <span className="text-sm font-semibold">Drop requirements documents here</span>
        <span className="text-xs text-ink-3">or click to browse — select multiple files, or drag a folder</span>
        <span className="mt-1 flex items-center gap-2.5">
          {SUPPORTED_TYPES.map((extension) => (
            <FileTypeIcon key={extension} extension={extension} className="h-7 w-7" />
          ))}
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          aria-label="Upload requirements documents"
          accept={ACCEPTED_EXTENSIONS}
          disabled={disabled}
          onChange={(event) => {
            acceptFiles(Array.from(event.target.files ?? []));
            // Allows re-selecting the same file again after removing it --
            // browsers don't fire `change` for an identical file list otherwise.
            event.target.value = '';
          }}
        />
      </div>
      {skippedCount > 0 && (
        <p className="text-xs text-warning-ink">
          {skippedCount} file{skippedCount === 1 ? '' : 's'} skipped (unsupported type)
        </p>
      )}
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-2 rounded-sm border border-hairline bg-surface px-2.5 py-1.5">
              <FileTypeIcon extension={extensionOf(file.name).replace('.', '')} className="h-5 w-5 flex-none" />
              <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
              <span className="flex-none font-mono text-meta text-ink-3">{formatFileSize(file.size)}</span>
              <Button size="sm" variant="ghost" aria-label={`Remove ${file.name}`} onClick={() => onFileRemoved(index)} disabled={disabled}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
