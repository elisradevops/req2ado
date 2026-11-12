import { useEffect, useMemo, useState } from 'react';
import type { KbRetrievalMode } from '../api/kb';
import { formatFileSize } from '../utils/fileSize';
import { KB_BATCH_LONG_RUN_FILES, KB_BATCH_MANY_REFERENCE_FILES, KB_BATCH_MAX_FILES, KB_MAX_FILE_BYTES } from '../utils/kbBatchLimits';
import { LARGE_FILE_WARNING_BYTES, suggestRetrievalMode } from '../utils/kbModeSuggestion';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { Switch } from '../ui/Switch';
import { KbModeChoice } from './KbModeChoice';

// The dialog for adding SEVERAL files at once, asked before anything is sent, like KbAddDialog is for one. One choice applies
// to all of them (so a folder of guides is one decision), and any single file can be flipped. Files over the size limit are
// left out up front and named, rather than queued to fail. Nothing is preselected unless the user has already told us.

export interface BatchFile {
  id: string;
  name: string;
  sizeBytes: number;
  // The mode of a file that is already in the knowledge base; null for a new one.
  currentMode: KbRetrievalMode | null;
  // The folder it is in, below the folder the user was looking at ('' or absent = that folder itself). Files are listed by it.
  folder?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: BatchFile[];
  // The choice the user asked to remember for this folder; null when none.
  rememberedMode: KbRetrievalMode | null;
  onConfirm: (choices: { id: string; mode: KbRetrievalMode }[], rememberForFolder: boolean) => void;
  isSubmitting?: boolean;
  // What a scan of the subfolders could not cover, in words; nothing when it was complete.
  scanNotices?: string[];
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const MODE_WORD: Record<KbRetrievalMode, string> = { retrieve: 'Search', always_include: 'Reference' };

function startingMode(files: BatchFile[], remembered: KbRetrievalMode | null): KbRetrievalMode | null {
  const shared = new Set(files.map((f) => f.currentMode));
  // Files already in the knowledge base that all share one mode start from it; otherwise from what was remembered.
  if (shared.size === 1 && !shared.has(null)) return [...shared][0] as KbRetrievalMode;
  return remembered;
}

export function KbAddBatchDialog({ open, onOpenChange, files, rememberedMode, onConfirm, isSubmitting = false, scanNotices = [] }: Props): React.ReactElement {
  const tooLarge = useMemo(() => files.filter((f) => f.sizeBytes > KB_MAX_FILE_BYTES), [files]);
  const eligible = useMemo(() => files.filter((f) => f.sizeBytes <= KB_MAX_FILE_BYTES), [files]);

  const [mode, setMode] = useState<KbRetrievalMode | null>(() => startingMode(eligible, rememberedMode));
  // Files the user flipped one by one; changing the choice for all starts them over from it.
  const [overrides, setOverrides] = useState<Record<string, KbRetrievalMode>>({});
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    if (open) {
      setMode(startingMode(eligible, rememberedMode));
      setOverrides({});
      setRemember(false);
    }
  }, [open, eligible, rememberedMode]);

  const modeOf = (file: BatchFile): KbRetrievalMode | null => overrides[file.id] ?? mode;
  const suggested = eligible.filter((f) => suggestRetrievalMode(f.name, f.sizeBytes));
  const referenceFiles = eligible.filter((f) => modeOf(f) === 'always_include');
  const largeReference = referenceFiles.filter((f) => f.sizeBytes >= LARGE_FILE_WARNING_BYTES);
  const fromRemembered = rememberedMode !== null && mode === rememberedMode && startingMode(eligible, null) === null;
  const tooMany = eligible.length > KB_BATCH_MAX_FILES;
  // Files from subfolders are listed under their folder (the same name can be in two of them); a flat list stays flat.
  const grouped = eligible.some((f) => (f.folder ?? '') !== '');
  const groups = useMemo(() => {
    const byFolder = new Map<string, BatchFile[]>();
    for (const file of eligible) byFolder.set(file.folder ?? '', [...(byFolder.get(file.folder ?? '') ?? []), file]);
    return [...byFolder.entries()].map(([folder, members]) => ({ folder, members }));
  }, [eligible]);
  const canConfirm = mode !== null && eligible.length > 0 && !tooMany && !isSubmitting;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidthClassName="max-w-[560px]"
      maxHeightClassName="max-h-[calc(100dvh-2rem)]"
      title={`Add ${eligible.length} ${plural(eligible.length, 'file', 'files')} to the knowledge base`}
      description="Choose how your survey jobs should use these documents. They are added in the background, one after another, so you can leave this page."
      footer={
        <>
          <span className="ml-auto" />
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mode && onConfirm(eligible.map((f) => ({ id: f.id, mode: modeOf(f) ?? mode })), remember)} disabled={!canConfirm}>
            {isSubmitting && <Spinner />}
            Add {eligible.length} to knowledge base
          </Button>
        </>
      }
    >
      {eligible.length === 0 && <Alert severity="warning">Nothing to add: every selected file is over {KB_MAX_FILE_BYTES / (1024 * 1024)} MB.</Alert>}
      {tooLarge.length > 0 && eligible.length > 0 && (
        <Alert severity="warning">
          {tooLarge.length} {plural(tooLarge.length, 'file is', 'files are')} over {KB_MAX_FILE_BYTES / (1024 * 1024)} MB and will be skipped:{' '}
          {tooLarge.map((f) => f.name).join(', ')}
        </Alert>
      )}
      {scanNotices.length > 0 && (
        <Alert severity="warning">
          <p>Not every file was found:</p>
          <ul className="list-disc pl-4">
            {scanNotices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </Alert>
      )}
      {tooMany && <Alert severity="error">A batch holds at most {KB_BATCH_MAX_FILES} files. Select fewer files, or open a subfolder, and try again.</Alert>}

      {eligible.length > 0 && (
        <>
          <KbModeChoice
            mode={mode}
            onChange={(next) => {
              setMode(next);
              setOverrides({});
            }}
            referenceSuggestion={suggested.length > 0 ? `Suggested for ${suggested.length} of these files: the name looks like a guide or standard` : undefined}
            disabled={isSubmitting}
          />
          {fromRemembered && <p className="text-xs text-ink-3">Using your earlier choice for this folder ({MODE_WORD[mode as KbRetrievalMode]}). Change it above if this is different.</p>}

          {referenceFiles.length > KB_BATCH_MANY_REFERENCE_FILES && (
            <Alert severity="warning">
              You are adding {referenceFiles.length} files as Reference. Reference files are sent in full with every job, so this makes every job slower and can crowd out
              other context.
            </Alert>
          )}
          {largeReference.length > 0 && (
            <Alert severity="warning">
              Large Reference {plural(largeReference.length, 'file', 'files')}: {largeReference.map((f) => `${f.name} (${formatFileSize(f.sizeBytes)})`).join(', ')}. Sent in full with every job, a
              large file slows every job.
            </Alert>
          )}
          {eligible.length > KB_BATCH_LONG_RUN_FILES && (
            <p className="text-sm text-ink-2">Adding {eligible.length} files can take a while. They run in the background, so you can leave this page.</p>
          )}

          <ul aria-label="Files to add" className="flex max-h-56 flex-col divide-y divide-hairline overflow-y-auto rounded-sm border border-hairline">
            {groups.map(({ folder, members }) => {
              const rows = members.map((file) => {
                const hint = suggestRetrievalMode(file.name, file.sizeBytes);
                return (
                  <li key={file.id} className="flex items-center gap-3 px-2.5 py-1.5 text-sm">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="min-w-0 text-ink-1 [overflow-wrap:anywhere]">
                        <bdi dir="auto">{file.name}</bdi>
                      </span>
                      <span className="text-xs text-ink-3">
                        {formatFileSize(file.sizeBytes)}
                        {file.currentMode && ` · In the knowledge base: ${MODE_WORD[file.currentMode]}`}
                        {hint && ' · Suggested: Reference'}
                      </span>
                    </div>
                    <label className="flex flex-none items-center gap-2 text-xs text-ink-2">
                      Reference
                      <Switch
                        checked={modeOf(file) === 'always_include'}
                        onCheckedChange={(checked) => setOverrides((prev) => ({ ...prev, [file.id]: checked ? 'always_include' : 'retrieve' }))}
                        ariaLabel={`Reference: ${file.name}`}
                        disabled={isSubmitting || mode === null}
                      />
                    </label>
                  </li>
                );
              });
              if (!grouped) return rows;
              const label = folder === '' ? 'This folder' : folder;
              return (
                <li key={`group:${folder}`} role="presentation" className="list-none">
                  <ul role="group" aria-label={label} className="divide-y divide-hairline">
                    <li role="presentation" className="bg-surface-alt px-2.5 py-1 text-xs font-medium text-ink-3">
                      <bdi dir="auto">{label}</bdi>
                    </li>
                    {rows}
                  </ul>
                </li>
              );
            })}
          </ul>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={remember} onCheckedChange={setRemember} ariaLabel="Remember my choice for this folder" disabled={isSubmitting} />
            Remember my choice for this folder
          </label>
        </>
      )}
    </Dialog>
  );
}
