import { useEffect, useId, useState, type ReactNode } from 'react';
import { RadioGroup } from 'radix-ui';
import { BookMarked, Search, Sparkles, type LucideIcon } from 'lucide-react';
import type { KbRetrievalMode } from '../api/kb';
import { cn } from '../lib/cn';
import { formatFileSize } from '../utils/fileSize';
import { LARGE_FILE_WARNING_BYTES, suggestRetrievalMode } from '../utils/kbModeSuggestion';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';

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

interface ModeCardProps {
  value: KbRetrievalMode;
  Icon: LucideIcon;
  title: ReactNode;
  accessibleTitle: string;
  description: string;
  detail: string;
  suggestion?: string;
}

function ModeCard({ value, Icon, title, accessibleTitle, description, detail, suggestion }: ModeCardProps): React.ReactElement {
  const id = useId();
  return (
    <RadioGroup.Item
      value={value}
      aria-label={accessibleTitle}
      aria-describedby={`${id}-description`}
      className={cn(
        'flex w-full cursor-pointer items-start gap-3 rounded-md border border-hairline-strong bg-surface p-3 text-left transition-colors duration-fast ease-out',
        'hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft',
      )}
    >
      <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-md bg-surface-alt text-ink-2">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span id={`${id}-description`} className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-semibold text-ink-1">{title}</span>
        <span className="text-sm text-ink-2">{description}</span>
        <span className="text-xs text-ink-3">{detail}</span>
        {suggestion && (
          <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-accent-ink">
            <Sparkles className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span>{suggestion}</span>
          </span>
        )}
      </span>
    </RadioGroup.Item>
  );
}

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
      description="Choose how your survey jobs should use this document. You can switch it later without adding it again."
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
      <RadioGroup.Root
        value={mode ?? ''}
        onValueChange={(value) => setMode(value as KbRetrievalMode)}
        aria-label="How jobs use this document"
        disabled={isSubmitting}
        className="flex flex-col gap-2.5"
      >
        <ModeCard
          value="retrieve"
          Icon={Search}
          accessibleTitle="Search"
          title="Search"
          description="Used only when a section of your document is similar to it."
          detail="Best for large documents, customer specifications and anything topic-specific. It costs tokens only when it is relevant."
        />
        <ModeCard
          value="always_include"
          Icon={BookMarked}
          accessibleTitle="Reference (always include)"
          title={
            <>
              Reference <span className="font-normal text-ink-3">(always include)</span>
            </>
          }
          description="The full text is added to every survey job."
          detail="Best for short, stable guides: writing standards, style guides, templates, glossaries. Every job pays for it in tokens, so keep these small."
          suggestion={suggestion ? `Suggested: ${suggestion.reason}` : undefined}
        />
      </RadioGroup.Root>

      {fromRemembered && <p className="text-xs text-ink-3">Using your earlier choice for this folder.</p>}

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
