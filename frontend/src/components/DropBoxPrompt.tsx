import { FileTypeFan, FileTypeLegend } from './FileTypeIcon';

// What an empty drop box says (owner decisions, 2026-11-27): the fanned file kinds, what to do, and the file types it takes by group, so a
// person knows at a glance what to drop and how. The whole box is the one control (FileDropzone, MultiFileDropzone): "Choose a file" is drawn
// as a button for the eye but is not a second button inside it. While a file is dragged over, the fan opens and the headline says to release.
export function DropBoxPrompt({
  title,
  dragging,
  choose,
  hint,
  extensions,
}: {
  title: string;
  dragging: boolean;
  choose: string;
  hint: string;
  extensions: string[];
}): React.ReactElement {
  return (
    <>
      <FileTypeFan open={dragging} />
      <span className={dragging ? 'text-title font-semibold text-accent-ink' : 'text-title font-semibold text-ink-1'}>
        {dragging ? 'Release to upload' : title}
      </span>
      <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-ink-3">
        <span>or</span>
        <span aria-hidden="true" className="inline-flex h-8 items-center rounded-sm bg-accent px-3 text-sm font-semibold text-white">
          {choose}
        </span>
        <span>· {hint}</span>
      </span>
      <FileTypeLegend extensions={extensions} />
    </>
  );
}
