import { useRef, useState } from 'react';
import { Upload, CircleCheck, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import { FileTypeIcon } from './FileTypeIcon';
import { Spinner } from '../ui/Spinner';

const ACCEPTED_EXTENSIONS = '.txt,.md,.docx,.pdf,.xlsx';
const SUPPORTED_TYPES = ['docx', 'pdf', 'xlsx', 'txt', 'md'];

// Idle/dragging were the only two states this ever had -- the multi-second
// gap between a drop and either a toast (failure) or the parsed stat tiles
// filling in (success) previously had zero visual feedback inside the
// dropzone itself, the exact "I dropped a file and nothing happened" gap
// this fixes. `parsing`/`parsed`/`error` are controlled by the caller
// (NewJobWizard.tsx owns the real previewJob() call and its outcome);
// `isDragging` stays internal since it's pure pointer/drag-event UI state
// with no meaning outside this component.
export type FileDropzoneStatus = 'idle' | 'parsing' | 'parsed' | 'error';

export function FileDropzone({
  onFileSelected,
  status = 'idle',
  fileName,
  errorMessage,
}: {
  onFileSelected: (file: File) => void;
  status?: FileDropzoneStatus;
  // Only meaningful for 'parsing'/'parsed'/'error' -- idle has no file yet.
  fileName?: string | null;
  errorMessage?: string | null;
}): React.ReactElement {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: FileList | null): void {
    const file = files?.[0];
    if (file) onFileSelected(file);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Choose a requirements document"
      aria-busy={status === 'parsing'}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        handleFiles(event.dataTransfer.files);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center gap-1.5 rounded-md border-[1.5px] border-dashed bg-surface p-8 text-center transition-colors duration-fast ease-out',
        isDragging && 'border-accent bg-accent-soft',
        !isDragging && status === 'idle' && 'border-hairline-strong hover:border-accent-soft-border hover:bg-[#FAFCFF]',
        !isDragging && status === 'parsing' && 'cursor-wait border-hairline-strong',
        !isDragging && status === 'parsed' && 'border-ok-border bg-ok-soft/40 hover:border-accent-soft-border',
        !isDragging && status === 'error' && 'border-danger-border bg-danger-soft/40',
      )}
    >
      {status === 'parsing' ? (
        <>
          <Spinner className="h-6 w-6 text-accent" />
          <span className="text-sm font-semibold">Parsing {fileName ?? 'document'}…</span>
          <span className="text-xs text-ink-3">This only reads the document's structure -- no analysis yet.</span>
        </>
      ) : status === 'parsed' ? (
        <>
          <CircleCheck className="h-6 w-6 text-ok" />
          <span className="text-sm font-semibold">{fileName}</span>
          <span className="text-xs text-ink-3">Parsed -- drop another file here to replace it</span>
        </>
      ) : status === 'error' ? (
        <>
          <TriangleAlert className="h-6 w-6 text-danger" />
          <span className="text-sm font-semibold text-danger-ink">{errorMessage ?? 'Failed to parse this document'}</span>
          <span className="text-xs text-ink-3">Drop it again, or try a different file</span>
        </>
      ) : (
        <>
          <Upload className="h-6 w-6 text-ink-3" />
          <span className="text-sm font-semibold">Drop a requirements document here</span>
          <span className="text-xs text-ink-3">or click to browse — up to 40 MB</span>
          <span className="mt-1 flex items-center gap-2.5">
            {SUPPORTED_TYPES.map((extension) => (
              <FileTypeIcon key={extension} extension={extension} className="h-7 w-7" />
            ))}
          </span>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        hidden
        aria-label="Upload requirements document"
        accept={ACCEPTED_EXTENSIONS}
        onChange={(event) => handleFiles(event.target.files)}
      />
    </div>
  );
}
