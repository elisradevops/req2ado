import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { cn } from '../lib/cn';
import { FileTypeIcon } from './FileTypeIcon';

const ACCEPTED_EXTENSIONS = '.txt,.md,.docx,.pdf,.xlsx';
const SUPPORTED_TYPES = ['docx', 'pdf', 'xlsx', 'txt', 'md'];

export function FileDropzone({ onFileSelected }: { onFileSelected: (file: File) => void }): React.ReactElement {
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
        'flex cursor-pointer flex-col items-center gap-1.5 rounded-md border-[1.5px] border-dashed bg-surface p-8 text-center transition-colors',
        isDragging ? 'border-navy-600 bg-[#F2F7FE]' : 'border-hairline-strong hover:border-navy-300 hover:bg-[#FAFCFF]',
      )}
    >
      <Upload className="h-6 w-6 text-ink-3" />
      <span className="text-sm font-semibold">Drop a requirements document here</span>
      <span className="text-xs text-ink-3">or click to browse — up to 40 MB</span>
      <span className="mt-1 flex items-center gap-2.5">
        {SUPPORTED_TYPES.map((extension) => (
          <FileTypeIcon key={extension} extension={extension} className="h-7 w-7" />
        ))}
      </span>
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
