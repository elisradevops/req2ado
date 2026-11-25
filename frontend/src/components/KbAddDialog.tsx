import { useEffect, useState } from 'react';
import type { KbRetrievalMode } from '../api/kb';
import { formatFileSize } from '../utils/fileSize';
import { LARGE_FILE_WARNING_BYTES, suggestRetrievalMode } from '../utils/kbModeSuggestion';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { KbModeChoice } from './KbModeChoice';

// Asked before ANY file is added to the knowledge base, because the choice changes what every later job costs and sees,
// and a checkbox beside the Add button was easy to miss (and forget exists). Nothing is preselected unless the user has
// already told us (the file's current mode, or the choice they asked to remember for this folder): a silent default is
// exactly what this dialog replaces.

interface KbAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: { name: string; sizeBytes: number };
  // The mode of a file that is already in the knowledge base (this is a re-ingest); null for a new one.
  currentMode: KbRetrievalMode | null;
  // The choice the user asked to remember for this folder; null when none.
  rememberedMode: KbRetrievalMode | null;
  onConfirm: (mode: KbRetrievalMode, rememberForFolder: boolean) => void;
  isSubmitting?: boolean;
}

const MODE_WORD: Record<KbRetrievalMode, string> = { retrieve: 'Search', always_include: 'Reference' };

export function KbAddDialog({ open, onOpenChange, file, currentMode, rememberedMode, onConfirm, isSubmitting = false }: KbAddDialogProps): React.ReactElement {
  const initialMode = currentMode ?? rememberedMode;
  const [mode, setMode] = useState<KbRetrievalMode | null>(initialMode);
  const [remember, setRemember] = useState(false);
  // Each time the dialog opens (or is pointed at another file) it starts from what is known, not from the last time.
  useEffect(() => {
    if (open) {
      setMode(currentMode ?? rememberedMode);
      setRemember(false);
    }
  }, [open, file.name, currentMode, rememberedMode]);

  const suggestion = suggestRetrievalMode(file.name, file.sizeBytes);
  const reingest = currentMode !== null;
  const fromRemembered = currentMode === null && rememberedMode !== null && mode === rememberedMode;
  const largeReference = mode === 'always_include' && file.sizeBytes >= LARGE_FILE_WARNING_BYTES;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidthClassName="max-w-[520px]"
      title={
        <>
          {reingest ? 'Re-ingest' : 'Add'} "<bdi dir="auto" className="[overflow-wrap:anywhere]">{file.name}</bdi>"{reingest ? '' : ' to the knowledge base'}
        </>
      }
      description="Choose how your With AI review jobs should use this document. You can switch it later without adding it again."
      footer={
        <>
          <span className="ml-auto" />
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mode && onConfirm(mode, remember)} disabled={!mode || isSubmitting}>
            {isSubmitting && <Spinner />}
            {reingest ? 'Re-ingest' : 'Add to knowledge base'}
          </Button>
        </>
      }
    >
      <KbModeChoice mode={mode} onChange={setMode} referenceSuggestion={suggestion ? `Suggested: ${suggestion.reason}` : undefined} disabled={isSubmitting} />

      {fromRemembered && <p className="text-xs text-ink-3">Using your earlier choice for this folder ({MODE_WORD[mode as KbRetrievalMode]}). Change it above if this is different.</p>}

      {largeReference && (
        <Alert severity="warning">
          This file is large ({formatFileSize(file.sizeBytes)}). Reference files are sent in full with every job, so a large one makes every job slower and can crowd
          out other context.
        </Alert>
      )}

      {!reingest && (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={remember} onCheckedChange={setRemember} ariaLabel="Remember my choice for this folder" disabled={isSubmitting} />
          Remember my choice for this folder
        </label>
      )}
    </Dialog>
  );
}
